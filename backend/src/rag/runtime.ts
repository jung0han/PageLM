import { randomUUID } from "crypto"
import {
  DataType,
  FunctionType,
  MetricType,
  MilvusClient,
  RRFRanker,
} from "@zilliz/milvus2-sdk-node"
import { config } from "../config/env"
import { EMBEDDING_DIMENSIONS, embedWithVertex } from "./vertex"

export type PersonalChunkInput = {
  ownerSubject: string
  namespace: string
  assetId: string
  filename: string
  chunks: string[]
}

export type RagHit = {
  text: string
  meta: { chunkId: string; assetId: string; filename: string; score: number; namespaceId?: string }
}

export type SharedChunkInput = {
  namespace: string
  assetId: string
  filename: string
  chunks: Array<{ sourceId: string; text: string }>
}

let client: MilvusClient | undefined
let collectionReady: Promise<void> | undefined

function milvus() {
  if (!client) {
    client = new MilvusClient({
      address: config.milvusAddress,
      ...(config.milvusToken ? { token: config.milvusToken } : {}),
      database: config.milvusDatabase,
    })
  }
  return client
}

async function ensureCollection() {
  if (collectionReady) return collectionReady
  collectionReady = (async () => {
    const db = milvus()
    const exists = await db.hasCollection({ collection_name: config.milvusCollection })
    if (!exists.value) {
      await db.createCollection({
        collection_name: config.milvusCollection,
        consistency_level: "Strong",
        fields: [
          { name: "chunk_id", data_type: DataType.VarChar, max_length: 64, is_primary_key: true },
          { name: "owner_subject", data_type: DataType.VarChar, max_length: 512 },
          { name: "namespace_id", data_type: DataType.VarChar, max_length: 128 },
          { name: "asset_id", data_type: DataType.VarChar, max_length: 64 },
          { name: "filename", data_type: DataType.VarChar, max_length: 1024 },
          { name: "content", data_type: DataType.VarChar, max_length: 8192, enable_analyzer: true, enable_match: true },
          { name: "dense_vector", data_type: DataType.FloatVector, dim: EMBEDDING_DIMENSIONS },
          { name: "bm25_vector", data_type: DataType.SparseFloatVector, is_function_output: true },
        ],
        functions: [{
          name: "content_bm25",
          type: FunctionType.BM25,
          input_field_names: ["content"],
          output_field_names: ["bm25_vector"],
          params: {},
        }],
        index_params: [
          { field_name: "dense_vector", index_type: "HNSW", metric_type: MetricType.COSINE, params: { M: 16, efConstruction: 256 } },
          { field_name: "bm25_vector", index_type: "SPARSE_INVERTED_INDEX", metric_type: MetricType.BM25, params: {} },
        ],
      } as any)
    }
    await db.loadCollection({ collection_name: config.milvusCollection })
  })().catch(error => {
    collectionReady = undefined
    throw error
  })
  return collectionReady
}

function isPersonalNamespace(namespace: string) {
  return /^chat:[A-Za-z0-9-]+$/.test(namespace)
}

function quoted(value: string) {
  return JSON.stringify(value)
}

export async function indexPersonalChunks(input: PersonalChunkInput) {
  if (!input.ownerSubject || !isPersonalNamespace(input.namespace)) throw new Error("invalid personal namespace")
  await ensureCollection()
  const rows: Array<Record<string, any>> = []
  for (const content of input.chunks) {
    if (!content.trim()) continue
    rows.push({
      chunk_id: randomUUID(),
      owner_subject: input.ownerSubject,
      namespace_id: input.namespace,
      asset_id: input.assetId,
      filename: input.filename,
      content,
      dense_vector: await embedWithVertex(content, "RETRIEVAL_DOCUMENT"),
    })
  }
  if (rows.length) await milvus().insert({ collection_name: config.milvusCollection, data: rows })
  return rows.map(row => row.chunk_id)
}

export async function indexSharedChunks(input: SharedChunkInput) {
  if (!/^shared:[A-Za-z0-9._:-]+$/.test(input.namespace)) throw new Error("invalid shared namespace")
  await ensureCollection()
  const rows: Array<Record<string, any>> = []
  for (const chunk of input.chunks) {
    if (!chunk.text.trim()) continue
    rows.push({
      chunk_id: randomUUID(),
      owner_subject: "",
      namespace_id: input.namespace,
      asset_id: input.assetId,
      filename: input.filename,
      content: chunk.text,
      dense_vector: await embedWithVertex(chunk.text, "RETRIEVAL_DOCUMENT"),
    })
  }
  if (rows.length) await milvus().insert({ collection_name: config.milvusCollection, data: rows })
  return rows.map(row => row.chunk_id)
}

export async function searchPersonalChunks(input: { ownerSubject: string; namespace: string; query: string; limit: number }): Promise<RagHit[]> {
  if (!input.ownerSubject || !isPersonalNamespace(input.namespace) || !input.query.trim()) return []
  await ensureCollection()
  const dense = await embedWithVertex(input.query, "RETRIEVAL_QUERY")
  const response = await milvus().hybridSearch({
    collection_name: config.milvusCollection,
    filter: `owner_subject == ${quoted(input.ownerSubject)} && namespace_id == ${quoted(input.namespace)}`,
    data: [
      { anns_field: "dense_vector", data: dense, metric_type: MetricType.COSINE, params: { ef: 64 } },
      { anns_field: "bm25_vector", data: input.query, metric_type: MetricType.BM25, params: {} },
    ],
    rerank: RRFRanker(60),
    limit: input.limit,
    output_fields: ["chunk_id", "content", "filename", "asset_id"],
    consistency_level: "Strong" as any,
  } as any)
  return (response.results || []).map((row: any) => ({
    text: String(row.content || ""),
    meta: {
      chunkId: String(row.chunk_id || row.id || ""),
      assetId: String(row.asset_id || ""),
      filename: String(row.filename || ""),
      score: Number(row.score || 0),
      namespaceId: input.namespace,
    },
  }))
}

export async function searchSharedChunks(input: { namespaceIds: string[]; query: string; limit: number }): Promise<RagHit[]> {
  const namespaceIds = [...new Set(input.namespaceIds.filter(namespace => /^shared:[A-Za-z0-9._:-]+$/.test(namespace)))]
  if (!namespaceIds.length || !input.query.trim()) return []
  await ensureCollection()
  const dense = await embedWithVertex(input.query, "RETRIEVAL_QUERY")
  const response = await milvus().hybridSearch({
    collection_name: config.milvusCollection,
    filter: `owner_subject == "" && namespace_id in [${namespaceIds.map(quoted).join(", ")}]`,
    data: [
      { anns_field: "dense_vector", data: dense, metric_type: MetricType.COSINE, params: { ef: 64 } },
      { anns_field: "bm25_vector", data: input.query, metric_type: MetricType.BM25, params: {} },
    ],
    rerank: RRFRanker(60),
    limit: input.limit,
    output_fields: ["chunk_id", "content", "filename", "asset_id", "namespace_id"],
    consistency_level: "Strong" as any,
  } as any)
  return (response.results || []).map((row: any) => ({
    text: String(row.content || ""),
    meta: {
      chunkId: String(row.chunk_id || row.id || ""),
      assetId: String(row.asset_id || ""),
      filename: String(row.filename || ""),
      score: Number(row.score || 0),
      namespaceId: String(row.namespace_id || ""),
    },
  }))
}
