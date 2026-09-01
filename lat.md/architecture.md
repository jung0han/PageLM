# Architecture

QAI PageLM is an owner-maintained fork that adds QAI identity, Archive material
migration, shared namespaces, and controlled production delivery.

## Application

`backend/src/` owns authentication, API routing, agents, learning behavior,
storage, and migration seams. `frontend/` owns the interactive PageLM client;
`modules/` retains modular product capabilities.

## Archive replacement

[ADR-0001](../docs/adr/0001-absorb-archive-materials-into-pagelm.md)
owns the decision to absorb Archive material surfaces into PageLM shared
namespaces. Preserve access and evidence boundaries across migration.

## Sources of truth

[CONTEXT.md](../CONTEXT.md) owns language, the ADR owns the replacement
trade-off, current source owns behavior, and [[operations]] maps delivery and
verification entry points.
