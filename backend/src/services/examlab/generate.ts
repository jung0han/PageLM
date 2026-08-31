import fs from "fs"
import path from "path"
import crypto from "crypto"
import { StateGraph, Annotation } from "@langchain/langgraph"
import { loadExam } from "./loader"
import { ExamPayload, ExamSpec, QuizLikeItem } from "./types"
import { generateSectionItems } from "./generator"

const cacheDir = path.join(process.cwd(), "storage", "cache", "exam")
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
const keyOf = (x: string) => crypto.createHash("sha256").update(x).digest("hex")
const readCache = (k: string) => {
  const f = path.join(cacheDir, k + ".json")
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null
}
const writeCache = (k: string, v: any) => fs.writeFileSync(path.join(cacheDir, k + ".json"), JSON.stringify(v))

const log = (...a: any[]) => console.log("[examlab/generate]", new Date().toISOString(), ...a)

type Ctx = {
  examId: string
  sourceMaterial: string
  spec: ExamSpec | null
  payload: ExamPayload | null
}

const S = Annotation.Root({
  examId: Annotation<string>(),
  sourceMaterial: Annotation<string>(),
  spec: Annotation<ExamSpec | null>(),
  payload: Annotation<ExamPayload | null>()
})

const nLoad = async (s: Ctx) => {
  log("nLoad:start", { examId: s.examId })
  let spec = loadExam(s.examId)
  if (!spec) {
    log("nLoad:error", "exam not found")
    throw new Error("exam not found")
  }
  if (s.sourceMaterial) {
    spec = {
      ...spec,
      sections: spec.sections.map(section => ({
        ...section,
        gen: section.gen ? {
          ...section.gen,
          prompt: `${section.gen.prompt || ""}\n\nUse this existing assistant turn as the study material:\n${s.sourceMaterial}`,
        } : section.gen,
      })),
    }
  }
  log("nLoad:ok", { sections: spec.sections.length })
  return { ...s, spec }
}

const nCache = async (s: Ctx) => {
  log("nCache:start")
  const k = keyOf(JSON.stringify({ examId: s.examId, sourceMaterial: s.sourceMaterial }))
  const c = readCache(k)
  if (c) {
    log("nCache:hit", { bytes: JSON.stringify(c).length })
    return { ...s, payload: c }
  }
  log("nCache:miss")
  return s
}

const nGen = async (s: Ctx) => {
  if (s.payload) {
    log("nGen:skip:already-have-payload")
    return s
  }
  const spec = s.spec!
  log("nGen:start", { sections: spec.sections.length })
  const sections: { id: string; title: string; durationSec: number; items: QuizLikeItem[] }[] = []
  for (const sec of spec.sections) {
    const t0 = Date.now()
    const seed = `${spec.id}:${sec.id}:${t0}`
    log("nGen:sec:start", { sectionId: sec.id, genType: (sec as any).gen?.type })
    const items: QuizLikeItem[] = await generateSectionItems(sec.gen, seed)
    log("nGen:sec:ok", { sectionId: sec.id, items: items.length, ms: Date.now() - t0 })
    sections.push({ id: sec.id, title: sec.title, durationSec: sec.durationSec, items })
  }
  const payload: ExamPayload = { examId: spec.id, name: spec.name, sections }
  log("nGen:ok", { totalItems: sections.reduce((s, x) => s + x.items.length, 0) })
  return { ...s, payload }
}

const nValidate = async (s: Ctx) => {
  log("nValidate:start")
  if (!s.payload) throw new Error("no payload")
  for (const sec of s.payload.sections) {
    if (!Array.isArray(sec.items) || sec.items.length === 0) throw new Error(`empty section ${sec.id}`)
    for (const it of sec.items) {
      if (typeof it.id !== "number") throw new Error(`bad id in ${sec.id}`)
      if (!it.question || !Array.isArray(it.options) || it.options.length !== 4) throw new Error(`bad item in ${sec.id}`)
      if (typeof it.correct !== "number" || it.correct < 1 || it.correct > 4) throw new Error(`bad correct in ${sec.id}`)
      if (!it.hint || !it.explanation) throw new Error(`bad meta in ${sec.id}`)
    }
  }
  log("nValidate:ok")
  return s
}

const nSave = async (s: Ctx) => {
  log("nSave:start")
  const k = keyOf(JSON.stringify({ examId: s.examId, sourceMaterial: s.sourceMaterial }))
  writeCache(k, s.payload)
  log("nSave:ok", { bytes: JSON.stringify(s.payload).length })
  return s
}

const g = new StateGraph(S)
g.addNode("load", nLoad)
g.addNode("cache", nCache)
g.addNode("gen", nGen)
g.addNode("validate", nValidate)
g.addNode("save", nSave)

const edge = (a: string, b: string) => (g as any).addEdge(a as any, b as any)
edge("__start__", "load")
edge("load", "cache")
edge("cache", "gen")
edge("gen", "validate")
edge("validate", "save")
edge("save", "__end__")

const compiled = g.compile()

export async function handleExam(examId: string, sourceMaterial = ""): Promise<ExamPayload> {
  log("handleExam:invoke", { examId })
  const s = await compiled.invoke({ examId, sourceMaterial, spec: null, payload: null })
  log("handleExam:done", { sections: s.payload?.sections?.length })
  return s.payload as ExamPayload
}
