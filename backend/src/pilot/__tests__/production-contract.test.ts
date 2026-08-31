import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd())
const compose = fs.readFileSync(path.join(root, 'compose.production.yaml'), 'utf8')
const release = fs.readFileSync(path.join(root, 'scripts/production-release.sh'), 'utf8')

describe('production deployment contract', () => {
  test('uses digest-pinned release images and the full source SHA', () => {
    expect(compose).toContain('PAGELM_BACKEND_IMAGE:?')
    expect(compose).toContain('PAGELM_FRONTEND_IMAGE:?')
    expect(release).toContain("PAGELM_RELEASE_SHA")
    expect(release).toContain("'^[0-9a-fA-F]{40}$'")
  })

  test('keeps secrets in the mode-0600 production env file', () => {
    expect(compose).toContain('/srv/secrets/pagelm/production.env')
    expect(compose).not.toMatch(/MINIO_ROOT_PASSWORD:\s+minioadmin/)
    expect(release).toContain('secret env file must have mode 0600')
    expect(release).not.toMatch(/docker compose config/)
  })

  test('does not publish ports or use fixed container names', () => {
    expect(compose).not.toMatch(/^\s+ports:/m)
    expect(compose).not.toMatch(/^\s+container_name:/m)
    expect(compose).toContain('traefik-public:')
    expect(compose).toContain('pagelm-frontend')
    expect(compose).toContain('pagelm-backend')
  })

  test('exposes controlled lifecycle and recovery commands', () => {
    for (const command of ['readiness', 'status', 'deploy', 'rollback']) {
      expect(release).toContain(`${command})`)
    }
    expect(release).toContain('previous-revision')
    expect(release).toContain('readiness.json')
  })
})
