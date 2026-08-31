import Keyv from 'keyv'
import SQLite from '@keyv/sqlite'
import fs from 'fs'
import path from 'path'

const storageDir = path.join(process.cwd(), 'storage')
fs.mkdirSync(storageDir, { recursive: true })

const db = new Keyv({
  store: new SQLite({ uri: `sqlite://${path.join(storageDir, 'database.sqlite')}` })
})

export default db
