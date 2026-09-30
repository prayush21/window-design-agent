# One-time setup on the Windows machine. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

Step "Node.js 20 or newer"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found. Install the LTS from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new terminal, and rerun." }
$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 20) { throw "Node $(node -v) is too old; need 20 or newer." }
Write-Host "node $(node -v)"

Step "Installing dependencies"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

Step "cloudflared (makes the public tunnel)"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
    Write-Host "Installed. If start.ps1 cannot find cloudflared, open a new terminal so PATH refreshes."
  } else {
    Write-Warning "Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ then rerun."
  }
} else { Write-Host "already installed" }

Step ".env"
if (-not (Test-Path .env)) {
  Copy-Item .env.windows.example .env
  $bytes = New-Object byte[] 9
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $passcode = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', 'x')
  (Get-Content .env) -replace '^ACCESS_PASSCODE=.*', "ACCESS_PASSCODE=$passcode" | Set-Content .env -Encoding utf8
  Write-Host "Created .env with a generated passcode: $passcode"
  Write-Host "Now add GEMINI_API_KEY (and OPENAI_API_KEY if you use it) - opening Notepad."
  Start-Process notepad.exe (Join-Path $root ".env")
} else { Write-Host ".env already exists, left alone" }

Step "Catalog"
$catalog = Join-Path $root "Product Catalog V2-clean"
if (Test-Path $catalog) {
  $count = (Get-ChildItem $catalog -Recurse -File | Measure-Object).Count
  Write-Host "Found '$catalog' ($count files)"
} else {
  Write-Warning "No 'Product Catalog V2-clean' folder in the repo root. Unzip the catalog so this folder sits next to package.json (not one level deeper), or edit DESIGN_AGENT_CATALOG_DIR in .env. Without it the server falls back to the small v1 sample."
}

Step "Keep the machine awake while plugged in"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "Sleep on AC power: never. (Also set Windows Update 'active hours' so it does not reboot mid-run.)"

Step "Offline test suite"
npm test
if ($LASTEXITCODE -ne 0) { Write-Warning "Some tests failed - see output above." }

Write-Host "`nSetup done. Start it with: powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1" -ForegroundColor Green
