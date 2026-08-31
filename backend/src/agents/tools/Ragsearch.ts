import { ToolIO } from "../types"
import { searchPersonalChunks, searchSharedChunks } from "../../rag/runtime"
import { canAccessSharedNamespace } from "../../shared/snapshot"

function toStr(x: unknown) { if (x == null) return ""; if (typeof x === "string") return x; try { return JSON.stringify(x) } catch { return String(x) } }

export const Ragsearch: ToolIO = {
  name: "rag.search",
  desc: "Retrieve top-k dense plus BM25 passages from an authenticated chat namespace.",
  schema: { type: "object", properties: { q: { type: "string" }, ns: { type: "string" }, k: { type: "number" } }, required: [] },
  run: async (input: any, ctx: Record<string, any>) => {
    const q = toStr(input?.q ?? ctx?.q ?? "").trim()
    const ns = toStr(input?.ns ?? ctx?.ns ?? "").trim()
    const ownerSubject = toStr(ctx?.ownerSubject).trim()
    const kNum = Number(input?.k ?? 6); const k = Number.isFinite(kNum) && kNum > 0 ? Math.min(kNum, 20) : 6
    if (!q || !ownerSubject) return [{ text: "" }]
    const requestedShared = Array.isArray(ctx?.sharedNamespaceIds)
      ? [...new Set(ctx.sharedNamespaceIds.map(toStr).filter(Boolean))]
      : []
    const allowedShared: string[] = []
    for (const namespaceId of requestedShared) {
      if (await canAccessSharedNamespace(namespaceId, ownerSubject)) allowedShared.push(namespaceId)
    }
    const [personal, shared] = await Promise.all([
      searchPersonalChunks({ ownerSubject, namespace: ns, query: q, limit: k }),
      searchSharedChunks({ namespaceIds: allowedShared, query: q, limit: k }),
    ])
    const docs = [...personal, ...shared]
      .sort((a, b) => b.meta.score - a.meta.score)
      .slice(0, k)
    const out = docs.map(d => ({ text: d.text, meta: d.meta }))
    return out.length ? out : [{ text: "" }]
  }
}
