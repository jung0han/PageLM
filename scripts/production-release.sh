#!/bin/sh
set -eu

ENV_FILE=${PAGELM_ENV_FILE:-/srv/secrets/pagelm/production.env}
COMPOSE_FILE=${PAGELM_COMPOSE_FILE:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/compose.production.yaml}
PROJECT=${PAGELM_PROJECT:-qai-pagelm}
STATE_DIR=${PAGELM_STATE_DIR:-/srv/state/pagelm}
EVIDENCE_FILE=${PAGELM_EVIDENCE_FILE:-$STATE_DIR/readiness.json}

fail() { echo "production-release: $*" >&2; exit 2; }
[ -r "$ENV_FILE" ] || fail "secret env file is unavailable"
[ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")" = 600 ] || fail "secret env file must have mode 0600"

# The file is owned by WorkOps. Its values are exported for Compose but never echoed.
set -a
. "$ENV_FILE"
set +a
: "${PAGELM_RELEASE_SHA:?PAGELM_RELEASE_SHA is required}"
: "${PAGELM_BACKEND_IMAGE:?PAGELM_BACKEND_IMAGE is required}"
: "${PAGELM_FRONTEND_IMAGE:?PAGELM_FRONTEND_IMAGE is required}"
printf '%s' "$PAGELM_RELEASE_SHA" | grep -Eq '^[0-9a-fA-F]{40}$' || fail "release SHA must be the exact 40-character Git SHA"
printf '%s' "$PAGELM_BACKEND_IMAGE" | grep -Eq '@sha256:[0-9a-fA-F]{64}$' || fail "backend image must be digest pinned"
printf '%s' "$PAGELM_FRONTEND_IMAGE" | grep -Eq '@sha256:[0-9a-fA-F]{64}$' || fail "frontend image must be digest pinned"
printf '%s' "$PAGELM_BACKEND_IMAGE" | grep -Fq ":$PAGELM_RELEASE_SHA@" || fail "backend image tag must carry the release SHA"
printf '%s' "$PAGELM_FRONTEND_IMAGE" | grep -Fq ":$PAGELM_RELEASE_SHA@" || fail "frontend image tag must carry the release SHA"

compose() { docker compose --env-file "$ENV_FILE" --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"; }
write_evidence() {
  mkdir -p "$(dirname -- "$EVIDENCE_FILE")"
  umask 077
  tmp="$EVIDENCE_FILE.$$"
  printf '{"release_sha":"%s","project":"%s","backend_ready":true,"recorded_at":"%s"}\n' "$PAGELM_RELEASE_SHA" "$PROJECT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv -f "$tmp" "$EVIDENCE_FILE"
}

readiness() {
  compose up -d --wait
  compose exec -T backend wget -qO- http://127.0.0.1:5000/health/ready >/dev/null
  write_evidence
  echo "readiness: passed (release $PAGELM_RELEASE_SHA)"
}
status() { compose ps; }
deploy() {
  mkdir -p "$STATE_DIR"
  umask 077
  if [ -f "$STATE_DIR/current-revision" ]; then cp "$STATE_DIR/current-revision" "$STATE_DIR/previous-revision"; fi
  printf '%s\n' "$PAGELM_RELEASE_SHA" > "$STATE_DIR/current-revision"
  readiness
}
rollback() {
  [ -s "$STATE_DIR/previous-revision" ] || fail "no previous revision recovery marker"
  previous=$(sed -n '1p' "$STATE_DIR/previous-revision")
  printf '%s' "$previous" | grep -Eq '^[0-9a-fA-F]{40}$' || fail "invalid previous revision marker"
  echo "rollback: recovery marker is $previous; restore its image env and rerun deploy"
}

case "${1:-}" in
  readiness) readiness ;;
  status) status ;;
  deploy) deploy ;;
  rollback) rollback ;;
  *) fail "usage: $0 {readiness|status|deploy|rollback}" ;;
esac
