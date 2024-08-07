const fs = require('fs').promises
const path = require('path')
const sqlite3 = require('sqlite3').verbose()

// Global constants
const DATA_DIR = path.join(__dirname, 'data')

// Read JSON file
async function readJsonFile(filePath) {
	try {
		const data = await fs.readFile(filePath, 'utf8')
		return JSON.parse(data)
	} catch (err) {
		console.error('Error reading JSON file:', err)
		throw err
	}
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

// Insert metadata into the database
async function insertMetadata(dbPath, name) {
	const db = new sqlite3.Database(dbPath)
	return new Promise((resolve, reject) => {
		db.run(`INSERT INTO metadata (name) VALUES (?)`, [name], err => {
			db.close()
			if (err) {
				console.error('Error inserting metadata:', err)
				return reject(err)
			}
			resolve()
		})
	})
}

// Insert requests into the database
async function insertRequests(dbPath, requests) {
	const db = new sqlite3.Database(dbPath)
	return new Promise((resolve, reject) => {
		const stmt = db.prepare(
			`INSERT INTO requests (timestamp, method, url, headers, body) VALUES (?, ?, ?, ?, ?)`
		)

		requests.forEach(request => {
			stmt.run(
				request.timestamp,
				request.method,
				request.url,
				JSON.stringify(request.headers),
				JSON.stringify(request.body),
				err => {
					if (err) {
						console.error('Error inserting request:', err)
						return reject(err)
					}
				}
			)
		})

		stmt.finalize(err => {
			db.close()
			if (err) {
				console.error('Error finalizing statement:', err)
				return reject(err)
			}
			resolve()
		})
	})
}

// Main function to import JSON data into SQLite database
async function importJsonToDb(jsonFilePath) {
	try {
		const jsonData = await readJsonFile(jsonFilePath)
		const guid = jsonData.requests[0].url.split('/')[1]
		const dbPath = await initDb(guid)

		await insertMetadata(dbPath, jsonData.name)
		await insertRequests(dbPath, jsonData.requests)

		console.log('Import completed successfully.')
	} catch (err) {
		console.error('Error importing JSON data to SQLite database:', err)
	}
}

// Command line processing
const args = process.argv.slice(2)
if (args.length !== 1) {
	console.error('Usage: node import.js <path-to-json-file>')
	process.exit(1)
}

const jsonFilePath = args[0]
importJsonToDb(jsonFilePath)
