import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { promisify } from "util"
import { afterEach, describe, expect, test } from "vitest"

const exec = promisify(execFile)
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("pilot:evidence CLI", () => {
  test("atomically emits one safe fixture envelope with a production no-go decision", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelm-pilot-evidence-"))
    tempDirs.push(dir)
    const evidenceFile = path.join(dir, "evidence.json")
    const { stdout } = await exec("npm", [
      "run", "--silent", "pilot:evidence", "--",
      "--fixture", "scripts/fixtures/archive-pilot.json",
      "--evidence", evidenceFile,
    ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 })

    const envelope = JSON.parse(stdout)
    expect(JSON.parse(fs.readFileSync(evidenceFile, "utf8"))).toEqual(envelope)
    expect(envelope).toMatchObject({
      schema_version: 1,
      kind: "qai.pagelm.archive-replacement-pilot-evidence",
      ticket: "DONGWOO-1119",
      mode: "fixture",
      state: "completed",
      candidate_result: "passed",
      go_no_go: "no-go",
      production_route: { hostname: "archive.qai.lge.com", changed: false },
      metrics: {
        authorization: { probes: 16, exposures: 0 },
        retrieval: { questions: 10, top_10_hits: 9, hit_rate_percent: 90 },
        archive_content_runtime_calls: 0,
      },
    })
    expect(envelope.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(envelope.blockers).toHaveLength(3)
    expect(stdout).not.toContain("PILOT-PARENT-100")
    expect(stdout.trim().split("\n")).toHaveLength(1)
    expect(fs.readdirSync(dir)).toEqual(["evidence.json"])
  })
})
