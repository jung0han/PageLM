import { execFileSync } from "node:child_process"
import fs from "node:fs"

const provenance = JSON.parse(fs.readFileSync(new URL("../provenance.json", import.meta.url)))
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
const head = git("rev-parse", "HEAD")
const upstream = git("rev-parse", provenance.upstreamRevision)

if (upstream !== provenance.upstreamRevision) throw new Error("Pinned upstream revision does not resolve exactly")
if (git("merge-base", head, upstream) !== upstream) throw new Error("Pinned upstream is not an ancestor of the fork revision")

process.stdout.write(JSON.stringify({ ...provenance, forkRevision: head }, null, 2) + "\n")
