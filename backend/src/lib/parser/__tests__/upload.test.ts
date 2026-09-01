import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { describe, expect, test } from "vitest"
import { createApp } from "../../../core/app"
import { parseMultipart } from "../upload"

describe("chat multipart uploads", () => {
  test("stores a long UTF-8 display filename under a bounded temporary name", async () => {
    const ownerSubject = "long-filename-fixture"
    const ownerDir = path.join(
      process.cwd(),
      "storage",
      "uploads",
      createHash("sha256").update(ownerSubject).digest("hex"),
    )
    const filename = `${"긴파일명".repeat(30)}.txt`
    const form = new FormData()
    form.append("q", "fixture question")
    form.append("file", new Blob([Buffer.alloc(762_000, "a")], { type: "text/plain" }), filename)
    const request = new Request("http://localhost/chat", { method: "POST", body: form })
    const req = Readable.fromWeb(request.body as any) as any
    req.headers = Object.fromEntries(request.headers.entries())

    try {
      const parsed = await parseMultipart(req, ownerSubject)
      expect(parsed.q).toBe("fixture question")
      expect(parsed.files).toHaveLength(1)
      expect(parsed.files[0].filename).toBe(filename)
      expect(Buffer.byteLength(path.basename(parsed.files[0].path))).toBeLessThanOrEqual(255)
    } finally {
      fs.rmSync(ownerDir, { recursive: true, force: true })
    }
  })

  test("returns a bounded error instead of hanging on malformed multipart input", async () => {
    const auth = {
      async authenticate() {
        return {
          subject: "multipart-error-fixture",
          person: { subject: "multipart-error-fixture", personId: "fixture", organizationSubjects: [] },
          expiresAt: Date.now() + 60_000,
        }
      },
    } as any
    const app = createApp({ auth })
    const server = app.listen(0, "127.0.0.1")
    await new Promise<void>(resolve => server.once("listening", resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=fixture-boundary" },
        body: "--fixture-boundary\r\nContent-Disposition: form-data; name=\"q\"\r\n\r\ntruncated",
        signal: AbortSignal.timeout(1_000),
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: "chat_initialization_failed" })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
