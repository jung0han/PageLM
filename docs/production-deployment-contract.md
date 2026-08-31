# PageLM production deployment contract

The production stack is started only by `scripts/production-release.sh` with
`compose.production.yaml`. WorkOps writes `/srv/secrets/pagelm/production.env`
with mode `0600`; the file is consumed as a Compose `env_file` and is never
rendered or printed by the release helper.

`PAGELM_RELEASE_SHA` must be the full 40-character Git SHA. Backend and
frontend image variables must include a 64-character `@sha256:` digest. The
stack has no public host ports or fixed container names. Frontend and backend
join the external `traefik-public` network and own the `archive.qai.lge.com`
route through Traefik labels. Milvus, etcd, and MinIO remain on the private
internal network; storage volumes survive a redeploy and MinIO credentials are
provided by the secret env file.

Lifecycle commands are `readiness`, `isolated-readiness`, `status`, `deploy`,
and `rollback`. `isolated-readiness` uses a release-specific Compose project
name so the candidate can start and produce evidence without touching the
production project. `readiness` starts the pinned stack, waits for Compose health, probes the
backend readiness endpoint, and atomically writes secret-free evidence to
`/srv/state/pagelm/readiness.json` by default. `deploy` records the prior
revision in `/srv/state/pagelm/previous-revision` before starting. `rollback`
validates and reports that recovery marker; WorkOps restores the corresponding
immutable image references in the env file before invoking `deploy`.
