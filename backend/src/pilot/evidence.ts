import fs from "fs"

export type PilotEvidenceReport = {
  schemaVersion: 1
  ticket: "DONGWOO-1119"
  mode: "fixture-candidate"
  candidateConclusion: "pass" | "fail"
  productionRouteChanged: false
  scope: {
    namespaces: number
    childNamespaces: number
    materials: number
    assets: number
    searchRows: number
    grantRows: number
    explicitUserGrant: boolean
    organizationGrant: boolean
    nestedPicker: boolean
    dataSourceProvenance: number
  }
  migration: {
    currentActiveAdmittedOnly: true
    excludedRecordIds: string[]
    integrityPercent: 100
    namespaces: { expected: number; observed: number }
    materials: { expected: number; observed: number }
    assets: { expected: number; observed: number }
    searchRows: { expected: number; observed: number }
    grants: { expected: number; observed: number }
    denseVectors: { reused: number; reembedded: number; exactIdentityRequired: true }
    rebuilt: { bm25: true; namespaces: true; grants: true }
    privateAssetsCopied: number
  }
  authorization: { probes: number; exposures: 0 }
  retrieval: {
    questions: number
    top10Hits: number
    hitRatePercent: number
    locales: string[]
  }
  learningFlows: Record<"chat" | "sourceBag" | "flashcard" | "note" | "quiz" | "examlab" | "debate" | "podcast" | "citation" | "download" | "websocketStreams", "passed">
  isolation: {
    archiveContentRuntimeCalls: 0
    unexpectedEgressCalls: 0
    permanentSync: false
    dualWrite: false
  }
  rehearsal: {
    cleanBuild: true
    sameImageRedeploy: true
    duplicateRowsAfterRedeploy: 0
    statePreserved: true
    priorRouteRestored: true
    candidateRemoved: true
  }
  realPilot: {
    conclusion: "blocked"
    blocker: string
  }
}

export async function runFixturePilotEvidence(filename: string): Promise<PilotEvidenceReport> {
  const fixture = JSON.parse(await fs.promises.readFile(filename, "utf8")) as any
  if (fixture.productionRouteChanged !== false) throw new Error("fixture pilot must not change the production route")
  const collections = Array.isArray(fixture.snapshot?.collections) ? fixture.snapshot.collections : []
  const activeCollections = collections.filter((collection: any) => collection?.active)
  const roots = activeCollections.filter((collection: any) => !collection.parentId)
  const children = activeCollections.filter((collection: any) => collection.parentId)
  if (roots.length !== 1 || children.length > 2) throw new Error("pilot scope must contain one parent and at most two children")
  const activeIds = new Set(activeCollections.map((collection: any) => collection.id))
  if (children.some((collection: any) => !activeIds.has(collection.parentId))) {
    throw new Error("pilot children must belong to the selected parent scope")
  }
  const records = activeCollections.flatMap((collection: any) =>
    (Array.isArray(collection.records) ? collection.records : []).filter((record: any) => record?.active && record?.admitted))
  const assets = records.flatMap((record: any) => Array.isArray(record.assets) ? record.assets : [])
  const explicitUserGrant = activeCollections.some((collection: any) => collection.explicitUserSubjects?.length)
  const organizationGrant = activeCollections.some((collection: any) => collection.organizationSubjects?.length)
  if (!explicitUserGrant || !organizationGrant) throw new Error("pilot scope must include explicit user and organization grants")
  const scope = {
    namespaces: activeCollections.length,
    childNamespaces: children.length,
    materials: records.length,
    assets: assets.length,
    searchRows: assets.reduce((count: number, asset: any) => count + (asset.chunks || []).filter((chunk: any) => chunk?.text?.trim()).length, 0),
    grantRows: activeCollections.reduce((count: number, collection: any) => count
      + new Set(collection.explicitUserSubjects || []).size
      + new Set(collection.organizationSubjects || []).size, 0),
    explicitUserGrant,
    organizationGrant,
    nestedPicker: children.length > 0,
    dataSourceProvenance: records.filter((record: any) => typeof record.dataSourceId === "string" && record.dataSourceId).length,
  }
  if (!scope.dataSourceProvenance) throw new Error("pilot scope must retain DataSource provenance")
  const excludedRecordIds = activeCollections.flatMap((collection: any) =>
    (Array.isArray(collection.records) ? collection.records : [])
      .filter((record: any) => !record?.active || !record?.admitted)
      .map((record: any) => String(record.id))).sort()
  const currentRecordIds = records.map((record: any) => String(record.id)).sort()
  const observed = fixture.observedMigration || {}
  const observedRecordIds = Array.isArray(observed.recordIds) ? observed.recordIds.map(String).sort() : []
  if (JSON.stringify(currentRecordIds) !== JSON.stringify(observedRecordIds)) {
    throw new Error("observed migration includes missing or non-current records")
  }
  const candidateEmbedding = fixture.candidateEmbedding || {}
  const chunks = assets.flatMap((asset: any) => (asset.chunks || []).filter((chunk: any) => chunk?.text?.trim()))
  const isReusable = (chunk: any) => chunk.denseVectorDimensions === candidateEmbedding.dimensions
    && chunk.embedding?.model === candidateEmbedding.model
    && chunk.embedding?.dimensions === candidateEmbedding.dimensions
    && chunk.embedding?.version === candidateEmbedding.version
  const reused = chunks.filter(isReusable).length
  const countPairs = {
    namespaces: { expected: scope.namespaces, observed: Number(observed.namespaces) },
    materials: { expected: scope.materials, observed: Number(observed.materials) },
    assets: { expected: scope.assets, observed: Number(observed.assets) },
    searchRows: { expected: scope.searchRows, observed: Number(observed.searchRows) },
    grants: { expected: scope.grantRows, observed: Number(observed.grants) },
  }
  if (Object.values(countPairs).some(pair => pair.expected !== pair.observed)) {
    throw new Error("pilot migration integrity is not 100%")
  }
  if (observed.privateAssetsCopied !== scope.assets
    || observed.bm25Rebuilt !== true
    || observed.namespacesRebuilt !== true
    || observed.grantsRebuilt !== true) {
    throw new Error("pilot rebuild or private asset evidence is incomplete")
  }
  const migration = {
    currentActiveAdmittedOnly: true as const,
    excludedRecordIds,
    integrityPercent: 100 as const,
    ...countPairs,
    denseVectors: { reused, reembedded: chunks.length - reused, exactIdentityRequired: true as const },
    rebuilt: { bm25: true as const, namespaces: true as const, grants: true as const },
    privateAssetsCopied: observed.privateAssetsCopied,
  }
  const authorizationProbes = Array.isArray(fixture.authorizationProbes) ? fixture.authorizationProbes : []
  const exposures = authorizationProbes.filter((probe: any) => probe.expectedAllowed !== probe.observedAllowed).length
  if (!authorizationProbes.length || exposures !== 0) throw new Error("pilot authorization exposure detected")
  const questions = Array.isArray(fixture.retrievalQuestions) ? fixture.retrievalQuestions : []
  const locales = [...new Set<string>(questions.map((question: any) => String(question.locale)))].sort()
  if (questions.length < 10 || questions.some((question: any) => question.topK !== 10)
    || !["ko", "en", "identifier"].every(locale => locales.includes(locale))) {
    throw new Error("pilot retrieval matrix must contain fixed Korean, English, and identifier top-10 questions")
  }
  const top10Hits = questions.filter((question: any) =>
    Array.isArray(question.observedAssetIds) && question.observedAssetIds.slice(0, 10).includes(question.expectedAssetId)).length
  const hitRatePercent = Number(((top10Hits / questions.length) * 100).toFixed(2))
  if (hitRatePercent < 90) throw new Error("pilot retrieval top-10 hit rate is below 90%")
  const requiredFlows = ["chat", "sourceBag", "flashcard", "note", "quiz", "examlab", "debate", "podcast", "citation", "download", "websocketStreams"] as const
  if (requiredFlows.some(flow => fixture.learningFlows?.[flow] !== true)) {
    throw new Error("pilot learning flow evidence is incomplete")
  }
  const learningFlows = Object.fromEntries(requiredFlows.map(flow => [flow, "passed"])) as PilotEvidenceReport["learningFlows"]
  const isolationObservation = fixture.isolation || {}
  if (isolationObservation.archiveContentRuntimeCalls !== 0
    || isolationObservation.unexpectedEgressCalls !== 0
    || isolationObservation.permanentSync !== false
    || isolationObservation.dualWrite !== false) {
    throw new Error("pilot Archive runtime isolation failed")
  }
  const rehearsalObservation = fixture.rehearsal || {}
  if (rehearsalObservation.cleanBuild !== true
    || rehearsalObservation.sameImageRedeploy !== true
    || rehearsalObservation.duplicateRowsAfterRedeploy !== 0
    || rehearsalObservation.statePreserved !== true
    || rehearsalObservation.priorRouteRestored !== true
    || rehearsalObservation.candidateRemoved !== true) {
    throw new Error("pilot clean redeploy or prior-route recovery rehearsal failed")
  }
  return {
    schemaVersion: 1,
    ticket: "DONGWOO-1119",
    mode: "fixture-candidate",
    candidateConclusion: "pass",
    productionRouteChanged: false,
    scope,
    migration,
    authorization: { probes: authorizationProbes.length, exposures: 0 },
    retrieval: { questions: questions.length, top10Hits, hitRatePercent, locales },
    learningFlows,
    isolation: {
      archiveContentRuntimeCalls: 0,
      unexpectedEgressCalls: 0,
      permanentSync: false,
      dualWrite: false,
    },
    rehearsal: {
      cleanBuild: true,
      sameImageRedeploy: true,
      duplicateRowsAfterRedeploy: 0,
      statePreserved: true,
      priorRouteRestored: true,
      candidateRemoved: true,
    },
    realPilot: {
      conclusion: "blocked",
      blocker: "missing PageLM candidate target and Archive snapshot owning interface",
    },
  }
}
