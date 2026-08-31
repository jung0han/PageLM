import crypto from "crypto"
import { emitToAll, emitLarge } from "../../utils/chat/ws"
import { withTimeout } from "../../utils/quiz/promise"
import { handleExam } from "../../services/examlab/generate"
import { loadAllExams } from "../../services/examlab/loader"
import type { ExamPayload } from "../../services/examlab/types"
import {
  completeLearningArtifact,
  createLearningArtifact,
  failLearningArtifact,
  getAuthorizedLearningArtifact,
  publicLearningArtifact,
  resolveAssistantTurnOrigin,
} from "../../learning/artifacts"

const streams = new Map<string, Set<any>>()
const log = (...a: any) => console.log("[exam]", ...a)

function okSpec(x: any) {
  return x && typeof x.id === "string" && typeof x.name === "string" && Array.isArray(x.sections) && x.sections.every((s: any) => s?.gen?.type)
}

export function examRoutes(app: any) {
  app.ws("/ws/exams", async (ws: any, req: any) => {
    const u = new URL(req.url, "http://localhost")
    const runId = u.searchParams.get("runId")
    if (!runId) return ws.close(1008, "runId required")
    if (!await getAuthorizedLearningArtifact("examlab", runId, req.auth.subject)) {
      return ws.close(1008, "exam not found")
    }

    let s = streams.get(runId)
    if (!s) { s = new Set(); streams.set(runId, s) }
    s.add(ws)

    log("ws open", runId, "clients:", s.size)
    try { ws.send(JSON.stringify({ type: "ready", runId })) } catch { }

    ws.on("error", (e: any) => log("ws err", runId, e?.message || e))
    ws.on("close", () => {
      s!.delete(ws)
      if (s!.size === 0) streams.delete(runId)
      log("ws close", runId, "left:", s!.size)
    })

    const iv = setInterval(() => {
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping", t: Date.now() })) } catch { }
    }, 15000)
    ws.on("close", () => clearInterval(iv))
  })

  app.get("/exams", (_req: any, res: any) => {
    try {
      const all = loadAllExams().filter(okSpec)
      const list = all.map(e => ({
        id: e.id,
        name: e.name,
        sections: e.sections.map(s => ({
          id: s.id,
          title: s.title,
          durationSec: s.durationSec,
          gen: { type: s.gen?.type, count: (s.gen as any)?.count ?? ((s.gen as any)?.tasks?.length || 0) }
        }))
      }))
      res.send({ ok: true, exams: list })
    } catch (e: any) {
      log("list err", e?.message || e)
      res.status(500).send({ ok: false, error: e?.message || "internal" })
    }
  })

  app.post("/exam", async (req: any, res: any) => {
    try {
      const examId = String(req.body?.examId || "").trim()
      if (!examId) return res.status(400).send({ ok: false, error: "examId required" })
      const origin = await resolveAssistantTurnOrigin(req.body, req.auth.subject)
      if ((req.body?.chatId || req.body?.assistantTurnId) && !origin) {
        return res.status(404).send({ error: "not found" })
      }

      const runId = crypto.randomUUID()
      await createLearningArtifact(runId, "examlab", req.auth.subject, origin)
      res.status(202).send({ ok: true, runId, stream: `/ws/exams?runId=${runId}` })

      setImmediate(async () => {
        const s = streams.get(runId)
        try {
          emitToAll(s, { type: "phase", value: "generating", examId })
          const payload = await withTimeout(handleExam(examId, origin?.material), 180000, "handleExam")
          await completeLearningArtifact("examlab", runId, { output: payload })
          await emitLarge(s, "exam", { examId, payload }, { id: runId, chunkBytes: 128 * 1024, gzip: false })
          emitToAll(s, { type: "done" })
          log("single done", runId, examId)
        } catch (e: any) {
          await failLearningArtifact("examlab", runId, e)
          log("single err", runId, e?.message || e)
          emitToAll(s, { type: "error", examId, error: e?.message || "failed" })
        }
      })
    } catch (e: any) {
      log("500 single err", e?.message || e)
      res.status(500).send({ ok: false, error: e?.message || "internal" })
    }
  })

  app.get("/exam/:runId", async (req: any, res: any) => {
    const artifact = await getAuthorizedLearningArtifact("examlab", req.params.runId, req.auth.subject)
    if (!artifact) return res.status(404).send({ error: "not found" })
    res.status(artifact.status === "pending" ? 202 : artifact.status === "failed" ? 500 : 200)
      .send({ ok: artifact.status === "ready", artifact: publicLearningArtifact(artifact) })
  })

  app.post("/exams", async (req: any, res: any) => {
    try {
      const runId = crypto.randomUUID()
      await createLearningArtifact(runId, "examlab", req.auth.subject)
      res.status(202).send({ ok: true, runId, stream: `/ws/exams?runId=${runId}` })

      setImmediate(async () => {
        const s = streams.get(runId)
        try {
          const all = loadAllExams().filter(okSpec)
          const outputs: ExamPayload[] = []
          if (!all.length) {
            emitToAll(s, { type: "error", error: "no exams found" })
            return
          }
          emitToAll(s, { type: "phase", value: "generating_all", count: all.length })
          for (const ex of all) {
            try {
              emitToAll(s, { type: "phase", value: "generating", examId: ex.id })
              const payload = await withTimeout(handleExam(ex.id), 180000, `handleExam:${ex.id}`)
              outputs.push(payload)
              await emitLarge(s, "exam", { examId: ex.id, payload }, { id: runId, chunkBytes: 128 * 1024, gzip: false })
            } catch (e: any) {
              log("batch item err", ex.id, e?.message || e)
              emitToAll(s, { type: "error", examId: ex.id, error: e?.message || "failed" })
            }
          }
          emitToAll(s, { type: "done" })
          await completeLearningArtifact("examlab", runId, { output: outputs })
          log("batch done", runId)
        } catch (e: any) {
          await failLearningArtifact("examlab", runId, e)
          log("batch err", runId, e?.message || e)
          emitToAll(s, { type: "error", error: e?.message || "failed" })
        }
      })
    } catch (e: any) {
      log("500 batch err", e?.message || e)
      res.status(500).send({ ok: false, error: e?.message || "internal" })
    }
  })
}
