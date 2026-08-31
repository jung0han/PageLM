import { afterEach, describe, expect, test } from "vitest"
import WebSocket from "ws"
import type { ActiveQaiPerson, AuthentikOidc, QaiPersonResolver } from "../../auth/types"

process.env.OPENAI_API_KEY ||= "integration-test"
process.env.OPENAI_BASE_URL ||= "http://127.0.0.1:1/v1"

type Identity = ActiveQaiPerson | null

function fakeBoundaries(initial: Record<string, Identity>) {
  const people = new Map(Object.entries(initial))
  const oidc: AuthentikOidc = {
    authorizationUrl(input) {
      return `https://auth.example/authorize?state=${encodeURIComponent(input.state)}`
    },
    async exchangeCode(input) {
      return {
        subject: input.code,
        refreshToken: `refresh-${input.code}`,
        expiresAt: Date.now() + 60_000,
      }
    },
    async refresh(refreshToken) {
      const subject = refreshToken.replace(/^refresh-/, "")
      return { subject, refreshToken, expiresAt: Date.now() + 120_000 }
    },
    async revoke() {},
  }
  const resolver: QaiPersonResolver = {
    async resolveActivePerson(subject) {
      return people.get(subject) ?? null
    },
  }
  return { oidc, resolver, people }
}

async function start(boundaries: ReturnType<typeof fakeBoundaries>) {
  const { createApp } = await import("../app")
  const app = createApp({ oidc: boundaries.oidc, personResolver: boundaries.resolver })
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing test address")
  const base = `http://127.0.0.1:${address.port}`
  return { app, server, base }
}

async function login(base: string, subject: string) {
  const begin = await fetch(`${base}/auth/login`, { redirect: "manual" })
  expect(begin.status).toBe(302)
  const state = new URL(begin.headers.get("location")!).searchParams.get("state")
  const callback = await fetch(`${base}/auth/callback?code=${encodeURIComponent(subject)}&state=${encodeURIComponent(state!)}`, {
    headers: { cookie: begin.headers.get("set-cookie")!.split(";", 1)[0] },
    redirect: "manual",
  })
  return { callback, cookie: callback.headers.get("set-cookie")!.split(";", 1)[0] }
}

function json(method: string, cookie?: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  }
}

const servers: Array<{ close(callback: () => void): void }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(resolve))))
})

describe("opaque browser authentication", () => {
  test("login, refresh, and logout use only a Secure HttpOnly session cookie", async () => {
    const boundaries = fakeBoundaries({ alice: { subject: "alice", personId: "qai-alice" } })
    const { server, base } = await start(boundaries)
    servers.push(server)

    const browserBearerLogin = await fetch(`${base}/auth/login`, {
      headers: { authorization: "Bearer browser-token" },
      redirect: "manual",
    })
    expect(browserBearerLogin.status).toBe(401)

    const unboundBegin = await fetch(`${base}/auth/login`, { redirect: "manual" })
    const unboundState = new URL(unboundBegin.headers.get("location")!).searchParams.get("state")
    const unboundCallback = await fetch(`${base}/auth/callback?code=alice&state=${unboundState}`, { redirect: "manual" })
    expect(unboundCallback.status).toBe(401)

    const { callback, cookie } = await login(base, "alice")
    expect(callback.status).toBe(302)
    expect(callback.headers.get("set-cookie")).toMatch(/^pagelm_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax;/)

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } })
    expect(await me.json()).toEqual({ ok: true, person: { id: "qai-alice" } })

    const bearer = await fetch(`${base}/chats`, { headers: { authorization: "Bearer browser-token" } })
    expect(bearer.status).toBe(401)
    const forwarded = await fetch(`${base}/chats`, { headers: { cookie, "x-forwarded-user": "alice" } })
    expect(forwarded.status).toBe(401)

    const refreshed = await fetch(`${base}/auth/refresh`, json("POST", cookie))
    expect(refreshed.status).toBe(200)
    expect(refreshed.headers.get("set-cookie")).toContain("HttpOnly; Secure")

    const loggedOut = await fetch(`${base}/auth/logout`, json("POST", cookie))
    expect(loggedOut.status).toBe(204)
    expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await fetch(`${base}/chats`, { headers: { cookie } })).status).toBe(401)
  })

  test("REST and WebSocket both fail closed when current QAI person eligibility is lost", async () => {
    const boundaries = fakeBoundaries({ alice: { subject: "alice", personId: "qai-alice" } })
    const { server, base } = await start(boundaries)
    servers.push(server)
    const { cookie } = await login(base, "alice")

    boundaries.people.set("alice", null)
    expect((await fetch(`${base}/chats`, { headers: { cookie } })).status).toBe(403)

    const wsStatus = await new Promise<number>(resolve => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws/chat?chatId=missing", { headers: { cookie } })
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode))
      ws.once("error", () => undefined)
    })
    expect(wsStatus).toBe(403)
  })

  test("service, QAI exception, unclassified, inactive, deleted, and mismatched identities cannot start a session", async () => {
    const boundaries = fakeBoundaries({})
    const { server, base } = await start(boundaries)
    servers.push(server)

    for (const subject of ["service", "exception", "unclassified", "inactive", "deleted", "mismatch"]) {
      const begin = await fetch(`${base}/auth/login`, { redirect: "manual" })
      const state = new URL(begin.headers.get("location")!).searchParams.get("state")
      const callback = await fetch(`${base}/auth/callback?code=${subject}&state=${state}`, {
        headers: { cookie: begin.headers.get("set-cookie")!.split(";", 1)[0] },
        redirect: "manual",
      })
      expect(callback.status, subject).toBe(403)
      expect(callback.headers.get("set-cookie"), subject).toBeNull()
    }
  })
})

describe("stable-sub personal learning state", () => {
  test("chat, upload, source bag, and global Learning Bag are isolated between subjects", async () => {
    const suffix = crypto.randomUUID()
    const aliceSub = `alice-${suffix}`
    const bobSub = `bob-${suffix}`
    const boundaries = fakeBoundaries({
      [aliceSub]: { subject: aliceSub, personId: `qai-alice-${suffix}` },
      [bobSub]: { subject: bobSub, personId: `qai-bob-${suffix}` },
    })
    const { server, base } = await start(boundaries)
    servers.push(server)
    const alice = (await login(base, aliceSub)).cookie
    const bob = (await login(base, bobSub)).cookie

    const createdChat = await fetch(`${base}/chat`, json("POST", alice, { q: `alice-private-${suffix}` }))
    expect(createdChat.status).toBe(202)
    const { chatId } = await createdChat.json() as { chatId: string }

    const sourceBag = await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", alice, {
      namespaceIds: [],
    }))
    expect(sourceBag.status).toBe(200)
    expect(await sourceBag.json()).toEqual({ ok: true, namespaceIds: [] })

    const card = await fetch(`${base}/flashcards`, json("POST", alice, {
      question: `private-${suffix}`,
      answer: "alice-only",
      tag: "isolation",
    }))
    const cardId = (await card.json() as any).flashcard.id

    expect((await fetch(`${base}/chats/${chatId}`, { headers: { cookie: bob } })).status).toBe(404)
    expect((await fetch(`${base}/chats/${chatId}/source-bag`, { headers: { cookie: bob } })).status).toBe(404)
    expect((await fetch(`${base}/chats/${chatId}/source-bag`, json("PUT", bob, { namespaceIds: [] }))).status).toBe(404)
    expect((await fetch(`${base}/chat`, json("POST", bob, { q: "intrusion", chatId }))).status).toBe(404)

    const foreignUpload = new FormData()
    foreignUpload.set("q", "intrusion")
    foreignUpload.set("chatId", chatId)
    foreignUpload.set("file", new Blob(["bob must not attach this"]), "foreign.txt")
    expect((await fetch(`${base}/chat`, { method: "POST", headers: { cookie: bob }, body: foreignUpload })).status).toBe(404)

    const bobChats = await (await fetch(`${base}/chats`, { headers: { cookie: bob } })).json() as any
    expect(bobChats.chats).toEqual([])
    const bobCards = await (await fetch(`${base}/flashcards`, { headers: { cookie: bob } })).json() as any
    expect(bobCards.flashcards).toEqual([])
    expect((await fetch(`${base}/flashcards/${cardId}`, json("DELETE", bob))).status).toBe(404)

    const aliceCards = await (await fetch(`${base}/flashcards`, { headers: { cookie: alice } })).json() as any
    expect(aliceCards.flashcards.map((entry: any) => entry.id)).toContain(cardId)

    const foreignWs = await new Promise<{ code: number; reason: string }>(resolve => {
      const ws = new WebSocket(base.replace("http", "ws") + `/ws/chat?chatId=${chatId}`, { headers: { cookie: bob } })
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    expect(foreignWs).toEqual({ code: 1008, reason: "chat not found" })
  })

  test("profile identifier changes do not transfer ownership away from the stable subject", async () => {
    const subject = `stable-${crypto.randomUUID()}`
    const boundaries = fakeBoundaries({ [subject]: { subject, personId: "person-before" } })
    const { server, base } = await start(boundaries)
    servers.push(server)
    const { cookie } = await login(base, subject)

    const card = await fetch(`${base}/flashcards`, json("POST", cookie, {
      question: "stable owner",
      answer: "same sub",
      tag: "identity",
    }))
    const id = (await card.json() as any).flashcard.id
    boundaries.people.set(subject, { subject, personId: "person-after-profile-change" })

    const listed = await (await fetch(`${base}/flashcards`, { headers: { cookie } })).json() as any
    expect(listed.flashcards.map((entry: any) => entry.id)).toContain(id)
  })
})
