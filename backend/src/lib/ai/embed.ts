import fs from 'fs'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { indexPersonalChunks } from '../../rag/runtime'

export async function embedTextFromFile(input: {
  filePath: string
  namespace: string
  ownerSubject: string
  assetId: string
  filename: string
}) {
  const raw = fs.readFileSync(input.filePath, 'utf-8')
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 512, chunkOverlap: 30 })
  const docs = await splitter.createDocuments([raw])

  await indexPersonalChunks({
    ownerSubject: input.ownerSubject,
    namespace: input.namespace,
    assetId: input.assetId,
    filename: input.filename,
    chunks: docs.map(doc => String(doc.pageContent || '')),
  })
  return 'Uploaded successfully.'
}
