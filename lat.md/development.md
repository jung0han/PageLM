# Development

Repository changes preserve fork provenance, QAI-specific authority, and the
separation between candidate and production delivery.

## Change preparation

Read [CONTEXT.md](../CONTEXT.md), the accepted [ADR](../docs/adr/), and the
relevant candidate or production contract before changing material, identity,
migration, or release seams.

## Validation

Run `npm test` and `npm run build`, plus candidate or production smoke and
provenance checks when their surfaces change. Graph changes complete with
`lat check`; documentation changes also require `git diff --check`.
