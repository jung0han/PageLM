import { ToolIO } from "../types"
import { searchPersonalChunks } from "../../rag/runtime"

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
    const docs = await searchPersonalChunks({ ownerSubject, namespace: ns, query: q, limit: k })
    const out = docs.map(d => ({ text: d.text, meta: d.meta }))
    return out.length ? out : [{ text: "" }]
  }
}
