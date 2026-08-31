import { createApp } from './app'
import { config } from '../config/env'
import { readArchiveSnapshotFile } from '../shared/snapshot'

async function main() {
  if (config.archiveSnapshotFile) {
    const report = await readArchiveSnapshotFile(config.archiveSnapshotFile)
    console.log('[pagelm] Archive snapshot absorbed', report)
  }

  const app = createApp()
  app.listen(Number.parseInt(process.env.PORT || '5000'), () => {
    console.log(`[pagelm] running on ${process.env.VITE_BACKEND_URL}`)
  })
}

main().catch(() => {
  console.error('[pagelm] startup failed')
  process.exitCode = 1
})
