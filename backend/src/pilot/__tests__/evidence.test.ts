import path from "path"
import { describe, expect, test } from "vitest"
import { runFixturePilotEvidence } from "../evidence"

describe("Archive replacement pilot evidence", () => {
  test("separates passing fixture candidate evidence from the unresolved real snapshot target", async () => {
    const report = await runFixturePilotEvidence(path.resolve("scripts/fixtures/archive-pilot.json"))

    expect(report).toMatchObject({
      schemaVersion: 1,
      ticket: "DONGWOO-1119",
      mode: "fixture-candidate",
      candidateConclusion: "pass",
      productionRouteChanged: false,
      realPilot: {
        conclusion: "blocked",
        blocker: "missing PageLM candidate target and Archive snapshot owning interface",
      },
    })
  })

  test("admits one parent and at most two children with both grant kinds and DataSource provenance", async () => {
    const report = await runFixturePilotEvidence(path.resolve("scripts/fixtures/archive-pilot.json"))

    expect(report.scope).toEqual({
      namespaces: 3,
      childNamespaces: 2,
      materials: 4,
      assets: 4,
      searchRows: 4,
      grantRows: 4,
      explicitUserGrant: true,
      organizationGrant: true,
      nestedPicker: true,
      dataSourceProvenance: 1,
    })
  })

  test("requires 100% current-only migration integrity and exact embedding identity before vector reuse", async () => {
    const report = await runFixturePilotEvidence(path.resolve("scripts/fixtures/archive-pilot.json"))

    expect(report.migration).toEqual({
      currentActiveAdmittedOnly: true,
      excludedRecordIds: ["pilot-old-revision", "pilot-processing"],
      integrityPercent: 100,
      namespaces: { expected: 3, observed: 3 },
      materials: { expected: 4, observed: 4 },
      assets: { expected: 4, observed: 4 },
      searchRows: { expected: 4, observed: 4 },
      grants: { expected: 4, observed: 4 },
      denseVectors: { reused: 2, reembedded: 2, exactIdentityRequired: true },
      rebuilt: { bm25: true, namespaces: true, grants: true },
      privateAssetsCopied: 4,
    })
  })

  test("requires zero authorization exposures and at least 90% fixed top-10 retrieval", async () => {
    const report = await runFixturePilotEvidence(path.resolve("scripts/fixtures/archive-pilot.json"))

    expect(report.authorization).toEqual({ probes: 16, exposures: 0 })
    expect(report.retrieval).toEqual({
      questions: 10,
      top10Hits: 9,
      hitRatePercent: 90,
      locales: ["en", "identifier", "ko"],
    })
  })

  test("requires every learning flow, Archive isolation, clean redeploy, and fixture route recovery", async () => {
    const report = await runFixturePilotEvidence(path.resolve("scripts/fixtures/archive-pilot.json"))

    expect(report.learningFlows).toEqual({
      chat: "passed",
      sourceBag: "passed",
      flashcard: "passed",
      note: "passed",
      quiz: "passed",
      examlab: "passed",
      debate: "passed",
      podcast: "passed",
      citation: "passed",
      download: "passed",
      websocketStreams: "passed",
    })
    expect(report.isolation).toEqual({
      archiveContentRuntimeCalls: 0,
      unexpectedEgressCalls: 0,
      permanentSync: false,
      dualWrite: false,
    })
    expect(report.rehearsal).toEqual({
      cleanBuild: true,
      sameImageRedeploy: true,
      duplicateRowsAfterRedeploy: 0,
      statePreserved: true,
      priorRouteRestored: true,
      candidateRemoved: true,
    })
  })
})
