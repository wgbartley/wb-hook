// Import required modules
const express = require('express')
const fs = require('fs').promises // Use promises for async file operations
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const morgan = require('morgan')
const moment = require('moment')
const bodyParser = require('body-parser') // Import body-parser for handling different content types
const sqlite3 = require('sqlite3').verbose()

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

// Initialize SQLite database
async function initDb(guid) {
	const dbPath = path.join(DATA_DIR, `${guid}.db`)
	const db = new sqlite3.Database(dbPath)

	return new Promise((resolve, reject) => {
		db.serialize(() => {
			db.run(`CREATE TABLE IF NOT EXISTS metadata (name TEXT)`, err => {
				if (err) return reject(err)
			})

			db.run(
				`CREATE TABLE IF NOT EXISTS requests (
					logNumber INTEGER PRIMARY KEY AUTOINCREMENT,
					timestamp TEXT,
					method TEXT,
					url TEXT,
					headers TEXT,
					body TEXT
				)`,
				err => {
					if (err) return reject(err)
					db.close()
					resolve(dbPath)
				}
			)
		})
	})
}

// Write incoming request details to a SQLite database
async function logRequest(guid, requestData) {
	const dbPath = path.join(DATA_DIR, `${guid}.db`)

	try {
		await fs.access(dbPath)
	} catch (err) {
		return { status: 404, error: 'Not found' }
	}

	await initDb(guid) // Ensure the database and tables are initialized

	const db = new sqlite3.Database(dbPath)

	return new Promise((resolve, reject) => {
		const stmt = db.prepare(
			`INSERT INTO requests (timestamp, method, url, headers, body) VALUES (?, ?, ?, ?, ?)`
		)
		stmt.run(
			requestData.timestamp,
			requestData.method,
			requestData.url,
			JSON.stringify(requestData.headers),
			JSON.stringify(requestData.body),
			function(err) {
				if (err) {
					stmt.finalize()
					db.close()
					return resolve({ status: 500, error: err.message })
				}

				const logNumber = this.lastID

				stmt.finalize()
				db.close()

				// Add logNumber to requestData
				requestData.logNumber = logNumber

				// Push update to clients
				pushUpdateToClients(guid, requestData)

				resolve({ status: 200 })
			}
		)
	})
}

// Function to push updates to clients
function pushUpdateToClients(guid, log) {
	if (sseClients[guid]) {
		sseClients[guid].forEach(client => {
			client.write(`data: ${JSON.stringify(log)}\n\n`)
		})
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

// Create a new GUID with an optional name
app.post('/create-url', async (req, res) => {
	const guid = generateGuid()
	const { name = 'Untitled' } = req.body
	const dbPath = await initDb(guid)

	const db = new sqlite3.Database(dbPath)
	return new Promise((resolve, reject) => {
		db.run(`INSERT INTO metadata (name) VALUES (?)`, name, err => {
			if (err) return reject(err)
			res.json({ guid, name })
			db.close()
			resolve()
		})
	})
})

// Delete data associated with a GUID
app.delete('/delete-url/:guid', async (req, res) => {
	const { guid } = req.params
	const dbPath = path.join(DATA_DIR, `${guid}.db`)
	try {
		await fs.access(dbPath)
		await fs.unlink(dbPath)
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
			if (!file.endsWith('.db')) return null

			const dbPath = path.join(DATA_DIR, file)
			const db = new sqlite3.Database(dbPath)

			return new Promise((resolve, reject) => {
				db.serialize(() => {
					db.get(`SELECT name FROM metadata`, (err, row) => {
						if (err) return reject(err)

						const name = row ? row.name : 'Untitled'
						const guid = path.basename(file, '.db')

						db.get(`SELECT MIN(timestamp) as firstRequestTime, MAX(timestamp) as lastRequestTime, COUNT(*) as requestCount FROM requests`, (err, row) => {
							if (err) return reject(err)

							const { firstRequestTime, lastRequestTime, requestCount } = row
							fs.stat(dbPath).then(stats => {
								db.close()
								resolve({
									guid,
									name,
									created: stats.birthtime,
									modified: stats.mtime,
									requestCount,
									firstRequestTime,
									lastRequestTime
								})
							})
						})
					})
				})
			})
		}))

		res.json(urls.filter(Boolean))
	} catch (err) {
		res.status(500).send('Error retrieving URLs')
	}
})

// Get all logs and details for a given GUID
app.get('/logs/:guid', async (req, res) => {
	const { guid } = req.params
	const dbPath = path.join(DATA_DIR, `${guid}.db`)
	try {
		await fs.access(dbPath)
	} catch (err) {
		return res.sendStatus(404)
	}
	await initDb(guid) // Ensure the database and tables are initialized

	const db = new sqlite3.Database(dbPath)

	return new Promise((resolve, reject) => {
		db.serialize(() => {
			db.get(`SELECT name FROM metadata`, (err, row) => {
				if (err) return reject(err)

				const name = row ? row.name : 'Untitled'

				db.all(`SELECT * FROM requests ORDER BY logNumber DESC`, (err, rows) => {
					if (err) return reject(err)

					const requests = rows.map(row => ({
						logNumber: row.logNumber,
						timestamp: row.timestamp,
						method: row.method,
						url: row.url,
						headers: JSON.parse(row.headers),
						body: JSON.parse(row.body)
					}))

					res.json({ name, requests })
					db.close()
					resolve()
				})
			})
		})
	})
})

// Delete a specific log by log number
app.delete('/logs/:guid/:logNumber', async (req, res) => {
	const { guid, logNumber } = req.params
	const dbPath = path.join(DATA_DIR, `${guid}.db`)
	try {
		await fs.access(dbPath)
	} catch (err) {
		return res.sendStatus(404)
	}
	await initDb(guid) // Ensure the database and tables are initialized

	const db = new sqlite3.Database(dbPath)

	return new Promise((resolve, reject) => {
		db.run(`DELETE FROM requests WHERE logNumber = ?`, logNumber, err => {
			if (err) {
				console.error(`Error deleting log #${logNumber} for GUID ${guid}:`, err)
				return reject(err)
			}

			res.sendStatus(200)
			db.close()
			resolve()
		})
	})
})

// Delete multiple or all logs
app.delete('/logs/:guid', async (req, res) => {
	const { guid } = req.params
	const { logs } = req.body
	const dbPath = path.join(DATA_DIR, `${guid}.db`)
	try {
		await fs.access(dbPath)
	} catch (err) {
		return res.sendStatus(404)
	}
	await initDb(guid) // Ensure the database and tables are initialized

	const db = new sqlite3.Database(dbPath)

	return new Promise((resolve, reject) => {
		if (!logs) {
			// Delete all logs
			db.run(`DELETE FROM requests`, err => {
				if (err) {
					console.error(`Error deleting logs for GUID ${guid}:`, err)
					return reject(err)
				}

				res.sendStatus(200)
				db.close()
				resolve()
			})
		} else {
			// Delete specified logs
			const placeholders = logs.map(() => '?').join(',')
			db.run(`DELETE FROM requests WHERE logNumber IN (${placeholders})`, logs, err => {
				if (err) {
					console.error(`Error deleting logs for GUID ${guid}:`, err)
					return reject(err)
				}

				res.sendStatus(200)
				db.close()
				resolve()
			})
		}
	})
})

// Serve logs as SSE for new logs
app.get('/logs-stream/:guid', (req, res) => {
	const { guid } = req.params
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache')
	res.setHeader('Connection', 'keep-alive')

	if (!sseClients[guid]) sseClients[guid] = []
	sseClients[guid].push(res)

	// Send a comment to keep the connection alive every 15 seconds
	const keepAlive = setInterval(() => {
		res.write(': keep-alive\n\n')
	}, 15000)

	// Remove the response object and clear interval when the client closes the connection
	req.on('close', () => {
		clearInterval(keepAlive)
		sseClients[guid] = sseClients[guid].filter(client => client !== res)
	})
})

// Rename a URL
app.post('/rename-url/:guid', async (req, res) => {
	const { guid } = req.params
	const { name } = req.body
	const dbPath = path.join(DATA_DIR, `${guid}.db`)
	try {
		await fs.access(dbPath)
	} catch (err) {
		return res.sendStatus(404)
	}
	await initDb(guid) // Ensure the database and tables are initialized

	const db = new sqlite3.Database(dbPath)

	return new Promise((resolve, reject) => {
		db.run(`UPDATE metadata SET name = ?`, name, err => {
			if (err) {
				console.error(`Error renaming URL ${guid}:`, err)
				return reject(err)
			}

			res.sendStatus(200)
			db.close()
			resolve()
		})
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

	const result = await logRequest(guid, requestData)
	if (result.error) {
		res.status(result.status).send(result.error)
	} else {
		res.sendStatus(result.status)
	}
})

// Start the server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`))
