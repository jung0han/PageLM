import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import mammoth from 'mammoth'
import pdf from 'pdf-parse'
import Busboy from 'busboy'
import { embedTextFromFile } from '../ai/embed'
import { savePrivateAsset } from '../../utils/chat/chat'

const str = path.join(process.cwd(), 'storage', 'uploads')
if (!fs.existsSync(str)) fs.mkdirSync(str, { recursive: true })

export type UpFile = { path: string; filename: string; mimeType: string }

export function parseMultipart(req: any, ownerSubject: string): Promise<{ q: string; chatId?: string; model?: string; files: UpFile[] }> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, defParamCharset: 'utf8' })
    let q = ''
    let chatId = ''
    let model = ''
    const files: UpFile[] = []
    let pending = 0
    let ended = false
    let failed = false
    const done = () => { if (!failed && ended && pending === 0) resolve({ q, chatId: chatId || undefined, model: model || undefined, files }) }

    bb.on('field', (n, v) => { if (n === 'q') q = v; if (n === 'chatId') chatId = v; if (n === 'model') model = v })
    bb.on('file', (_n, file, info: any) => {
      pending++
      const filename = info?.filename || 'file'
      const mimeType = info?.mimeType || info?.mime || 'application/octet-stream'
      const ownerDir = path.join(str, createHash('sha256').update(ownerSubject).digest('hex'))
      fs.mkdirSync(ownerDir, { recursive: true })
      // The original name is display metadata. Keeping it out of the storage
      // component avoids filesystem limits and special-name behavior.
      const fp = path.join(ownerDir, randomUUID())
      const ws = fs.createWriteStream(fp)
      const fail = (error: unknown) => {
        if (failed) return
        failed = true
        fs.promises.unlink(fp).catch(() => undefined)
        reject(error)
      }
      file.on('error', fail)
      ws.on('error', fail)
      ws.on('finish', () => { files.push({ path: fp, filename, mimeType }); pending--; done() })
      file.pipe(ws)
    })
    bb.on('error', e => { failed = true; reject(e) })
    bb.on('finish', () => { ended = true; done() })
    req.pipe(bb)
  })
}

export async function handleUpload(a: {
  filePath: string
  filename: string
  contentType?: string
  namespace: string
  chatId: string
  ownerSubject: string
}): Promise<{ stored: string; assetId: string }> {
  const fp = a.filePath
  const mime = a.contentType || ''
  const txt = await extractText(fp, mime)
  if (!txt?.trim()) throw new Error('No valid content extracted from file.')
  const out = `${fp}.txt`
  fs.writeFileSync(out, txt)
  const assetId = randomUUID()
  await embedTextFromFile({ filePath: out, namespace: a.namespace, ownerSubject: a.ownerSubject, assetId, filename: a.filename })
  await savePrivateAsset({ id: assetId, chatId: a.chatId, filename: a.filename, mimeType: mime, path: fp }, a.ownerSubject)
  return { stored: out, assetId }
}

async function extractText(filePath: string, mime: string) {
  const raw = fs.readFileSync(filePath)
  if (mime.includes('pdf')) {
    const data = await pdf(raw)
    return data.text
  }
  if (mime.includes('markdown')) {
    return raw.toString()
  }
  if (mime.includes('plain')) {
    return raw.toString()
  }
  if (mime.includes('wordprocessingml') || mime.includes('msword') || mime.includes('vnd.oasis.opendocument.text')) {
    const r = await mammoth.extractRawText({ buffer: raw })
    return r.value
  }
  throw new Error('unsupported file type')
}
