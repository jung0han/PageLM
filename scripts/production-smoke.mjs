import fs from "node:fs"
import process from "node:process"

const origin = process.argv[process.argv.indexOf("--origin") + 1]
const cookieFile = process.env.PAGELM_SMOKE_COOKIE_FILE || "/srv/secrets/pagelm/smoke.cookie"
if (!origin || !/^https:\/\//.test(origin)) throw new Error("--origin must be an HTTPS origin")
const mode = fs.statSync(cookieFile).mode & 0o777
if (mode !== 0o600) throw new Error("smoke cookie must be mode 0600")
const cookie = fs.readFileSync(cookieFile, "utf8").trim()
if (!/^pagelm_session=[A-Za-z0-9_-]+$/.test(cookie)) throw new Error("smoke cookie format is invalid")
const safe = async (path, init = {}) => {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { ...(init.headers || {}), cookie } })
  if (!response.ok) throw new Error(`smoke request failed: ${path} (${response.status})`)
  return response
}
const readiness = await fetch(`${origin}/health/ready`)
if (!readiness.ok) throw new Error("public readiness failed")
const login = await fetch(`${origin}/auth/login`, { redirect: "manual" })
if (login.status !== 302 || !login.headers.get("location")) throw new Error("login redirect failed")
await safe("/auth/me")
await safe("/chats")
await safe("/shared-namespaces")
const chatResponse = await safe("/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "production smoke" }) })
const chat = await chatResponse.json()
if (!chat.chatId) throw new Error("chat start failed")
await safe("/flashcards")
const WebSocket = (await import("ws")).default
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/chat?chatId=${encodeURIComponent(chat.chatId)}`, { headers: { cookie } })
  const timer = setTimeout(() => { socket.close(); reject(new Error("websocket readiness timeout")) }, 10_000)
  socket.once("message", data => {
    clearTimeout(timer)
    try { if (JSON.parse(data.toString()).type !== "ready") throw new Error("websocket contract failed"); socket.close(); resolve() } catch (error) { reject(error) }
  })
  socket.once("error", reject)
})
console.log(JSON.stringify({ readiness: readiness.status, loginRedirect: true, authenticated: true, cookie: "redacted" }))
