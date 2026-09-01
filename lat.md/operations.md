# Operations

QAI PageLM separates isolated candidate verification from production release
and keeps migration evidence tied to the exact revision.

## Candidate

[The candidate baseline](../docs/candidate-baseline.md),
`compose.candidate.yaml`, and `scripts/candidate-smoke.mjs` own isolated
readiness and smoke verification.

## Production

[The production deployment contract](../docs/production-deployment-contract.md),
production Compose files, `scripts/production-release.sh`, and
`scripts/production-smoke.mjs` own release and public verification.

## Migration and recovery

Archive fixtures and pilot commands provide bounded evidence, not production
payload storage. Preserve source revision, access mappings, and the documented
recovery path before production mutation.
