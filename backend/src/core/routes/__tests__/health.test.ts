import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { checkReadiness } from "../health"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("checkReadiness", () => {
  it("proves writable storage and SQLite access", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-ready-"))
    dirs.push(dir)

    await expect(checkReadiness({
      storageDir: dir,
      sqliteQuery: async () => ({ ready: 1 }),
    })).resolves.toEqual({ ok: true, checks: { storage: "ok", sqlite: "ok" } })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("is not ready when SQLite cannot be queried", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-ready-"))
    dirs.push(dir)

    const result = await checkReadiness({
      storageDir: dir,
      sqliteQuery: async () => { throw new Error("database unavailable") },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("database unavailable")
  })
})
