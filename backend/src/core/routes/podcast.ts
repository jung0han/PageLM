import path from "path"
import fs from "fs"
import { makeScript, makeAudio } from "../../services/podcast"
import { emitToAll } from "../../utils/chat/ws"
import { config } from "../../config/env"
import {
  completeLearningArtifact,
  createLearningArtifact,
  failLearningArtifact,
  getAuthorizedLearningArtifact,
  publicLearningArtifact,
  resolveAssistantTurnOrigin,
} from "../../learning/artifacts"

const sockets = new Map<string, Set<any>>()
const pendingJobs = new Map<string, () => Promise<void>>()

function emit(id: string, msg: any) {
  const s = sockets.get(id)
  emitToAll(s, msg)
}

async function startJobIfReady(pid: string) {
  const job = pendingJobs.get(pid)
  const hasSockets = sockets.has(pid) && sockets.get(pid)!.size > 0
  
  if (job && hasSockets) {
    pendingJobs.delete(pid)
    try {
      await job()
    } catch (err) {
      emit(pid, { type: "error", error: String(err) })
    }
  }
}

export function podcastRoutes(app: any) {
  app.ws("/ws/podcast", async (ws: any, req: any) => {
    const u = new URL(req.url, config.baseUrl || "http://dummy")
    const pid = u.searchParams.get("pid")
    
    if (!pid) {
      return ws.close(1008, "pid required")
    }
    if (!await getAuthorizedLearningArtifact("podcast", pid, req.auth.subject)) {
      return ws.close(1008, "podcast not found")
    }
    
    let set = sockets.get(pid)
    if (!set) {
      set = new Set()
      sockets.set(pid, set)
    }
    set.add(ws)
    
    ws.on("close", () => {
      set!.delete(ws)
      if (set!.size === 0) {
        sockets.delete(pid)
      }
    })
    
    const readyMsg = JSON.stringify({ type: "ready", pid })
    ws.send(readyMsg)
    
    setTimeout(() => {
      startJobIfReady(pid).catch(err => {
        console.error(`[Podcast WS] Error starting job:`, err)
      })
    }, 100)
  })

  app.post("/podcast", async (req: any, res: any, next: any) => {
    try {
      const origin = await resolveAssistantTurnOrigin(req.body, req.auth.subject)
      if ((req.body?.chatId || req.body?.assistantTurnId) && !origin) {
        return res.status(404).send({ error: "not found" })
      }
      const topic = String(req.body?.topic || req.body?.title || origin?.material || "").trim()
      
      if (!topic) {
        return res.status(400).send({ error: "topic required" })
      }

      const pid = cryptoRandom()
      const dir = path.join(process.cwd(), "storage", "podcasts", pid)
      const base = topic.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "podcast"
      await createLearningArtifact(pid, "podcast", req.auth.subject, origin)

      res.status(202).send({ ok: true, pid, stream: `/ws/podcast?pid=${pid}` })

      const job = async () => {
        try {
          const script = await makeScript(origin?.material || topic, topic)
          emit(pid, { type: "script", data: script })

          const outPath = await makeAudio(script, dir, base, (m) => {
            emit(pid, m)
          })
          if (!fs.existsSync(outPath)) {
            throw new Error(`Audio file not created at ${outPath}`)
          }
          const filename = path.basename(outPath)
          const downloadUrl = `${config.baseUrl}/podcast/download/${pid}/${filename}`
          await completeLearningArtifact("podcast", pid, { output: script, file: outPath })
          
          const audioMessage = { 
            type: "audio", 
            file: downloadUrl,
            filename: filename,
          }
          emit(pid, audioMessage)
          
          emit(pid, { type: "done" })
        } catch (e: any) {
          await failLearningArtifact("podcast", pid, e)
          emit(pid, { type: "error", error: e?.message || "failed" })
        }
      }
      
      pendingJobs.set(pid, job)
      
      startJobIfReady(pid).catch(err => {
        console.error(`[Podcast POST] Error starting job:`, err)
      })
    } catch (e) {
      next(e)
    }
  })

  app.get("/podcast/:pid", async (req: any, res: any) => {
    const artifact = await getAuthorizedLearningArtifact("podcast", req.params.pid, req.auth.subject)
    if (!artifact) return res.status(404).send({ error: "not found" })
    res.status(artifact.status === "pending" ? 202 : artifact.status === "failed" ? 500 : 200)
      .send({ ok: artifact.status === "ready", artifact: publicLearningArtifact(artifact) })
  })

  app.get("/podcast/download/:pid/:filename", async (req: any, res: any, next: any) => {
    try {
      const { pid, filename } = req.params
      const artifact = await getAuthorizedLearningArtifact("podcast", pid, req.auth.subject)
      if (!artifact?.file || artifact.status !== "ready") return res.status(404).send({ error: "not found" })
      if (path.basename(artifact.file).toLowerCase() !== filename.toLowerCase()) {
        return res.status(404).send({ error: "not found" })
      }
      const dirPath = path.join(process.cwd(), "storage", "podcasts", pid)
      if (fs.existsSync(dirPath)) {
        const filesInDir = fs.readdirSync(dirPath)
        const actualFilename = filesInDir.find(f => f.toLowerCase() === filename.toLowerCase())
        if (actualFilename) {
          const filePath = path.join(dirPath, actualFilename)
          const fileStats = fs.statSync(filePath)
          
          res.setHeader('Content-Type', 'audio/mpeg')
          res.setHeader('Content-Disposition', `attachment; filename="${actualFilename}"`)
          res.setHeader('Content-Length', fileStats.size)

          const fileStream = fs.createReadStream(filePath)
          fileStream.pipe(res)
          fileStream.on('error', (err) => {
            if (!res.headersSent) {
              res.status(500).send({ error: 'Download failed' })
            }
          })
          return
        }
      }
      
      return res.status(404).send({ error: "File not found" })
    } catch (e) {
      next(e)
    }
  })
}

function cryptoRandom() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
