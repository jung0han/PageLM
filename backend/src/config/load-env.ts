import fs from "fs"
import path from "path"

/** Load a developer .env when present. Runtime-injected environment wins. */
export function loadLocalEnv(): void {
  const file = path.resolve(process.cwd(), ".env")
  if (fs.existsSync(file)) process.loadEnvFile(file)
}
