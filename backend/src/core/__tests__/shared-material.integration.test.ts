import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import WebSocket from "ws"
import type { ActiveQaiPerson, AuthentikOidc, QaiPersonResolver } from "../../auth/types"

process.env.VERTEX_PROJECT_ID = "pagelm-shared-test"
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

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        request: async (request: any) => {
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
      async upsert(request: any) {
        for (const row of request.data) {
          const index = milvusRows.findIndex(existing => existing.chunk_id === row.chunk_id)
          if (index === -1) milvusRows.push(row)
          else milvusRows[index] = row
        }
        return { error_code: "Success" }
      }
      async hybridSearch(request: any) {
        const owner = request.filter.match(/owner_subject == "([^"]*)"/)?.[1]
        const namespaces = request.filter.match(/namespace_id in \[([^\]]+)\]/)?.[1]
          ?.split(",").map((value: string) => JSON.parse(value.trim()))
        const namespace = request.filter.match(/namespace_id == "([^"]+)"/)?.[1]
        return {
          results: milvusRows
            .filter(row => owner === undefined || row.owner_subject === owner)
            .filter(row => namespaces ? namespaces.includes(row.namespace_id) : row.namespace_id === namespace)
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
        const context = prompt.match(/Context:\n([\s\S]*?)\n\nQuestion:/)?.[1] || "NO_CONTEXT"
        return { content: JSON.stringify({ topic: "학습 자료", answer: `근거: ${context}`, flashcards: [] }) }
      }
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
    if (assistants.length >= count) return assistants.at(-1).content
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("assistant timeout")
}

const servers: any[] = []
const tempDirs: string[] = []

beforeEach(() => {
  milvusRows.length = 0
  collectionExists = false
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(resolve))))
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("shared namespace public flow", () => {
  test("absorbs one admitted snapshot and enforces picker, source bag, search, and private asset grants", async () => {
    const suffix = crypto.randomUUID()
    const alice = `alice-${suffix}`
    const bob = `bob-${suffix}`
    const collectionId = `collection-${suffix}`
    const namespaceId = `shared:${collectionId}`
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-archive-snapshot-"))
    tempDirs.push(sourceDir)
    const sharedSource = path.join(sourceDir, "shared.txt")
    fs.writeFileSync(sharedSource, "공유 정책 식별자는 SHARED-741이다.")

    const { absorbArchiveSnapshot } = await import("../../shared/snapshot")
    const report = await absorbArchiveSnapshot({
      snapshotId: `snapshot-${suffix}`,
      collections: [
        {
          id: collectionId,
          title: "품질 정책",
          description: "승인된 정책 자료",
          active: true,
          explicitUserSubjects: [alice],
          records: [
            {
              id: `record-current-${suffix}`,
              title: "오로라 정책",
              description: "현재 승인본",
              active: true,
              admitted: true,
              assets: [{
                id: `asset-${suffix}`,
                filename: "shared.txt",
                mimeType: "text/plain",
                sourcePath: sharedSource,
                chunks: [{ id: `chunk-${suffix}`, text: "공유 정책 식별자는 SHARED-741이다." }],
              }],
            },
            {
              id: `record-unreviewed-${suffix}`,
              title: "미승인 자료",
              active: true,
              admitted: false,
              assets: [{ id: "excluded", filename: "excluded.txt", mimeType: "text/plain", sourcePath: sharedSource, chunks: [{ id: "excluded", text: "EXCLUDED" }] }],
            },
          ],
        },
        {
          id: `inactive-${suffix}`,
          title: "비활성 자료실",
          active: false,
          explicitUserSubjects: [alice],
          records: [],
        },
      ],
    })
    expect(report).toEqual({
      snapshotId: `snapshot-${suffix}`,
      namespaces: 1,
      materials: 1,
      assets: 1,
      searchRows: 1,
      grantRows: 1,
      denseVectorsReused: 0,
      denseVectorsEmbedded: 1,
      bm25Rebuilt: true,
      privateAssetsCopied: 1,
    })

    // From this point onward the Archive-side snapshot source no longer exists.
    fs.rmSync(sourceDir, { recursive: true, force: true })

    const { createApp } = await import("../app")
    const app = createApp(boundaries({
      [alice]: { subject: alice, personId: `person-${alice}` },
      [bob]: { subject: bob, personId: `person-${bob}` },
    }))
    const server = app.listen(0, "127.0.0.1")
    servers.push(server)
    await new Promise<void>(resolve => server.once("listening", resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${address.port}`
    const aliceCookie = await login(base, alice)
    const bobCookie = await login(base, bob)

    const alicePicker = await (await fetch(`${base}/shared-namespaces`, { headers: { cookie: aliceCookie } })).json() as any
    expect(alicePicker.namespaces).toEqual([expect.objectContaining({ id: namespaceId, title: "품질 정책" })])
    const bobPicker = await (await fetch(`${base}/shared-namespaces`, { headers: { cookie: bobCookie } })).json() as any
    expect(bobPicker.namespaces).toEqual([])

    const materials = await (await fetch(`${base}/shared-namespaces/${encodeURIComponent(namespaceId)}/materials`, { headers: { cookie: aliceCookie } })).json() as any
    expect(materials.materials).toEqual([expect.objectContaining({
      title: "오로라 정책",
      description: "현재 승인본",
      provenance: { archiveCollectionId: collectionId, archiveRecordId: `record-current-${suffix}` },
      assets: [expect.objectContaining({ filename: "shared.txt", chunks: [{ id: `chunk-${suffix}`, text: "공유 정책 식별자는 SHARED-741이다." }] })],
    })])
    expect((await fetch(`${base}/shared-namespaces/${encodeURIComponent(namespaceId)}/materials`, { headers: { cookie: bobCookie } })).status).toBe(404)

    const personal = new FormData()
    personal.set("q", "개인 자료를 기억해 주세요")
    personal.set("file", new Blob(["개인 식별자는 PERSONAL-902이다."], { type: "text/plain" }), "personal.txt")
    const started = await fetch(`${base}/chat`, { method: "POST", headers: { cookie: aliceCookie }, body: personal })
    const { chatId } = await started.json() as any
    await waitForAssistant(base, aliceCookie, chatId, 1)

    const selected = await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", aliceCookie, { namespaceIds: [namespaceId] }))
    expect(await selected.json()).toEqual({ ok: true, namespaceIds: [namespaceId] })
    expect((await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", aliceCookie, { namespaceIds: [`shared:missing-${suffix}`] }))).status).toBe(404)
    expect((await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", bobCookie, { namespaceIds: [namespaceId] }))).status).toBe(404)

    const asked = await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "두 식별자를 알려 주세요", chatId }))
    expect(asked.status).toBe(202)
    const answer = await waitForAssistant(base, aliceCookie, chatId, 2)
    expect(answer.answer).toContain("PERSONAL-902")
    expect(answer.answer).toContain("SHARED-741")
    const sharedCitation = answer.citations.find((citation: any) => citation.url.includes("/shared-namespaces/"))
    expect(sharedCitation).toEqual(expect.objectContaining({ filename: "shared.txt" }))
    expect((await fetch(`${base}${sharedCitation.url}`)).status).toBe(401)
    expect((await fetch(`${base}${sharedCitation.url}`, { headers: { cookie: bobCookie } })).status).toBe(404)
    const copiedAsset = await fetch(`${base}${sharedCitation.url}`, { headers: { cookie: aliceCookie } })
    expect(copiedAsset.status).toBe(200)
    expect(await copiedAsset.text()).toBe("공유 정책 식별자는 SHARED-741이다.")

    await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", aliceCookie, { namespaceIds: [] }))
    await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "SHARED-741만 다시 찾아 주세요", chatId }))
    const withoutShared = await waitForAssistant(base, aliceCookie, chatId, 3)
    expect(withoutShared.answer).not.toContain("공유 정책 식별자는 SHARED-741이다.")
    expect(withoutShared.citations || []).not.toEqual(expect.arrayContaining([expect.objectContaining({ filename: "shared.txt" })]))
  })

  test("applies flat user and organization grants and snapshots only accessible descendants", async () => {
    const suffix = crypto.randomUUID()
    const alice = `alice-nested-${suffix}`
    const bob = `bob-nested-${suffix}`
    const carol = `carol-nested-${suffix}`
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-nested-snapshot-"))
    tempDirs.push(sourceDir)
    const sourcePath = path.join(sourceDir, "nested.txt")
    fs.writeFileSync(sourcePath, "nested snapshot")
    const collection = (input: {
      id: string
      title: string
      text: string
      parentId?: string
      users?: string[]
      organizations?: string[]
    }) => ({
      id: `${input.id}-${suffix}`,
      title: input.title,
      parentId: input.parentId ? `${input.parentId}-${suffix}` : null,
      active: true,
      explicitUserSubjects: input.users || [],
      organizationSubjects: input.organizations || [],
      records: [{
        id: `record-${input.id}-${suffix}`,
        title: `${input.title} 학습 자료`,
        active: true,
        admitted: true,
        assets: [{
          id: `asset-${input.id}-${suffix}`,
          filename: `${input.id}.txt`,
          mimeType: "text/plain",
          sourcePath,
          chunks: [{ id: `chunk-${input.id}-${suffix}`, text: input.text }],
        }],
      }],
    })

    const { absorbArchiveSnapshot } = await import("../../shared/snapshot")
    await absorbArchiveSnapshot({
      snapshotId: `nested-${suffix}`,
      collections: [
        collection({ id: "parent", title: "상위 자료실", text: "PARENT-100", users: [alice] }),
        collection({ id: "org-child", title: "조직 자료실", text: "ORG-200", parentId: "parent", organizations: [`org:quality-${suffix}`] }),
        collection({ id: "hidden-child", title: "비공개 자식", text: "HIDDEN-300", parentId: "parent", users: [carol] }),
        collection({ id: "mixed-grandchild", title: "혼합 자료실", text: "MIXED-400", parentId: "org-child", users: [bob], organizations: [`org:quality-${suffix}`] }),
        collection({ id: "unrelated", title: "무권한 자료실", text: "DENIED-500", organizations: [`org:finance-${suffix}`] }),
      ],
    })

    const people: Record<string, ActiveQaiPerson> = {
      [alice]: { subject: alice, personId: `person-${alice}`, organizationSubjects: [`org:quality-${suffix}`] },
      [bob]: { subject: bob, personId: `person-${bob}`, organizationSubjects: [`org:sales-${suffix}`] },
      [carol]: { subject: carol, personId: `person-${carol}`, organizationSubjects: [] },
    }
    const { createApp } = await import("../app")
    const app = createApp(boundaries(people))
    const server = app.listen(0, "127.0.0.1")
    servers.push(server)
    await new Promise<void>(resolve => server.once("listening", resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${address.port}`
    const aliceCookie = await login(base, alice)
    const bobCookie = await login(base, bob)
    const carolCookie = await login(base, carol)
    const ns = (id: string) => `shared:${id}-${suffix}`

    const alicePicker = await (await fetch(`${base}/shared-namespaces`, { headers: { cookie: aliceCookie } })).json() as any
    expect(alicePicker.namespaces.map((entry: any) => entry.id).sort()).toEqual([
      ns("mixed-grandchild"), ns("org-child"), ns("parent"),
    ].sort())
    expect(alicePicker.namespaces.find((entry: any) => entry.id === ns("parent"))).toEqual(expect.objectContaining({
      parentId: null,
      selectionNamespaceIds: [ns("parent"), ns("org-child"), ns("mixed-grandchild")],
    }))
    expect(alicePicker.namespaces.find((entry: any) => entry.id === ns("org-child"))).toEqual(expect.objectContaining({
      parentId: ns("parent"),
      selectionNamespaceIds: [ns("org-child"), ns("mixed-grandchild")],
    }))

    const bobPicker = await (await fetch(`${base}/shared-namespaces`, { headers: { cookie: bobCookie } })).json() as any
    expect(bobPicker.namespaces).toEqual([expect.objectContaining({ id: ns("mixed-grandchild"), parentId: null })])
    const carolPicker = await (await fetch(`${base}/shared-namespaces`, { headers: { cookie: carolCookie } })).json() as any
    expect(carolPicker.namespaces).toEqual([expect.objectContaining({ id: ns("hidden-child"), parentId: null })])

    const started = await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "nested 시작" }))
    const { chatId } = await started.json() as any
    await waitForAssistant(base, aliceCookie, chatId, 1)
    const parentSelection = alicePicker.namespaces.find((entry: any) => entry.id === ns("parent")).selectionNamespaceIds
    const selected = await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", aliceCookie, { namespaceIds: parentSelection }))
    expect(await selected.json()).toEqual({ ok: true, namespaceIds: [ns("parent"), ns("org-child"), ns("mixed-grandchild")] })

    await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "nested 식별자", chatId }))
    const answer = await waitForAssistant(base, aliceCookie, chatId, 2)
    expect(answer.answer).toContain("PARENT-100")
    expect(answer.answer).toContain("ORG-200")
    expect(answer.answer).toContain("MIXED-400")
    expect(answer.answer).not.toContain("HIDDEN-300")
    expect(answer.answer).not.toContain("DENIED-500")
    expect(answer.citations.map((citation: any) => citation.filename).sort()).toEqual([
      "mixed-grandchild.txt", "org-child.txt", "parent.txt",
    ])

    const orgCitation = answer.citations.find((citation: any) => citation.filename === "org-child.txt")
    expect((await fetch(`${base}${orgCitation.url}`, { headers: { cookie: aliceCookie } })).status).toBe(200)
    expect((await fetch(`${base}${orgCitation.url}`, { headers: { cookie: bobCookie } })).status).toBe(404)
    const mixedCitation = answer.citations.find((citation: any) => citation.filename === "mixed-grandchild.txt")
    expect((await fetch(`${base}${mixedCitation.url}`, { headers: { cookie: bobCookie } })).status).toBe(200)

    await absorbArchiveSnapshot({
      snapshotId: `later-${suffix}`,
      collections: [collection({
        id: "future-child",
        title: "나중 자식",
        text: "FUTURE-600",
        parentId: "parent",
        organizations: [`org:quality-${suffix}`],
      })],
    })
    const storedBag = await (await fetch(`${base}/chats/${chatId}/source-bag`, { headers: { cookie: aliceCookie } })).json() as any
    expect(storedBag.namespaceIds).toEqual([ns("parent"), ns("org-child"), ns("mixed-grandchild")])
    await fetch(`${base}/chat`, json("POST", aliceCookie, { q: "새 자식도 찾나요", chatId }))
    const afterFuture = await waitForAssistant(base, aliceCookie, chatId, 3)
    expect(afterFuture.answer).not.toContain("FUTURE-600")

    people[alice] = { subject: alice, personId: `person-${alice}`, organizationSubjects: [] }
    const afterRevocation = await (await fetch(`${base}/shared-namespaces`, { headers: { cookie: aliceCookie } })).json() as any
    expect(afterRevocation.namespaces.map((entry: any) => entry.id)).toEqual([ns("parent")])
    expect((await fetch(`${base}${orgCitation.url}`, { headers: { cookie: aliceCookie } })).status).toBe(404)
    const streamedAfterRevocation = new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + `/ws/chat?chatId=${chatId}`, { headers: { cookie: aliceCookie } })
      const timeout = setTimeout(() => { ws.close(); reject(new Error("stream timeout")) }, 5_000)
      ws.on("message", data => {
        const event = JSON.parse(data.toString())
        if (event.type === "ready") {
          void fetch(`${base}/chat`, json("POST", aliceCookie, { q: "조직 회수 후", chatId }))
        }
        if (event.type === "answer") {
          clearTimeout(timeout)
          ws.close()
          resolve(event.answer)
        }
      })
    })
    const afterOrgRevocation = await streamedAfterRevocation
    expect(afterOrgRevocation.answer).toContain("PARENT-100")
    expect(afterOrgRevocation.answer).not.toContain("ORG-200")
    expect(afterOrgRevocation.answer).not.toContain("MIXED-400")
  })
})
