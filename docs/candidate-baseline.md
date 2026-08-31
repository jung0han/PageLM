# Reproducible candidate baseline

This baseline proves the pinned PageLM fork can build and exercise opaque-cookie authentication, chat, the Vertex embedding → Milvus dense+BM25 → LiteLLM personal-upload path, a read-only snapshot-derived parent 공유 자료실 with an organization-granted child, exact nested source-bag expansion, authenticated personal and shared citations, and the global Learning Bag without production Archive content or routes. The candidate snapshot is a non-sensitive repository fixture; startup copies its assets and search rows into PageLM-owned storage, and every later picker, search, and asset read uses that copy. It binds only the test endpoints to loopback (`127.0.0.1:14010`, `127.0.0.1:15000`, and `127.0.0.1:15173`), keeps Milvus private to the Compose network, and defaults to deterministic local identity, Vertex, and LiteLLM stubs. It does not configure ingress, DNS, TLS, Archive calls, or `archive.qai.lge.com`.

## Reproduce

Use Node 22.16.0, npm 10.9.2, pnpm 10.13.1, Docker, and Compose v2. Secrets must be runtime-injected through `CANDIDATE_*` variables and must never be written to this repository or baked into either image. The default values are non-secret local stub credentials.

```bash
npm ci --legacy-peer-deps
npm run build
npm test
corepack enable
corepack prepare pnpm@10.13.1 --activate
(cd frontend && pnpm install --frozen-lockfile && pnpm build)
node scripts/verify-provenance.mjs

export FORK_REVISION="$(git rev-parse HEAD)"
docker compose -p qai-pagelm-candidate -f compose.candidate.yaml build
docker compose -p qai-pagelm-candidate -f compose.candidate.yaml up -d --wait
npm run candidate:smoke -- --persistence-file /tmp/qai-pagelm-candidate-card
```

The first smoke run leaves exactly one marker card. Redeploy the same images while retaining the isolated volume, then run the smoke again; the second run verifies and removes that marker.

```bash
docker compose -p qai-pagelm-candidate -f compose.candidate.yaml down
docker compose -p qai-pagelm-candidate -f compose.candidate.yaml up -d --wait --no-build
npm run candidate:smoke -- --persistence-file /tmp/qai-pagelm-candidate-card
docker compose -p qai-pagelm-candidate -f compose.candidate.yaml down --volumes
```

## Evidence to retain

Capture the output of the commands above plus:

```bash
node --version
npm --version
pnpm --version
docker compose -p qai-pagelm-candidate -f compose.candidate.yaml images
docker volume ls --filter name=qai-pagelm-candidate
docker image inspect qai-pagelm-backend:candidate qai-pagelm-frontend:candidate
docker history --no-trunc qai-pagelm-backend:candidate
git diff b3b4895fb3a180088b897705816a5a9786d79a92 -- . ':!docs/candidate-baseline.md'
git grep -nE '(sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)'
```

Image inspection must show `org.opencontainers.image.revision`, `org.opencontainers.image.source`, and `io.qai.pagelm.upstream-revision`. Health readiness proves writable storage and SQLite access only; it intentionally makes no provider or Archive request. The Compose config passes provider values only to the backend, and no `.env` file is copied or mounted.

Deployment to owner-private infrastructure remains blocked until a candidate host, registry, deploy controller, certificate, and recovery owner are explicitly selected. Production route switching is outside this baseline.

## Fixture-backed Archive replacement pilot evidence

DONGWOO-1119 adds a local-only, repeatable evidence boundary. It validates the checked-in non-sensitive parent-plus-two-child snapshot fixture, current active/admitted projection, exact embedding identity reuse policy, BM25/namespace/grant rebuild evidence, private asset counts, authorization exposure matrix, fixed Korean/English/identifier top-10 questions, all chat-centred learning flows, Archive runtime isolation, same-image redeploy integrity, and fixture prior-route recovery.

```bash
evidence_file="$(mktemp)"
npm run --silent pilot:evidence -- \
  --fixture scripts/fixtures/archive-pilot.json \
  --evidence "$evidence_file"
```

The command accepts fixtures only from `scripts/fixtures`, writes one versioned secret-free JSON object to stdout and atomically to the absolute evidence path, and has no Archive URL, SSH, ingress, DNS, TLS, or production-route capability. A passing fixture run reports `candidate_result: passed` and `go_no_go: no-go` together. The production conclusion remains no-go because a real non-sensitive Archive snapshot owning interface, an owner-private PageLM candidate target, and the exact prior-route recovery owner are unresolved. No real Archive/private service or `archive.qai.lge.com` route is contacted or changed by this command.

Shared snapshot rows now use deterministic chunk IDs and Milvus upsert, so absorbing the same snapshot after a retained-volume redeploy does not duplicate search rows. Dense vectors are reused only when model `gemini-embedding-001`, dimension 1536, configured `VERTEX_EMBEDDING_VERSION`, snapshot version, and vector length all match exactly; otherwise PageLM re-embeds the chunk.
