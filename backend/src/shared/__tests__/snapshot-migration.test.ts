import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.VERTEX_PROJECT_ID = "pagelm-pilot-test"
process.env.VERTEX_EMBEDDING_VERSION = "pilot-v1"
process.env.MILVUS_ADDRESS = "milvus.test:19530"
process.env.MILVUS_COLLECTION = "pagelm_pilot_chunks"

const insertedRows: any[] = []
let documentEmbeddingCalls = 0

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        request: async () => {
          documentEmbeddingCalls++
          return { data: { predictions: [{ embeddings: { values: Array(1536).fill(0.75) } }] } }
        },
      }
    }
  },
}))

vi.mock("@zilliz/milvus2-sdk-node", async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    MilvusClient: class {
      async hasCollection() { return { value: true } }
      async loadCollection() { return { error_code: "Success" } }
      async insert(request: any) { insertedRows.push(...request.data); return { error_code: "Success" } }
      async upsert(request: any) {
        for (const row of request.data) {
          const index = insertedRows.findIndex(existing => existing.chunk_id === row.chunk_id)
          if (index === -1) insertedRows.push(row)
          else insertedRows[index] = row
        }
        return { error_code: "Success" }
      }
    },
  }
})

const tempDirs: string[] = []

beforeEach(() => {
  insertedRows.length = 0
  documentEmbeddingCalls = 0
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("Archive snapshot migration", () => {
  test("reuses only exact Gemini vectors and preserves DataSource provenance", async () => {
    const suffix = crypto.randomUUID()
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-pilot-vector-"))
    tempDirs.push(sourceDir)
    const source = path.join(sourceDir, "pilot.txt")
    fs.writeFileSync(source, "pilot")
    const reusable = Array(1536).fill(0.25)
    const stale = Array(1536).fill(0.5)
    const { absorbArchiveSnapshot, getSharedMaterials } = await import("../snapshot")

    const report = await absorbArchiveSnapshot({
      snapshotId: `pilot-${suffix}`,
      collections: [{
        id: `collection-${suffix}`,
        title: "Pilot",
        active: true,
        explicitUserSubjects: [`person-${suffix}`],
        records: [{
          id: `record-${suffix}`,
          title: "Pilot material",
          dataSourceId: `datasource-${suffix}`,
          active: true,
          admitted: true,
          assets: [{
            id: `asset-${suffix}`,
            filename: "pilot.txt",
            mimeType: "text/plain",
            sourcePath: source,
            chunks: [
              {
                id: `reused-${suffix}`,
                text: "reuse",
                denseVector: reusable,
                embedding: { model: "gemini-embedding-001", dimensions: 1536, version: "pilot-v1" },
              },
              {
                id: `embedded-${suffix}`,
                text: "reembed",
                denseVector: stale,
                embedding: { model: "gemini-embedding-001", dimensions: 1536, version: "stale-v0" },
              },
            ],
          }],
        }],
      }],
    })

    expect(report).toMatchObject({ denseVectorsReused: 1, denseVectorsEmbedded: 1, bm25Rebuilt: true, privateAssetsCopied: 1 })
    expect(documentEmbeddingCalls).toBe(1)
    expect(insertedRows.map(row => row.dense_vector)).toEqual([reusable, Array(1536).fill(0.75)])
    const materials = await getSharedMaterials(`shared:collection-${suffix}`, { subject: `person-${suffix}` })
    expect(materials?.[0].provenance).toEqual({
      archiveCollectionId: `collection-${suffix}`,
      archiveRecordId: `record-${suffix}`,
      archiveDataSourceId: `datasource-${suffix}`,
    })
  })

  test("upserts stable shared chunk rows across a same-volume redeploy", async () => {
    const suffix = crypto.randomUUID()
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-pilot-redeploy-"))
    tempDirs.push(sourceDir)
    const source = path.join(sourceDir, "pilot.txt")
    fs.writeFileSync(source, "stable")
    const { absorbArchiveSnapshot } = await import("../snapshot")
    const snapshot = {
      snapshotId: `redeploy-${suffix}`,
      collections: [{
        id: `collection-${suffix}`,
        title: "Redeploy",
        active: true,
        explicitUserSubjects: [`person-${suffix}`],
        records: [{
          id: `record-${suffix}`,
          title: "Stable row",
          active: true,
          admitted: true,
          assets: [{
            id: `asset-${suffix}`,
            filename: "pilot.txt",
            mimeType: "text/plain",
            sourcePath: source,
            chunks: [{ id: `chunk-${suffix}`, text: "stable chunk" }],
          }],
        }],
      }],
    }

    await absorbArchiveSnapshot(snapshot)
    const firstId = insertedRows[0].chunk_id
    await absorbArchiveSnapshot(snapshot)

    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].chunk_id).toBe(firstId)
  })
})
