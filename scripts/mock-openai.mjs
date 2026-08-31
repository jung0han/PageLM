import http from "node:http"
import crypto from "node:crypto"

const port = Number(process.env.PORT || 4010)

function vector(input) {
  const hash = crypto.createHash("sha256").update(String(input)).digest()
  return Array.from(hash.subarray(0, 16), value => (value - 127.5) / 127.5)
}

function vertexVector(input) {
  const base = vector(input)
  return Array.from({ length: 1536 }, (_, index) => base[index % base.length])
}

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(payload))
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true })
  if (req.method === "GET" && req.url?.startsWith("/oidc/authorize")) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const callback = new URL(url.searchParams.get("redirect_uri"))
    callback.searchParams.set("code", "candidate-person")
    callback.searchParams.set("state", url.searchParams.get("state") || "")
    res.writeHead(302, { location: callback.toString() })
    return res.end()
  }
  if (req.method === "GET" && req.url === "/oidc/userinfo") {
    return send(res, 200, { sub: "candidate-person" })
  }
  if (req.method === "GET" && req.url?.startsWith("/qai/person")) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const subject = url.searchParams.get("authentik_sub")
    if (subject !== "candidate-person") return send(res, 404, { error: "not found" })
    return send(res, 200, {
      id: "candidate-qai-person",
      authentikSub: subject,
      classification: "person",
      active: true,
      scimDeleted: false,
      organizationSubjects: ["org:candidate"],
    })
  }
  let body = ""
  req.on("data", chunk => { body += chunk })
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/oidc/token") {
      return send(res, 200, {
        access_token: "candidate-access-token",
        refresh_token: "candidate-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      })
    }
    if (req.method === "POST" && req.url === "/oidc/revoke") return send(res, 200, { ok: true })
    let input
    try { input = JSON.parse(body || "{}") } catch { return send(res, 400, { error: { message: "invalid JSON" } }) }

    if (req.method === "POST" && req.url?.includes("/publishers/google/models/gemini-embedding-001:predict")) {
      const instances = Array.isArray(input.instances) ? input.instances : []
      return send(res, 200, {
        predictions: instances.map(instance => ({ embeddings: { values: vertexVector(instance.content) } })),
      })
    }

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
