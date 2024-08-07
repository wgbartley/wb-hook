// Import required modules
const express = require('express')
const fs = require('fs').promises // Use promises for async file operations
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const morgan = require('morgan')
const moment = require('moment')
const bodyParser = require('body-parser') // Import body-parser for handling different content types

// Global constants
const DATA_DIR = path.join(__dirname, 'data')
const PORT = process.env.PORT || 4000

// Ensure data directory exists
async function ensureDataDir() {
	try {
		await fs.access(DATA_DIR)
	} catch (err) {
		await fs.mkdir(DATA_DIR)
	}
}
ensureDataDir()

// Generate a GUID and return it in the required format (lowercase)
function generateGuid() {
	return uuidv4().toLowerCase()
}

// Write incoming request details to a file, under the "requests" key
async function logRequest(guid, requestData) {
	const filePath = path.join(DATA_DIR, `${guid}.json`)

	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		const data = JSON.parse(rawData)

		// Ensure the requests array exists
		if (!Array.isArray(data.requests)) {
			data.requests = []
		}

		requestData.logNumber = data.requests.length + 1
		data.requests.push(requestData)

		await fs.writeFile(filePath, JSON.stringify(data, null, 2))
	} catch (err) {
		if (err.code === 'ENOENT') {
			return { error: 'File not found', status: 404 }
		} else {
			console.error(`Error logging request for GUID ${guid}:`, err)
			return { error: 'Error logging request', status: 500 }
		}
	}

	// Notify SSE listeners
	if (sseClients[guid]) {
		const message = JSON.stringify(requestData)
		sseClients[guid].forEach(res => res.write(`data: ${message}\n\n`))
	}

	return { status: 200 }
}

// Set up the Express app and routes
const app = express()

// Middleware for parsing different content types
app.use(bodyParser.json()) // Handle application/json
app.use(bodyParser.urlencoded({ extended: true })) // Handle application/x-www-form-urlencoded
app.use(bodyParser.raw({ type: 'application/octet-stream' })) // Handle raw binary data
app.use(bodyParser.text({ type: 'text/*' })) // Handle text data

// SSE Clients Map
const sseClients = {}

// Logging middleware
morgan.token('customDate', () => moment().format('YYYY-MM-DD HH:mm:ss'))

// Middlewares
app.use(
	morgan((tokens, req, res) => {
		const status = tokens.status(req, res)
		const color = status >= 500 ? 31 // red
			: status >= 400 ? 33 // yellow
			: status >= 300 ? 36 // cyan
			: status >= 200 ? 32 // green
			: 0 // no color

		const coloredStatus = `\x1b[${color}m${status}\x1b[0m`

		return [
			`[${tokens.customDate(req, res)}]`, // Custom timestamp
			tokens.method(req, res),
			tokens.url(req, res),
			coloredStatus, // Colored status code
			`${tokens['response-time'](req, res)} ms`,
			`- ${tokens.res(req, res, 'content-length') || '0'} bytes`
		].join(' ')
	})
)

// Serve static HTML files
app.use(express.static(path.join(__dirname, 'public')))

// Ignore favicon.ico requests
app.get('/favicon.ico', (req, res) => res.sendStatus(204))

// Serve view.html
app.get('/view', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'view.html'))
})

// Create a new GUID with an optional name
app.post('/create-url', async (req, res) => {
	const guid = generateGuid()
	const name = false // Initialize name as false
	const filePath = path.join(DATA_DIR, `${guid}.json`)

	// Create a file with the name and an empty requests array
	const data = { name, requests: [] }
	await fs.writeFile(filePath, JSON.stringify(data))
	res.json({ guid, name })
})

// Delete data associated with a GUID
app.delete('/delete-url/:guid', async (req, res) => {
	const { guid } = req.params
	const filePath = path.join(DATA_DIR, `${guid}.json`)
	try {
		await fs.unlink(filePath)
		delete sseClients[guid] // Clear SSE clients
		res.sendStatus(200)
	} catch (err) {
		res.sendStatus(404)
	}
})

// Get all GUIDs with their summary data
app.get('/get-urls', async (req, res) => {
	try {
		const files = await fs.readdir(DATA_DIR)
		const urls = await Promise.all(files.map(async file => {
			const filePath = path.join(DATA_DIR, file)
			const stats = await fs.stat(filePath)
			const data = JSON.parse(await fs.readFile(filePath, 'utf8'))
			const requestCount = data.requests ? data.requests.length : 0
			const firstRequestTime = requestCount > 0 ? data.requests[0].timestamp : null
			const lastRequestTime = requestCount > 0 ? data.requests[requestCount - 1].timestamp : null

			return {
				guid: path.basename(file, '.json'),
				name: data.name || 'Untitled',
				created: stats.birthtime,
				modified: stats.mtime,
				requestCount,
				firstRequestTime,
				lastRequestTime
			}
		}))
		res.json(urls)
	} catch (err) {
		res.status(500).send('Error retrieving URLs')
	}
})

// Get all logs and details for a given GUID
app.get('/logs/:guid', async (req, res) => {
	const { guid } = req.params
	const filePath = path.join(DATA_DIR, `${guid}.json`)
	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		const data = JSON.parse(rawData)
		res.json(data) // Return the entire data object, including name and requests
	} catch (err) {
		res.status(404).send('Logs not found')
	}
})

// Delete a specific log by log number
app.delete('/logs/:guid/:logNumber', async (req, res) => {
	const { guid, logNumber } = req.params
	const filePath = path.join(DATA_DIR, `${guid}.json`)
	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		let data = JSON.parse(rawData)
		data.requests = data.requests.filter(log => log.logNumber !== parseInt(logNumber))

		await fs.writeFile(filePath, JSON.stringify(data, null, 2))
		res.sendStatus(200)
	} catch (err) {
		console.error(`Error deleting log #${logNumber} for GUID ${guid}:`, err)
		res.status(500).send('Error deleting log')
	}
})

// Delete multiple or all logs
app.delete('/logs/:guid', async (req, res) => {
	const { guid } = req.params
	const { logs } = req.body
	const filePath = path.join(DATA_DIR, `${guid}.json`)

	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		let data = JSON.parse(rawData)
		if (!logs) {
			// Delete all logs
			data.requests = []
		} else {
			// Delete specified logs
			data.requests = data.requests.filter(log => !logs.includes(log.logNumber))
		}

		await fs.writeFile(filePath, JSON.stringify(data, null, 2))
		res.sendStatus(200)
	} catch (err) {
		console.error(`Error deleting logs for GUID ${guid}:`, err)
		res.status(500).send('Error deleting logs')
	}
})

// Serve logs as SSE for new logs
app.get('/logs-stream/:guid', (req, res) => {
	const { guid } = req.params
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache')
	res.setHeader('Connection', 'keep-alive')

	if (!sseClients[guid]) sseClients[guid] = []
	sseClients[guid].push(res)

	// Remove the response object when the client closes the connection
	req.on('close', () => {
		sseClients[guid] = sseClients[guid].filter(client => client !== res)
	})
})

// Rename a URL
app.post('/rename-url/:guid', async (req, res) => {
	const { guid } = req.params
	const { name } = req.body
	const filePath = path.join(DATA_DIR, `${guid}.json`)

	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		const data = JSON.parse(rawData)

		data.name = name
		await fs.writeFile(filePath, JSON.stringify(data, null, 2))
		res.sendStatus(200)
	} catch (err) {
		console.error(`Error renaming URL ${guid}:`, err)
		res.status(500).send('Error renaming URL')
	}
})

// Log all requests under their respective GUIDs, including query strings and subdirectories
app.all('/:guid/:subPath*?', async (req, res) => {
	const { guid } = req.params
	const subPath = req.params.subPath || ''
	const requestData = {
		url: req.originalUrl, // Includes query string in the logged URL
		method: req.method,
		headers: req.headers,
		body: req.body, // This will contain the parsed body, regardless of content type
		timestamp: new Date().toISOString()
	}

	const result = await logRequest(guid, requestData)
	if (result.error) {
		res.status(result.status).send(result.error)
	} else {
		res.sendStatus(result.status)
	}
})

// Start the server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`))
