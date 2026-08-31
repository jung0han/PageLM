# Domain Docs

How engineering skills consume this repository's domain documentation.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that touch the area being changed.
- If a document is absent, proceed silently; domain-modeling creates it only when a decision or term is resolved.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
├── backend/
└── frontend/
```

## Vocabulary and decisions

Use the glossary's exact vocabulary in issues, designs, tests, and implementation. Reconsider synonyms that the glossary explicitly avoids. If work contradicts an ADR, surface the conflict rather than silently overriding it.
