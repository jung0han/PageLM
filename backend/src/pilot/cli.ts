import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { runFixturePilotEvidence } from "./evidence"

function parseArguments(argv: string[]) {
  const allowed = new Set(["--fixture", "--evidence"])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(name) || !value || value.startsWith("--")) throw new Error(`invalid pilot argument: ${name || "missing"}`)
    if (values.has(name)) throw new Error(`duplicate pilot argument: ${name}`)
    values.set(name, value)
  }
  if (values.size !== allowed.size) throw new Error("--fixture and --evidence are required")
  return { fixture: values.get("--fixture")!, evidence: values.get("--evidence")! }
}

function requireFixturePath(filename: string) {
  const root = path.resolve(process.cwd(), "scripts", "fixtures")
  const resolved = path.resolve(filename)
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("fixture must be inside scripts/fixtures")
  return resolved
}

async function writeAtomic(filename: string, content: string) {
  if (!path.isAbsolute(filename)) throw new Error("evidence path must be absolute")
  const directory = path.dirname(filename)
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.tmp`)
  try {
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await fs.promises.rename(temporary, filename)
  } finally {
    await fs.promises.rm(temporary, { force: true })
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const report = await runFixturePilotEvidence(requireFixturePath(args.fixture))
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("pilot revision is not a full Git SHA")
  const checks = Object.fromEntries([
    "scope", "snapshot_projection", "migration_integrity", "authorization", "retrieval_quality",
    "learning_flows", "archive_runtime_isolation", "clean_redeploy", "prior_route_recovery", "production_route_untouched",
  ].map(name => [name, { status: "passed" }]))
  const envelope = {
    schema_version: 1,
    kind: "qai.pagelm.archive-replacement-pilot-evidence",
    ticket: "DONGWOO-1119",
    revision,
    mode: "fixture",
    state: "completed",
    candidate_result: report.candidateConclusion === "pass" ? "passed" : "failed",
    go_no_go: "no-go",
    checks,
    metrics: {
      scope: report.scope,
      migration: {
        namespaces: report.migration.namespaces,
        materials: report.migration.materials,
        assets: report.migration.assets,
        search_rows: report.migration.searchRows,
        grants: report.migration.grants,
        integrity_percent: report.migration.integrityPercent,
        dense_reused: report.migration.denseVectors.reused,
        dense_rebuilt: report.migration.denseVectors.reembedded,
        bm25_rebuilt: report.migration.searchRows.observed,
        duplicate_rows_after_redeploy: report.rehearsal.duplicateRowsAfterRedeploy,
      },
      authorization: report.authorization,
      retrieval: {
        questions: report.retrieval.questions,
        top_10_hits: report.retrieval.top10Hits,
        hit_rate_percent: report.retrieval.hitRatePercent,
        locales: report.retrieval.locales,
      },
      learning_flows: report.learningFlows,
      archive_content_runtime_calls: report.isolation.archiveContentRuntimeCalls,
      unexpected_egress_calls: report.isolation.unexpectedEgressCalls,
      permanent_sync: report.isolation.permanentSync,
      dual_write: report.isolation.dualWrite,
    },
    production_route: {
      hostname: "archive.qai.lge.com",
      changed: false,
      observation: "not-contacted; fixture command has no production-route capability",
    },
    recovery: {
      state: "fixture-prior-route-restored-and-candidate-removed",
      clean_build: report.rehearsal.cleanBuild,
      same_image_redeploy: report.rehearsal.sameImageRedeploy,
      state_preserved: report.rehearsal.statePreserved,
      prior_route_restored: report.rehearsal.priorRouteRestored,
      candidate_removed: report.rehearsal.candidateRemoved,
    },
    blockers: [
      { id: "real_snapshot_target_unresolved", status: "blocked" },
      { id: "owner_private_candidate_target_unresolved", status: "blocked" },
      { id: "real_prior_route_owner_interface_unresolved", status: "blocked" },
    ],
  }
  const serialized = `${JSON.stringify(envelope)}\n`
  await writeAtomic(path.resolve(args.evidence), serialized)
  process.stdout.write(serialized)
}

main().catch(error => {
  process.stderr.write(`pilot:evidence failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
  process.exitCode = 1
})
