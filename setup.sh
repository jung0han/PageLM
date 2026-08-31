#!/bin/bash
set -e

npm ci --legacy-peer-deps
corepack enable
corepack prepare pnpm@10.13.1 --activate
(cd frontend && pnpm install --frozen-lockfile)

# Setup environment
cp -n .env.example .env

npm run dev &
backend_pid=$!
(cd frontend && pnpm dev) &
frontend_pid=$!
trap 'kill "$backend_pid" "$frontend_pid" 2>/dev/null || true' EXIT
wait
