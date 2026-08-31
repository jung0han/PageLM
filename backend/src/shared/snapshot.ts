import crypto from "crypto"
import fs from "fs"
import path from "path"
import db from "../utils/database/keyv"
import { indexSharedChunks } from "../rag/runtime"
import { config } from "../config/env"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../rag/vertex"

export type ArchiveEmbeddingIdentity = { model: string; dimensions: number; version: string }
export type ArchiveSnapshotChunk = {
  id: string
  text: string
  denseVector?: number[]
  embedding?: ArchiveEmbeddingIdentity
}
export type ArchiveSnapshotAsset = {
  id: string
  filename: string
  mimeType: string
  sourcePath: string
  chunks: ArchiveSnapshotChunk[]
}
export type ArchiveSnapshotRecord = {
  id: string
  title: string
  description?: string
  dataSourceId?: string
  active: boolean
  admitted: boolean
  assets: ArchiveSnapshotAsset[]
}
export type ArchiveSnapshotCollection = {
  id: string
  title: string
  description?: string
  parentId?: string | null
  active: boolean
  explicitUserSubjects: string[]
  organizationSubjects?: string[]
  records: ArchiveSnapshotRecord[]
}
export type ArchiveSnapshotInput = {
  snapshotId: string
  collections: ArchiveSnapshotCollection[]
}

export type LearningMaterialChunk = { id: string; text: string }
export type LearningMaterialAsset = {
  id: string
  filename: string
  mimeType: string
  chunks: LearningMaterialChunk[]
}
export type LearningMaterial = {
  id: string
  title: string
  description: string
  provenance: { archiveCollectionId: string; archiveRecordId: string; archiveDataSourceId?: string }
  assets: LearningMaterialAsset[]
}
export type SharedNamespace = {
  id: string
  title: string
  description: string
  parentId: string | null
  snapshotId: string
  explicitUserSubjects: string[]
  organizationSubjects: string[]
  provenance: { archiveCollectionId: string }
  materials: LearningMaterial[]
}

type StoredAsset = LearningMaterialAsset & { namespaceId: string; path: string }
export type SharedNamespacePrincipal = { subject: string; organizationSubjects?: string[] }

function requireText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function stableId(...values: string[]) {
  return crypto.createHash("sha256").update(values.join("\0")).digest("hex")
}

function reusableDenseVector(chunk: ArchiveSnapshotChunk) {
  return !!config.vertexEmbeddingVersion
    && chunk.embedding?.model === EMBEDDING_MODEL
    && chunk.embedding.dimensions === EMBEDDING_DIMENSIONS
    && chunk.embedding.version === config.vertexEmbeddingVersion
    && Array.isArray(chunk.denseVector)
    && chunk.denseVector.length === EMBEDDING_DIMENSIONS
    && chunk.denseVector.every(Number.isFinite)
}

function storageRoot() {
  const root = path.resolve(process.cwd(), "storage", "shared-assets")
  fs.mkdirSync(root, { recursive: true })
  return root
}

function publicNamespace(namespace: SharedNamespace, accessibleIds: Set<string>, selectionNamespaceIds: string[]) {
  return {
    id: namespace.id,
    title: namespace.title,
    description: namespace.description,
    parentId: namespace.parentId && accessibleIds.has(namespace.parentId) ? namespace.parentId : null,
    selectionNamespaceIds,
  }
}

function hasFlatGrant(namespace: SharedNamespace, principal: SharedNamespacePrincipal) {
  if (namespace.explicitUserSubjects.includes(principal.subject)) return true
  const currentOrganizations = new Set(principal.organizationSubjects || [])
  return namespace.organizationSubjects.some(subject => currentOrganizations.has(subject))
}

export async function absorbArchiveSnapshot(input: ArchiveSnapshotInput) {
  const snapshotId = requireText(input?.snapshotId, "snapshotId")
  if (!Array.isArray(input?.collections)) throw new Error("collections must be an array")

  let namespaceCount = 0
  let materialCount = 0
  let assetCount = 0
  let searchRows = 0
  let grantRows = 0
  let denseVectorsReused = 0
  let denseVectorsEmbedded = 0
  const index = new Set<string>(((await db.get("shared-namespace:index")) as string[]) || [])

  for (const collection of input.collections) {
    if (!collection?.active) continue
    const collectionId = requireText(collection.id, "collection.id")
    const namespaceId = `shared:${collectionId}`
    const materials: LearningMaterial[] = []

    for (const record of collection.records || []) {
      if (!record?.active || !record?.admitted) continue
      const recordId = requireText(record.id, "record.id")
      const assets: LearningMaterialAsset[] = []

      for (const asset of record.assets || []) {
        const sourcePath = path.resolve(requireText(asset.sourcePath, "asset.sourcePath"))
        const stat = await fs.promises.stat(sourcePath)
        if (!stat.isFile()) throw new Error(`snapshot asset is not a file: ${sourcePath}`)
        const assetId = stableId(namespaceId, recordId, requireText(asset.id, "asset.id")).slice(0, 48)
        const destination = path.join(storageRoot(), assetId)
        await fs.promises.copyFile(sourcePath, destination)
        const snapshotChunks = (asset.chunks || [])
          .filter(chunk => typeof chunk?.text === "string" && chunk.text.trim())
          .map(chunk => ({ ...chunk, id: requireText(chunk.id, "chunk.id"), text: chunk.text.trim() }))
        const chunks = snapshotChunks.map(chunk => ({ id: chunk.id, text: chunk.text }))
        const stored: StoredAsset = {
          id: assetId,
          namespaceId,
          filename: requireText(asset.filename, "asset.filename"),
          mimeType: typeof asset.mimeType === "string" && asset.mimeType ? asset.mimeType : "application/octet-stream",
          path: destination,
          chunks,
        }
        await db.set(`shared-asset:${namespaceId}:${assetId}`, stored)
        await indexSharedChunks({
          namespace: namespaceId,
          assetId,
          filename: stored.filename,
          chunks: snapshotChunks.map(chunk => {
            if (reusableDenseVector(chunk)) {
              denseVectorsReused++
              return { sourceId: chunk.id, text: chunk.text, denseVector: chunk.denseVector }
            }
            denseVectorsEmbedded++
            return { sourceId: chunk.id, text: chunk.text }
          }),
        })
        assets.push({ id: stored.id, filename: stored.filename, mimeType: stored.mimeType, chunks })
        assetCount++
        searchRows += chunks.length
      }

      materials.push({
        id: stableId(namespaceId, recordId).slice(0, 48),
        title: requireText(record.title, "record.title"),
        description: typeof record.description === "string" ? record.description : "",
        provenance: {
          archiveCollectionId: collectionId,
          archiveRecordId: recordId,
          ...(record.dataSourceId ? { archiveDataSourceId: requireText(record.dataSourceId, "record.dataSourceId") } : {}),
        },
        assets,
      })
      materialCount++
    }

    const explicitUserSubjects = [...new Set((collection.explicitUserSubjects || []).filter(Boolean))]
    const organizationSubjects = [...new Set((collection.organizationSubjects || []).filter(Boolean))]
    grantRows += explicitUserSubjects.length + organizationSubjects.length
    const namespace: SharedNamespace = {
      id: namespaceId,
      title: requireText(collection.title, "collection.title"),
      description: typeof collection.description === "string" ? collection.description : "",
      parentId: collection.parentId ? `shared:${collection.parentId}` : null,
      snapshotId,
      explicitUserSubjects,
      organizationSubjects,
      provenance: { archiveCollectionId: collectionId },
      materials,
    }
    await db.set(`shared-namespace:${namespaceId}`, namespace)
    index.add(namespaceId)
    namespaceCount++
  }

  await db.set("shared-namespace:index", [...index])
  return {
    snapshotId,
    namespaces: namespaceCount,
    materials: materialCount,
    assets: assetCount,
    searchRows,
    grantRows,
    denseVectorsReused,
    denseVectorsEmbedded,
    bm25Rebuilt: true,
    privateAssetsCopied: assetCount,
  }
}

export async function getSharedNamespace(namespaceId: string) {
  return await db.get(`shared-namespace:${namespaceId}`) as SharedNamespace | undefined
}

export async function canAccessSharedNamespace(namespaceId: string, principal: SharedNamespacePrincipal | string) {
  const namespace = await getSharedNamespace(namespaceId)
  const resolvedPrincipal = typeof principal === "string" ? { subject: principal } : principal
  return !!namespace && hasFlatGrant(namespace, resolvedPrincipal)
}

export async function listSharedNamespaces(principal: SharedNamespacePrincipal) {
  const ids = ((await db.get("shared-namespace:index")) as string[]) || []
  const accessible = new Map<string, SharedNamespace>()
  for (const id of ids) {
    const namespace = await getSharedNamespace(id)
    if (namespace && hasFlatGrant(namespace, principal)) accessible.set(id, namespace)
  }
  const accessibleIds = new Set(accessible.keys())
  const children = new Map<string | null, SharedNamespace[]>()
  for (const namespace of accessible.values()) {
    const parentId = namespace.parentId && accessibleIds.has(namespace.parentId) ? namespace.parentId : null
    const siblings = children.get(parentId) || []
    siblings.push(namespace)
    children.set(parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.title.localeCompare(b.title))
  const descendants = (rootId: string) => {
    const result: string[] = []
    const visited = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      result.push(id)
      for (const namespace of children.get(id) || []) visit(namespace.id)
    }
    visit(rootId)
    return result
  }
  const ordered: SharedNamespace[] = []
  const emitted = new Set<string>()
  const append = (namespace: SharedNamespace) => {
    if (emitted.has(namespace.id)) return
    emitted.add(namespace.id)
    ordered.push(namespace)
    for (const child of children.get(namespace.id) || []) append(child)
  }
  for (const root of children.get(null) || []) append(root)
  for (const namespace of accessible.values()) append(namespace)
  return ordered.map(namespace => publicNamespace(namespace, accessibleIds, descendants(namespace.id)))
}

export async function getSharedMaterials(namespaceId: string, principal: SharedNamespacePrincipal) {
  const namespace = await getSharedNamespace(namespaceId)
  if (!namespace || !hasFlatGrant(namespace, principal)) return undefined
  return namespace.materials
}

export async function getSharedAsset(namespaceId: string, assetId: string, principal: SharedNamespacePrincipal) {
  if (!await canAccessSharedNamespace(namespaceId, principal)) return undefined
  return await db.get(`shared-asset:${namespaceId}:${assetId}`) as StoredAsset | undefined
}

export async function readArchiveSnapshotFile(filename: string) {
  const resolved = path.resolve(filename)
  const parsed = JSON.parse(await fs.promises.readFile(resolved, "utf8")) as ArchiveSnapshotInput
  return absorbArchiveSnapshot(parsed)
}
