import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { EventEmitter } from "events"
import WebSocket from "ws"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ActiveQaiPerson, AuthentikOidc, QaiPersonResolver } from "../../auth/types"

process.env.VERTEX_PROJECT_ID = "pagelm-derived-test"
process.env.VERTEX_LOCATION = "asia-northeast3"
process.env.MILVUS_ADDRESS = "milvus.test:19530"
process.env.MILVUS_COLLECTION = "pagelm_chunks"
process.env.LITELLM_BASE_URL = "https://proxy.qai.lge.com/v1"
process.env.LITELLM_API_KEY = "test-litellm-secret"
process.env.LITELLM_DEFAULT_MODEL_ALIAS = "pagelm-default"
process.env.LITELLM_ALLOWED_MODEL_ALIASES = "pagelm-default"
process.env.OPENAI_API_KEY = "test-transcription-out-of-scope"

const milvusRows: any[] = []
let collectionExists = false
let rejectRetrieval = false

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        request: async () => ({ data: { predictions: [{ embeddings: { values: Array(1536).fill(0.25) } }] } }),
      }
    }
  },
}))

vi.mock("@zilliz/milvus2-sdk-node", async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    MilvusClient: class {
      async hasCollection() { return { value: collectionExists } }
      async createCollection() { collectionExists = true; return { error_code: "Success" } }
      async loadCollection() { return { error_code: "Success" } }
      async insert(request: any) { milvusRows.push(...request.data); return { error_code: "Success" } }
      async upsert(request: any) {
        for (const row of request.data) {
          const index = milvusRows.findIndex(existing => existing.chunk_id === row.chunk_id)
          if (index === -1) milvusRows.push(row)
          else milvusRows[index] = row
        }
        return { error_code: "Success" }
      }
      async delete(request: any) {
        const namespace = request.filter.match(/namespace_id == "([^"]+)"/)?.[1]
        for (let index = milvusRows.length - 1; index >= 0; index--) {
          if (!namespace || milvusRows[index].namespace_id === namespace) milvusRows.splice(index, 1)
        }
        return { error_code: "Success" }
      }
      async hybridSearch(request: any) {
        if (rejectRetrieval) throw new Error("derived tools must not search shared material")
        const namespaces = request.filter.match(/namespace_id in \[([^\]]+)\]/)?.[1]
          ?.split(",").map((value: string) => JSON.parse(value.trim()))
        return {
          results: milvusRows
            .filter(row => !namespaces || namespaces.includes(row.namespace_id))
            .slice(0, request.limit)
            .map((row, index) => ({ ...row, id: row.chunk_id, score: 1 - index / 10 })),
        }
      }
    },
  }
})

vi.mock("@langchain/openai", async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    ChatOpenAI: class {
      async invoke(messages: any[]) {
        const prompt = String(messages.at(-1)?.content || "")
        if (prompt.includes("Cornell-style notes")) {
          return { content: JSON.stringify({ title: "Shared lesson", notes: "SHARED-741", summary: "summary", questions: [], answers: [] }) }
        }
        if (prompt.includes("Return only the JSON array")) {
          return { content: JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            question: `Which fact matches SHARED-741 number ${index + 1}?`,
            options: ["A) SHARED-741", "B) OTHER-100", "C) OTHER-200", "D) OTHER-300"],
            correct: 1,
            hint: "Use the shared lesson",
            explanation: "SHARED-741 is stated in the assistant turn.",
          }))) }
        }
        if (prompt.includes("return only json")) {
          return { content: JSON.stringify({
            title: "SHARED-741 podcast",
            summary: "Assistant turn podcast",
            segments: [
              { spk: "A", md: "SHARED-741 is the shared fact." },
              { spk: "B", md: "We learned it from the assistant turn." },
            ],
          }) }
        }
        const context = prompt.match(/Context:\n([\s\S]*?)\n\nQuestion:/)?.[1] || "NO_CONTEXT"
        return { content: JSON.stringify({ topic: "학습 자료", answer: `근거: ${context}`, flashcards: [] }) }
      }
    },
  }
})

vi.mock("node-edge-tts", () => ({
  EdgeTTS: class {
    async ttsPromise(_text: string, outputFile: string) {
      fs.writeFileSync(outputFile, "mock-mp3-segment")
    }
  },
}))

vi.mock("child_process", async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    spawn: (_bin: string, args: string[]) => {
      const process = new EventEmitter() as any
      process.stderr = new EventEmitter()
      setImmediate(() => {
        fs.writeFileSync(args.at(-1)!, "mock-combined-mp3")
        process.emit("close", 0)
      })
      return process
    },
  }
})

function boundaries(people: Record<string, ActiveQaiPerson>): { oidc: AuthentikOidc; personResolver: QaiPersonResolver } {
  return {
    oidc: {
      authorizationUrl: input => `https://auth.example/authorize?state=${encodeURIComponent(input.state)}`,
      async exchangeCode(input) { return { subject: input.code, refreshToken: `refresh-${input.code}`, expiresAt: Date.now() + 60_000 } },
      async refresh(refreshToken) { return { subject: refreshToken.replace(/^refresh-/, ""), refreshToken, expiresAt: Date.now() + 60_000 } },
      async revoke() {},
    },
    personResolver: { async resolveActivePerson(subject) { return people[subject] || null } },
  }
}

async function login(base: string, subject: string) {
  const begin = await fetch(`${base}/auth/login`, { redirect: "manual" })
  const state = new URL(begin.headers.get("location")!).searchParams.get("state")
  const callback = await fetch(`${base}/auth/callback?code=${subject}&state=${state}`, {
    headers: { cookie: begin.headers.get("set-cookie")!.split(";", 1)[0] },
    redirect: "manual",
  })
  return callback.headers.get("set-cookie")!.split(";", 1)[0]
}

function json(method: string, cookie: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }
}

async function waitForAssistant(base: string, cookie: string, chatId: string, count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const detail = await (await fetch(`${base}/chats/${chatId}`, { headers: { cookie } })).json() as any
    const assistants = detail.messages?.filter((message: any) => message.role === "assistant") || []
    if (assistants.length >= count) return assistants.at(-1)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("assistant timeout")
}

async function waitForOk(url: string, cookie: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(url, { headers: { cookie } })
    if (response.status === 200) return response
    if (response.status !== 202) return response
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("artifact timeout")
}

async function runPodcastStream(base: string, cookie: string, pid: string) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/podcast?pid=${encodeURIComponent(pid)}`, {
    headers: { cookie },
  })
  return await new Promise<any[]>((resolve, reject) => {
    const events: any[] = []
    const timer = setTimeout(() => reject(new Error("podcast stream timeout")), 5_000)
    ws.on("message", data => {
      const event = JSON.parse(String(data))
      events.push(event)
      if (event.type === "done") {
        clearTimeout(timer)
        ws.close()
        resolve(events)
      }
      if (event.type === "error") {
        clearTimeout(timer)
        reject(new Error(event.error))
      }
    })
    ws.on("error", reject)
  })
}

async function streamOutcome(base: string, cookie: string, path: string) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}${path}`, { headers: { cookie } })
  return await new Promise<"ready" | "denied">((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stream authorization timeout")), 2_000)
    ws.on("message", data => {
      const event = JSON.parse(String(data))
      if (event.type === "ready") {
        clearTimeout(timer)
        ws.close()
        resolve("ready")
      }
    })
    ws.on("close", code => {
      if (code === 1008) {
        clearTimeout(timer)
        resolve("denied")
      }
    })
    ws.on("error", reject)
  })
}

const servers: any[] = []
const tempDirs: string[] = []

beforeEach(() => {
  milvusRows.length = 0
  collectionExists = false
  rejectRetrieval = false
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(resolve))))
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("chat-originated learning artifacts", () => {
  test("all chat-originated learning tools inherit the assistant turn namespaces and recheck later access", async () => {
    const suffix = crypto.randomUUID()
    const alice = `alice-${suffix}`
    const bob = `bob-${suffix}`
    const collectionId = `derived-${suffix}`
    const namespaceId = `shared:${collectionId}`
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-derived-"))
    tempDirs.push(sourceDir)
    const sourcePath = path.join(sourceDir, "shared.txt")
    fs.writeFileSync(sourcePath, "공유 정책 식별자는 SHARED-741이다.")

    const { absorbArchiveSnapshot } = await import("../../shared/snapshot")
    const organization = `org:quality-${suffix}`
    const snapshot = (subjects: string[], records: any[], organizations: string[] = []) => ({
      snapshotId: `snapshot-${crypto.randomUUID()}`,
      collections: [{
        id: collectionId,
        title: "공유 수업",
        active: true,
        explicitUserSubjects: subjects,
        organizationSubjects: organizations,
        records,
      }],
    })
    const records = [{
      id: `record-${suffix}`,
      title: "공유 정책",
      active: true,
      admitted: true,
      assets: [{
        id: `asset-${suffix}`,
        filename: "shared.txt",
        mimeType: "text/plain",
        sourcePath,
        chunks: [{ id: `chunk-${suffix}`, text: "공유 정책 식별자는 SHARED-741이다." }],
      }],
    }]
    await absorbArchiveSnapshot(snapshot([], records, [organization]))

    const { createApp } = await import("../app")
    const app = createApp(boundaries({
      [alice]: { subject: alice, personId: `person-${alice}`, organizationSubjects: [organization] },
      [bob]: { subject: bob, personId: `person-${bob}` },
    }))
    const server = app.listen(0, "127.0.0.1")
    servers.push(server)
    await new Promise<void>(resolve => server.once("listening", resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${address.port}`
    const aliceCookie = await login(base, alice)
    const bobCookie = await login(base, bob)

    const started = await (await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "수업을 시작해 주세요" }))).json() as any
    await waitForAssistant(base, aliceCookie, started.chatId, 1)
    await fetch(`${base}/chats/${started.chatId}/source-bag`, json("PUT", aliceCookie, { namespaceIds: [namespaceId] }))
    await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "공유 정책을 설명해 주세요", chatId: started.chatId }))
    const assistantTurn = await waitForAssistant(base, aliceCookie, started.chatId, 2)
    expect(assistantTurn).toEqual(expect.objectContaining({ id: expect.any(String), sharedNamespaceIds: [namespaceId] }))

    rejectRetrieval = true
    const created = await fetch(`${base}/smartnotes`, json("POST", aliceCookie, {
      chatId: started.chatId,
      assistantTurnId: assistantTurn.id,
    }))
    expect(created.status).toBe(202)
    const { noteId } = await created.json() as any
    const readable = await waitForOk(`${base}/smartnotes/${noteId}`, aliceCookie)
    expect(readable.status).toBe(200)
    expect(await readable.json()).toEqual(expect.objectContaining({
      ok: true,
      artifact: expect.objectContaining({ kind: "notes", sharedNamespaceIds: [namespaceId] }),
    }))

    const cardCreated = await fetch(`${base}/flashcards`, json("POST", aliceCookie, {
      chatId: started.chatId,
      assistantTurnId: assistantTurn.id,
    }))
    expect(cardCreated.status).toBe(200)
    const { flashcard } = await cardCreated.json() as any
    expect(flashcard).toEqual(expect.objectContaining({ id: expect.any(String), answer: expect.stringContaining("SHARED-741") }))
    expect((await fetch(`${base}/flashcards/${flashcard.id}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/flashcards/${flashcard.id}`, { headers: { cookie: bobCookie } })).status).toBe(404)

    const quizCreated = await fetch(`${base}/quiz`, json("POST", aliceCookie, {
      chatId: started.chatId,
      assistantTurnId: assistantTurn.id,
    }))
    expect(quizCreated.status).toBe(202)
    const { quizId } = await quizCreated.json() as any
    const quizReadable = await waitForOk(`${base}/quiz/${quizId}`, aliceCookie)
    expect(quizReadable.status).toBe(200)
    expect(await quizReadable.json()).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        kind: "quiz",
        sharedNamespaceIds: [namespaceId],
        output: expect.arrayContaining([expect.objectContaining({ question: expect.stringContaining("SHARED-741") })]),
      }),
    }))
    expect((await fetch(`${base}/quiz/${quizId}`, { headers: { cookie: bobCookie } })).status).toBe(404)

    const examCreated = await fetch(`${base}/exam`, json("POST", aliceCookie, {
      examId: "sat",
      chatId: started.chatId,
      assistantTurnId: assistantTurn.id,
    }))
    expect(examCreated.status).toBe(202)
    const { runId } = await examCreated.json() as any
    const examReadable = await waitForOk(`${base}/exam/${runId}`, aliceCookie)
    expect(examReadable.status).toBe(200)
    expect(await examReadable.json()).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({
        kind: "examlab",
        sharedNamespaceIds: [namespaceId],
        output: expect.objectContaining({ sections: expect.arrayContaining([
          expect.objectContaining({ items: expect.arrayContaining([
            expect.objectContaining({ question: expect.stringContaining("SHARED-741") }),
          ]) }),
        ]) }),
      }),
    }))
    expect((await fetch(`${base}/exam/${runId}`, { headers: { cookie: bobCookie } })).status).toBe(404)

    const debateCreated = await fetch(`${base}/debate/start`, json("POST", aliceCookie, {
      position: "for",
      chatId: started.chatId,
      assistantTurnId: assistantTurn.id,
    }))
    expect(debateCreated.status).toBe(200)
    const { debateId } = await debateCreated.json() as any
    const debateReadable = await fetch(`${base}/debate/${debateId}`, { headers: { cookie: aliceCookie } })
    expect(debateReadable.status).toBe(200)
    expect(await debateReadable.json()).toEqual(expect.objectContaining({
      session: expect.objectContaining({ topic: expect.stringContaining("SHARED-741") }),
    }))
    expect((await fetch(`${base}/debate/${debateId}`, { headers: { cookie: bobCookie } })).status).toBe(404)

    const podcastCreated = await fetch(`${base}/podcast`, json("POST", aliceCookie, {
      title: "Shared lesson",
      chatId: started.chatId,
      assistantTurnId: assistantTurn.id,
    }))
    expect(podcastCreated.status).toBe(202)
    const { pid } = await podcastCreated.json() as any
    const podcastEvents = await runPodcastStream(base, aliceCookie, pid)
    expect(podcastEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "script", data: expect.objectContaining({ title: expect.stringContaining("SHARED-741") }) }),
      expect.objectContaining({ type: "audio", file: expect.stringContaining(`/podcast/download/${pid}/Shared_lesson.mp3`) }),
    ]))
    expect((await fetch(`${base}/podcast/${pid}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/podcast/${pid}`, { headers: { cookie: bobCookie } })).status).toBe(404)

    const streamPaths = [
      `/ws/smartnotes?noteId=${noteId}`,
      `/ws/quiz?quizId=${quizId}`,
      `/ws/exams?runId=${runId}`,
      `/ws/debate?debateId=${debateId}`,
      `/ws/podcast?pid=${pid}`,
    ]
    for (const streamPath of streamPaths) {
      expect(await streamOutcome(base, aliceCookie, streamPath)).toBe("ready")
      expect(await streamOutcome(base, bobCookie, streamPath)).toBe("denied")
    }

    await absorbArchiveSnapshot(snapshot([], records, [organization]))
    expect((await fetch(`${base}/smartnotes/${noteId}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/smartnotes/${noteId}`, { headers: { cookie: bobCookie } })).status).toBe(404)
    expect((await fetch(`${base}/smartnotes/${noteId}/download`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/quiz/${quizId}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/exam/${runId}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/debate/${debateId}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/podcast/${pid}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}/podcast/download/${pid}/Shared_lesson.mp3`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    const bag = await (await fetch(`${base}/flashcards`, { headers: { cookie: aliceCookie } })).json() as any
    expect(bag.flashcards).toEqual(expect.arrayContaining([expect.objectContaining({ id: flashcard.id })]))

    await absorbArchiveSnapshot(snapshot([], [], []))
    expect((await fetch(`${base}/smartnotes/${noteId}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/smartnotes/${noteId}/download`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/flashcards/${flashcard.id}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/quiz/${quizId}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/exam/${runId}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/debate/${debateId}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/podcast/${pid}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    expect((await fetch(`${base}/podcast/download/${pid}/Shared_lesson.mp3`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    for (const streamPath of streamPaths) {
      expect(await streamOutcome(base, aliceCookie, streamPath)).toBe("denied")
    }
    expect((await (await fetch(`${base}/flashcards`, { headers: { cookie: aliceCookie } })).json() as any).flashcards).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: flashcard.id })]),
    )
  }, 30_000)

  test("topic-only tools remain independent of shared-material retrieval", async () => {
    const suffix = crypto.randomUUID()
    const alice = `topic-${suffix}`
    const { createApp } = await import("../app")
    const app = createApp(boundaries({ [alice]: { subject: alice, personId: `person-${alice}` } }))
    const server = app.listen(0, "127.0.0.1")
    servers.push(server)
    await new Promise<void>(resolve => server.once("listening", resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${address.port}`
    const cookie = await login(base, alice)
    rejectRetrieval = true

    const note = await (await fetch(`${base}/smartnotes`, json("POST", cookie, { topic: "SHARED-741" }))).json() as any
    expect((await waitForOk(`${base}/smartnotes/${note.noteId}`, cookie)).status).toBe(200)

    const card = await (await fetch(`${base}/flashcards`, json("POST", cookie, {
      question: "Topic-only question",
      answer: "Topic-only answer",
      tag: "topic",
    }))).json() as any
    expect((await fetch(`${base}/flashcards/${card.flashcard.id}`, { headers: { cookie } })).status).toBe(200)

    const quiz = await (await fetch(`${base}/quiz`, json("POST", cookie, { topic: "SHARED-741" }))).json() as any
    expect((await waitForOk(`${base}/quiz/${quiz.quizId}`, cookie)).status).toBe(200)

    const exam = await (await fetch(`${base}/exam`, json("POST", cookie, { examId: "sat" }))).json() as any
    expect((await waitForOk(`${base}/exam/${exam.runId}`, cookie)).status).toBe(200)

    const debate = await (await fetch(`${base}/debate/start`, json("POST", cookie, {
      topic: "SHARED-741",
      position: "against",
    }))).json() as any
    expect((await fetch(`${base}/debate/${debate.debateId}`, { headers: { cookie } })).status).toBe(200)

    const podcast = await (await fetch(`${base}/podcast`, json("POST", cookie, { topic: "SHARED-741" }))).json() as any
    await runPodcastStream(base, cookie, podcast.pid)
    expect((await fetch(`${base}/podcast/${podcast.pid}`, { headers: { cookie } })).status).toBe(200)

    const artifactUrls = [
      `${base}/smartnotes/${note.noteId}`,
      `${base}/quiz/${quiz.quizId}`,
      `${base}/exam/${exam.runId}`,
      `${base}/podcast/${podcast.pid}`,
    ]
    for (const url of artifactUrls) {
      const payload = await (await fetch(url, { headers: { cookie } })).json() as any
      expect(payload.artifact.sharedNamespaceIds).toEqual([])
    }
  }, 30_000)
})
