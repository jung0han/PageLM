#!/usr/bin/env sh
set -u

docker_command=${DEVELOPMENT_LANE_DOCKER_CMD:-docker}
services="litellm-proxy authentik-server-1 mailpit"
failures=""

for service in $services; do
  if status=$("$docker_command" inspect --format '{{.State.Health.Status}}' "$service" 2>/dev/null); then
    [ "$status" = healthy ] || failures="$failures $service ($status)"
  else
    failures="$failures $service (missing or inspect failed)"
  fi
done

if [ -n "$failures" ]; then
  printf 'Development Lane preflight failed; required shared services are not healthy:%s\n' "$failures" >&2
  exit 1
fi

printf 'Development Lane preflight passed: %s\n' "$services"
