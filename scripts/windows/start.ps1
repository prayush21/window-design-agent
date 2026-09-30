# Starts the server and a free Cloudflare quick tunnel, then prints the public URL.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
# Leave the window open. The URL changes each time the tunnel restarts; it is also
# written to tunnel-url.txt. Restarts the server if it crashes.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

if (-not (Test-Path .env)) { throw ".env missing - run scripts\windows\setup.ps1 first." }
$envText = Get-Content .env -Raw
if ($envText -notmatch '(?m)^ACCESS_PASSCODE=\S+') { throw "ACCESS_PASSCODE is empty in .env. Refusing to open a public tunnel without it." }
$port = if ($envText -match '(?m)^PORT=(\d+)') { $Matches[1] } else { "3000" }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { throw "cloudflared not found. Run setup.ps1, then open a new terminal." }

New-Item -ItemType Directory -Force var | Out-Null
$tunnelLog = Join-Path $root "var\tunnel.log"
Remove-Item $tunnelLog -ErrorAction SilentlyContinue

$tunnel = Start-Process cloudflared -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$port" `
  -RedirectStandardError $tunnelLog -RedirectStandardOutput (Join-Path $root "var\tunnel.out.log") -PassThru -WindowStyle Hidden

try {
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLog) {
      $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value }
    }
  }
  if ($url) {
    Set-Content -Path (Join-Path $root "tunnel-url.txt") -Value $url
    Write-Host "`nPublic URL: $url" -ForegroundColor Green
    Write-Host "Share it with the passcode from .env (ACCESS_PASSCODE).`n"
  } else {
    Write-Warning "Tunnel URL not found yet - check var\tunnel.log"
  }

  while ($true) {
    Write-Host "Starting server on 127.0.0.1:$port ($(Get-Date -Format s))"
    node src/server.js
    Write-Warning "Server exited (code $LASTEXITCODE). Restarting in 5 s; Ctrl+C to stop."
    Start-Sleep -Seconds 5
  }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
}
