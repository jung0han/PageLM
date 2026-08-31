import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import { sqlite } from "../../utils/database/sqlite"

type ReadyOptions = {
  storageDir?: string
  sqliteQuery?: () => Promise<unknown>
}

export async function checkReadiness(options: ReadyOptions = {}) {
  const storageDir = options.storageDir || path.join(process.cwd(), "storage")
  const sqliteQuery = options.sqliteQuery || (() => sqlite.get("SELECT 1 AS ready"))
  const probe = path.join(storageDir, `.readiness-${randomUUID()}`)

  try {
    await fs.promises.mkdir(storageDir, { recursive: true })
    await fs.promises.writeFile(probe, "ready", { flag: "wx" })
    await fs.promises.unlink(probe)
    const row = await sqliteQuery()
    if (!row) throw new Error("SQLite readiness query returned no row")
    return { ok: true, checks: { storage: "ok", sqlite: "ok" } }
  } catch (error: any) {
    await fs.promises.unlink(probe).catch(() => undefined)
    return {
      ok: false,
      checks: { storage: "failed", sqlite: "failed" },
      error: error?.message || "readiness check failed",
    }
  }
}

export function healthRoutes(app: any) {
  app.get("/health/live", (_req: any, res: any) => {
    res.send({ ok: true, status: "live" })
  })

  app.get("/health/ready", async (_req: any, res: any) => {
    const result = await checkReadiness()
    res.status(result.ok ? 200 : 503).send(result)
  })
}
