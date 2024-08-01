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

// Write incoming request details to a file, with a sequence number
async function logRequest(guid, requestData) {
	const filePath = path.join(DATA_DIR, `${guid}.json`)
	let logData = []
	let nextLogNumber = 1

	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		logData = JSON.parse(rawData)
		nextLogNumber = logData.length + 1
	} catch (err) {
		if (err.code !== 'ENOENT') {
			console.error(`Error reading log file for GUID ${guid}:`, err)
		}
		// If the file doesn't exist, we start with an empty array
	}

	requestData.logNumber = nextLogNumber
	logData.push(requestData)

	try {
		await fs.writeFile(filePath, JSON.stringify(logData, null, 2))
	} catch (err) {
		console.error(`Error writing log file for GUID ${guid}:`, err)
		return
	}

	// Notify SSE listeners
	if (sseClients[guid]) {
		const message = JSON.stringify(requestData)
		sseClients[guid].forEach(res => res.write(`data: ${message}\n\n`))
		console.log(`SSE message sent for GUID ${guid}`)
	}
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

// Create a new GUID
app.post('/create-url', async (req, res) => {
	const guid = generateGuid()
	const filePath = path.join(DATA_DIR, `${guid}.json`)

	// Create an empty file with an empty array
	await fs.writeFile(filePath, JSON.stringify([]))
	res.json({ guid })
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

// Get all GUIDs with their creation and modification times
app.get('/get-urls', async (req, res) => {
	try {
		const files = await fs.readdir(DATA_DIR)
		const urls = await Promise.all(files.map(async file => {
			const filePath = path.join(DATA_DIR, file)
			const stats = await fs.stat(filePath)
			return {
				guid: path.basename(file, '.json'),
				created: stats.birthtime,
				modified: stats.mtime
			}
		}))
		res.json(urls)
	} catch (err) {
		res.status(500).send('Error retrieving URLs')
	}
})

// Get all logs for a given GUID
app.get('/logs/:guid', async (req, res) => {
	const { guid } = req.params
	const filePath = path.join(DATA_DIR, `${guid}.json`)
	try {
		const rawData = await fs.readFile(filePath, 'utf8')
		const logData = JSON.parse(rawData)
		res.json(logData)
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
		let logData = JSON.parse(rawData)
		logData = logData.filter(log => log.logNumber !== parseInt(logNumber))

		await fs.writeFile(filePath, JSON.stringify(logData, null, 2))
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
		if (!logs) {
			// Delete all logs
			await fs.writeFile(filePath, JSON.stringify([]))
			res.sendStatus(200)
		} else {
			// Delete specified logs
			const rawData = await fs.readFile(filePath, 'utf8')
			let logData = JSON.parse(rawData)
			logData = logData.filter(log => !logs.includes(log.logNumber))

			await fs.writeFile(filePath, JSON.stringify(logData, null, 2))
			res.sendStatus(200)
		}
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

	console.log(`Client connected for SSE, GUID: ${guid}, Clients: ${sseClients[guid].length}`)

	// Remove the response object when the client closes the connection
	req.on('close', () => {
		sseClients[guid] = sseClients[guid].filter(client => client !== res)
		console.log(`Client disconnected from SSE, GUID: ${guid}, Remaining Clients: ${sseClients[guid].length}`)
	})
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

	try {
		await logRequest(guid, requestData)
		res.sendStatus(200)
	} catch (err) {
		console.error(`Error logging request for GUID ${guid}:`, err)
		res.status(500).send('Error logging request')
	}
})

// Start the server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`))
