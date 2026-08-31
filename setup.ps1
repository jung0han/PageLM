# Requires PowerShell 7+
$ErrorActionPreference = "Stop"

npm ci --legacy-peer-deps
corepack enable
corepack prepare pnpm@10.13.1 --activate
Push-Location frontend
pnpm install --frozen-lockfile
Pop-Location

# Setup environment
if (-Not (Test-Path ".env")) {
    Copy-Item .env.example .env
}

$backend = Start-Process npm -ArgumentList "run", "dev" -PassThru
$frontend = Start-Process pnpm -ArgumentList "dev" -WorkingDirectory "frontend" -PassThru

# Wait for both processes to exit
$backend.WaitForExit()
$frontend.WaitForExit()
