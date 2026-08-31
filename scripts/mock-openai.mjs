import http from "node:http"
import crypto from "node:crypto"

const port = Number(process.env.PORT || 4010)

function vector(input) {
  const hash = crypto.createHash("sha256").update(String(input)).digest()
  return Array.from(hash.subarray(0, 16), value => (value - 127.5) / 127.5)
}

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(payload))
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true })
  let body = ""
  req.on("data", chunk => { body += chunk })
  req.on("end", () => {
    let input
    try { input = JSON.parse(body || "{}") } catch { return send(res, 400, { error: { message: "invalid JSON" } }) }

    if (req.method === "POST" && req.url?.endsWith("/embeddings")) {
      const values = Array.isArray(input.input) ? input.input : [input.input]
      return send(res, 200, {
        object: "list",
        model: input.model || "candidate-embedding",
        data: values.map((value, index) => ({ object: "embedding", index, embedding: vector(value) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    }

    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      const prompt = input.messages?.at(-1)?.content || ""
      const context = String(prompt).match(/Context:\n([\s\S]*?)\n\nQuestion:/)?.[1] || "NO_CONTEXT"
      const question = String(prompt).match(/Question:\n([\s\S]*?)\n\nTopic:/)?.[1] || "candidate smoke"
      const content = JSON.stringify({
        topic: "candidate smoke",
        answer: `Deterministic candidate answer for: ${question}\n\nContext: ${context}`,
        flashcards: [],
      })
      return send(res, 200, {
        id: "chatcmpl-candidate",
        object: "chat.completion",
        created: 0,
        model: input.model || "candidate-chat",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }

    send(res, 404, { error: { message: "not found" } })
  })
}).listen(port, "0.0.0.0", () => console.log(`[candidate-mock] listening on ${port}`))
