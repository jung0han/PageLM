# Reproducible candidate baseline

This baseline proves the pinned PageLM fork can build and exercise opaque-cookie authentication, chat, personal upload, and the global Learning Bag without production Archive content or routes. It binds only to loopback (`127.0.0.1:14010`, `127.0.0.1:15000`, and `127.0.0.1:15173`), uses a project-scoped volume, and defaults to deterministic local Authentik, QAI-person, and OpenAI-compatible stubs. It does not configure ingress, DNS, TLS, Archive calls, or `archive.qai.lge.com`.

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
