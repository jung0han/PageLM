import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.cwd())
const compose = fs.readFileSync(path.join(root, 'compose.production.yaml'), 'utf8')
const release = fs.readFileSync(path.join(root, 'scripts/production-release.sh'), 'utf8')

describe('production deployment contract', () => {
  test('uses digest-pinned release images and the full source SHA', () => {
    expect(compose).toContain('PAGELM_BACKEND_IMAGE:?')
    expect(compose).toContain('PAGELM_FRONTEND_IMAGE:?')
    expect(compose).toContain('GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/pagelm-gcloud.json')
    expect(compose).toContain('application_default_credentials.json}:/run/secrets/pagelm-gcloud.json:ro')
    expect(release).toContain("PAGELM_RELEASE_SHA")
    expect(release).toContain("'^[0-9a-fA-F]{40}$'")
    expect(compose.match(/pagelm\.release-revision:/g)).toHaveLength(2)
    expect(compose.match(/pagelm\.owner: workops-pagelm/g)).toHaveLength(2)
  })

  test('keeps secrets in the mode-0600 production env file', () => {
    expect(compose).toContain('${PAGELM_ENV_FILE:-/srv/secrets/pagelm/production.env}')
    expect(compose).not.toMatch(/MINIO_ROOT_PASSWORD:\s+minioadmin/)
    expect(compose).toContain('MINIO_ACCESS_KEY_ID: ${MINIO_ROOT_USER:?')
    expect(compose).toContain('MINIO_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:?')
    expect(release).toContain('secret env file must have mode 0600')
    expect(release).toContain('org.opencontainers.image.revision')
    expect(release).not.toMatch(/docker compose config/)
  })

  test('ships the secret-safe production smoke entrypoint', () => {
    const smoke = fs.readFileSync(path.join(root, 'scripts/production-smoke.mjs'), 'utf8')
    expect(smoke).toContain('--origin')
    expect(smoke).toContain('mode 0600')
    expect(smoke).toContain('cookie: "redacted"')
    expect(smoke).not.toContain('console.log(cookie)')
  })

  test('does not publish ports or use fixed container names', () => {
    expect(compose).not.toMatch(/^\s+ports:/m)
    expect(compose).not.toMatch(/^\s+container_name:/m)
    expect(compose).not.toContain('traefik-public:')
    expect(compose).toContain('proxy-net:')
    expect(compose).not.toContain('backend-v2')
    const ingress = fs.readFileSync(path.join(root, 'compose.production.traefik.yaml'), 'utf8')
    expect(ingress).toContain('traefik-public:')
    expect(ingress).toContain('pagelm-frontend')
    expect(ingress).toContain('pagelm-backend')
    expect(ingress).not.toContain('archive.qai.lge.com')
  })

  test('exposes controlled lifecycle and recovery commands', () => {
    for (const command of ['readiness', 'isolated-readiness', 'status', 'deploy', 'rollback']) {
      expect(release).toContain(`${command})`)
    }
    expect(release).toContain('previous-revision')
    expect(release).toContain('readiness.json')
  })

  test('removes isolated containers when readiness fails', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pagelm-release-'))
    const bin = path.join(fixture, 'bin')
    const envFile = path.join(fixture, 'production.env')
    const dockerLog = path.join(fixture, 'docker.log')
    const sha = '475affba0bb52f1b144482248f6b3e644b7c31b6'
    const digest = 'a'.repeat(64)

    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, 'docker'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PAGELM_DOCKER_LOG"\ncase " $* " in *" image inspect "*) printf "%s\\n" "$PAGELM_RELEASE_SHA";; *" up -d --wait "*) exit 17;; esac\nexit 0\n',
      { mode: 0o755 },
    )
    fs.writeFileSync(
      envFile,
      `PAGELM_RELEASE_SHA=${sha}\nPAGELM_BACKEND_IMAGE=registry.invalid/backend:${sha}@sha256:${digest}\nPAGELM_FRONTEND_IMAGE=registry.invalid/frontend:${sha}@sha256:${digest}\n`,
      { mode: 0o600 },
    )

    try {
      const result = spawnSync('/bin/sh', [path.join(root, 'scripts/production-release.sh'), 'isolated-readiness'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PAGELM_ENV_FILE: envFile,
          PAGELM_DOCKER_LOG: dockerLog,
          PAGELM_STATE_DIR: path.join(fixture, 'state'),
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(17)
      const invocations = fs.readFileSync(dockerLog, 'utf8')
      expect(invocations).toContain('up -d --wait')
      expect(invocations).toContain('down')
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('rejects an image whose OCI revision differs from the release SHA', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pagelm-provenance-'))
    const bin = path.join(fixture, 'bin')
    const envFile = path.join(fixture, 'production.env')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ncase " $* " in *" image inspect "*) printf wrong-revision;; esac\n', { mode: 0o755 })
    const sha = '475affba0bb52f1b144482248f6b3e644b7c31b6'
    fs.writeFileSync(envFile, `PAGELM_RELEASE_SHA=${sha}\nPAGELM_BACKEND_IMAGE=registry.invalid/backend:${sha}@sha256:${'a'.repeat(64)}\nPAGELM_FRONTEND_IMAGE=registry.invalid/frontend:${sha}@sha256:${'b'.repeat(64)}\n`, { mode: 0o600 })
    try {
      const result = spawnSync('/bin/sh', [path.join(root, 'scripts/production-release.sh'), 'status'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PAGELM_ENV_FILE: envFile }, encoding: 'utf8' })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('OCI revision does not match')
    } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
  })
})
