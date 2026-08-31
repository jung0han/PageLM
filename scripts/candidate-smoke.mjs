import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const backend = option("--backend") || process.env.CANDIDATE_BACKEND_URL || "http://127.0.0.1:15000"
const frontend = option("--frontend") || process.env.CANDIDATE_FRONTEND_URL || "http://127.0.0.1:15173"
const persistenceFile = option("--persistence-file")
const fixture = path.resolve(new URL("./fixtures/candidate-sentinel.txt", import.meta.url).pathname)
const sentinel = fs.readFileSync(fixture, "utf8").trim().split(/\s+/)[0]
const transcript = []
let sessionCookie = ""

function record(step, details) {
  transcript.push({ step, ...details })
  process.stdout.write(`${step}: ${JSON.stringify(details)}\n`)
}

async function request(url, init = {}) {
  const headers = new Headers(init.headers || {})
  if (sessionCookie) headers.set("cookie", sessionCookie)
  const response = await fetch(url, { ...init, headers })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${url} -> ${response.status}: ${text}`)
  return body
}

async function login() {
  const begin = await fetch(`${backend}/auth/login`, { redirect: "manual" })
  if (begin.status !== 302) throw new Error(`Login did not redirect: ${begin.status}`)
  const provider = await fetch(begin.headers.get("location"), { redirect: "manual" })
  if (provider.status !== 302) throw new Error(`Authentik stub did not redirect: ${provider.status}`)
  const callback = await fetch(provider.headers.get("location"), {
    headers: { cookie: begin.headers.get("set-cookie")?.split(";", 1)[0] || "" },
    redirect: "manual",
  })
  if (callback.status !== 302) throw new Error(`OIDC callback failed: ${callback.status}`)
  sessionCookie = callback.headers.get("set-cookie")?.split(";", 1)[0] || ""
  if (!sessionCookie) throw new Error("OIDC callback omitted the opaque session cookie")
  const me = await request(`${backend}/auth/me`)
  record("authentication", { personId: me.person?.id, opaqueCookie: true })
}

async function pollAssistant(chatId, requiredText) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const detail = await request(`${backend}/chats/${chatId}`)
    const assistant = detail.messages?.findLast?.(message => message.role === "assistant")
    if (assistant) {
      const payload = assistant.content
      if (!payload || typeof payload !== "object" || typeof payload.answer !== "string") {
        throw new Error(`Assistant payload is not structured: ${JSON.stringify(payload)}`)
      }
      if (requiredText && !payload.answer.includes(requiredText)) {
        throw new Error(`Assistant answer did not contain ${requiredText}: ${payload.answer}`)
      }
      return { detail, assistant }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for assistant message in ${chatId}`)
}

const live = await request(`${backend}/health/live`)
const ready = await request(`${backend}/health/ready`)
if (ready.checks?.storage !== "ok" || ready.checks?.sqlite !== "ok") throw new Error("Readiness contract is incomplete")
record("health", { live, ready })

const front = await fetch(`${frontend}/`)
if (!front.ok || !(await front.text()).includes("<div id=\"root\"></div>")) throw new Error("Frontend root did not load")
record("frontend", { status: front.status })

await login()

const chatQuestion = `candidate-chat-${crypto.randomUUID()}`
const chat = await request(`${backend}/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ q: chatQuestion }),
})
const chatResult = await pollAssistant(chat.chatId, chatQuestion)
if (!chatResult.detail.messages.some(message => message.role === "user" && message.content === chatQuestion)) {
  throw new Error("Original user message was not persisted")
}
record("chat", { chatId: chat.chatId, structuredAssistant: true })

const form = new FormData()
form.set("q", `Repeat the unique identifier ${sentinel} from the uploaded context.`)
form.set("file", new Blob([fs.readFileSync(fixture)], { type: "text/plain" }), path.basename(fixture))
const upload = await request(`${backend}/chat`, { method: "POST", body: form })
const uploadResult = await pollAssistant(upload.chatId, sentinel)
const citation = uploadResult.assistant.content.citations?.[0]
if (!citation?.url) throw new Error("Personal upload answer omitted an authenticated citation")
const unauthenticatedCitation = await fetch(`${backend}${citation.url}`)
if (unauthenticatedCitation.status !== 401) throw new Error(`Citation was readable without a session: ${unauthenticatedCitation.status}`)
const citedAsset = await request(`${backend}${citation.url}`)
if (!String(citedAsset).includes(sentinel)) throw new Error("Authenticated citation did not return the uploaded asset")
record("personal-upload", { chatId: upload.chatId, sentinel, authenticatedCitation: true })

const cardPayload = {
  question: `candidate-card-${crypto.randomUUID()}`,
  answer: "DONGWOO-1113",
  tag: "candidate-smoke",
}
const created = await request(`${backend}/flashcards`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(cardPayload),
})
const listed = await request(`${backend}/flashcards`)
if (!listed.flashcards.some(card => card.id === created.flashcard.id)) throw new Error("Created Learning Bag item was not listed")
await request(`${backend}/flashcards/${created.flashcard.id}`, { method: "DELETE" })
const afterDelete = await request(`${backend}/flashcards`)
if (afterDelete.flashcards.some(card => card.id === created.flashcard.id)) throw new Error("Deleted Learning Bag item remains")
record("learning-bag-crud", { id: created.flashcard.id })

if (persistenceFile) {
  if (fs.existsSync(persistenceFile)) {
    const expectedId = fs.readFileSync(persistenceFile, "utf8").trim()
    const cards = await request(`${backend}/flashcards`)
    if (!cards.flashcards.some(card => card.id === expectedId)) throw new Error(`Persistent card ${expectedId} was lost`)
    await request(`${backend}/flashcards/${expectedId}`, { method: "DELETE" })
    fs.rmSync(persistenceFile)
    record("learning-bag-persistence", { id: expectedId, persisted: true, cleaned: true })
  } else {
    const persistent = await request(`${backend}/flashcards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "candidate-redeploy", answer: "persists", tag: "candidate-smoke" }),
    })
    fs.writeFileSync(persistenceFile, `${persistent.flashcard.id}\n`, { flag: "wx" })
    record("learning-bag-persistence", { id: persistent.flashcard.id, awaitingRedeploy: true })
  }
}

record("complete", { backend, frontend, transcriptEntries: transcript.length })
