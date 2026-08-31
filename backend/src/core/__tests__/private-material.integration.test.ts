import crypto from "crypto"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ActiveQaiPerson, AuthentikOidc, QaiPersonResolver } from "../../auth/types"

process.env.VERTEX_PROJECT_ID = "pagelm-test"
process.env.VERTEX_LOCATION = "asia-northeast3"
process.env.MILVUS_ADDRESS = "milvus.test:19530"
process.env.MILVUS_COLLECTION = "pagelm_chunks"
process.env.LITELLM_BASE_URL = "https://proxy.qai.lge.com/v1"
process.env.LITELLM_API_KEY = "test-litellm-secret"
process.env.LITELLM_DEFAULT_MODEL_ALIAS = "pagelm-default"
process.env.LITELLM_ALLOWED_MODEL_ALIASES = "pagelm-default,pagelm-fast"
process.env.OPENAI_API_KEY = "test-transcription-out-of-scope"

const vertexRequests: any[] = []
const milvusHybridRequests: any[] = []
const milvusRows: any[] = []
const generationOptions: any[] = []
let collectionExists = false

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        request: async (request: any) => {
          vertexRequests.push(request)
          const text = request.data.instances[0].content
          const seed = crypto.createHash("sha256").update(text).digest()[0] / 255
          return { data: { predictions: [{ embeddings: { values: Array(1536).fill(seed) } }] } }
        },
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
      async hybridSearch(request: any) {
        milvusHybridRequests.push(request)
        const owner = request.filter.match(/owner_subject == "([^"]+)"/)?.[1]
        const namespace = request.filter.match(/namespace_id == "([^"]+)"/)?.[1]
        return {
          results: milvusRows
            .filter(row => row.owner_subject === owner && row.namespace_id === namespace)
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
      constructor(options: any) { generationOptions.push(options) }
      async invoke(messages: any[]) {
        const prompt = String(messages.at(-1)?.content || "")
        const context = prompt.match(/Context:\n([\s\S]*?)\n\nQuestion:/)?.[1] || "NO_CONTEXT"
        return { content: JSON.stringify({ topic: "private material", answer: `근거: ${context}`, flashcards: [] }) }
      }
    },
  }
})

function fakeBoundaries(subject: string): { oidc: AuthentikOidc; personResolver: QaiPersonResolver } {
  const person: ActiveQaiPerson = { subject, personId: `qai-${subject}` }
  return {
    oidc: {
      authorizationUrl: input => `https://auth.example/authorize?state=${encodeURIComponent(input.state)}`,
      async exchangeCode(input) { return { subject: input.code, refreshToken: `refresh-${input.code}`, expiresAt: Date.now() + 60_000 } },
      async refresh(refreshToken) { return { subject: refreshToken.replace(/^refresh-/, ""), refreshToken, expiresAt: Date.now() + 60_000 } },
      async revoke() {},
    },
    personResolver: { async resolveActivePerson(candidate) { return candidate === subject ? person : null } },
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

const servers: any[] = []
beforeEach(() => {
  vertexRequests.length = 0
  milvusHybridRequests.length = 0
  milvusRows.length = 0
  generationOptions.length = 0
  collectionExists = false
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(resolve))))
})

describe("rag.search personal namespace", () => {
  test("returns only dense plus BM25 matches for the authenticated owner and chat", async () => {
    const { indexPersonalChunks } = await import("../../rag/runtime")
    const { Ragsearch } = await import("../../agents/tools/Ragsearch")
    await indexPersonalChunks({
      ownerSubject: "alice",
      namespace: "chat:chat-a",
      assetId: "asset-a",
      filename: "policy.txt",
      chunks: ["프로젝트 오로라의 식별자는 AURORA-317이다."],
    })

    const found = await Ragsearch.run({ q: "AURORA-317", ns: "chat:chat-a", k: 10 }, { ownerSubject: "alice" } as any)
    const wrongOwner = await Ragsearch.run({ q: "AURORA-317", ns: "chat:chat-a", k: 10 }, { ownerSubject: "bob" } as any)
    const wrongChat = await Ragsearch.run({ q: "AURORA-317", ns: "chat:chat-b", k: 10 }, { ownerSubject: "alice" } as any)

    expect(found).toEqual([{ text: "프로젝트 오로라의 식별자는 AURORA-317이다.", meta: expect.objectContaining({ filename: "policy.txt", assetId: "asset-a" }) }])
    expect(wrongOwner).toEqual([{ text: "" }])
    expect(wrongChat).toEqual([{ text: "" }])
    expect(vertexRequests).toHaveLength(4)
    expect(vertexRequests.every(request => request.url.endsWith("/publishers/google/models/gemini-embedding-001:predict"))).toBe(true)
    expect(vertexRequests.every(request => request.data.parameters.outputDimensionality === 1536)).toBe(true)
    expect(vertexRequests[0].data.instances[0].task_type).toBe("RETRIEVAL_DOCUMENT")
    expect(vertexRequests[1].data.instances[0].task_type).toBe("RETRIEVAL_QUERY")
    expect(milvusHybridRequests[0]).toEqual(expect.objectContaining({
      filter: 'owner_subject == "alice" && namespace_id == "chat:chat-a"',
      limit: 10,
      output_fields: expect.arrayContaining(["chunk_id", "content", "filename", "asset_id"]),
      data: [
        expect.objectContaining({ anns_field: "dense_vector" }),
        expect.objectContaining({ anns_field: "bm25_vector", data: "AURORA-317" }),
      ],
    }))
  })
})

describe("private material public flow", () => {
  test("does not reuse an answer cache entry across model aliases", async () => {
    const { askWithContext } = await import("../../lib/ai/ask")
    const question = `cache alias ${crypto.randomUUID()}`
    await askWithContext({ question, context: "same source", modelAlias: "pagelm-default" })
    await askWithContext({ question, context: "same source", modelAlias: "pagelm-fast" })
    expect(generationOptions.map(options => options.model)).toEqual(["pagelm-default", "pagelm-fast"])
  })

  test("upload, index, retrieve, answer, and authenticated citation complete through HTTP", async () => {
    const subject = `alice-${crypto.randomUUID()}`
    const { createApp } = await import("../app")
    const app = createApp(fakeBoundaries(subject))
    const server = app.listen(0, "127.0.0.1")
    servers.push(server)
    await new Promise<void>(resolve => server.once("listening", resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${address.port}`
    const cookie = await login(base, subject)

    const models = await fetch(`${base}/models`, { headers: { cookie } })
    const modelPayload = await models.json()
    expect(modelPayload).toEqual({ ok: true, defaultAlias: "pagelm-default", aliases: ["pagelm-default", "pagelm-fast"] })

    const upload = new FormData()
    upload.set("q", "오로라 프로젝트의 식별자는 무엇인가요?")
    upload.set("model", "pagelm-fast")
    upload.set("file", new Blob(["프로젝트 오로라의 식별자는 AURORA-317이다."], { type: "text/plain" }), "aurora.txt")
    const started = await fetch(`${base}/chat`, { method: "POST", headers: { cookie }, body: upload })
    expect(started.status).toBe(202)
    const { chatId } = await started.json() as any

    let detail: any
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${base}/chats/${chatId}`, { headers: { cookie } })
      detail = await response.json()
      if (detail.messages?.some((message: any) => message.role === "assistant")) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const answer = detail.messages.at(-1).content
    expect(answer.answer).toContain("AURORA-317")
    expect(answer.citations).toEqual([expect.objectContaining({ filename: "aurora.txt", url: expect.stringMatching(new RegExp(`^/chats/${chatId}/assets/`)) })])
    const citation = await fetch(`${base}${answer.citations[0].url}`, { headers: { cookie } })
    expect(citation.status).toBe(200)
    expect(await citation.text()).toBe("프로젝트 오로라의 식별자는 AURORA-317이다.")

    expect(generationOptions).toContainEqual(expect.objectContaining({
      model: "pagelm-fast",
      apiKey: "test-litellm-secret",
      configuration: { baseURL: "https://proxy.qai.lge.com/v1" },
    }))
    expect(JSON.stringify(modelPayload)).not.toContain("test-litellm-secret")
  })
})
