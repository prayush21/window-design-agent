# Optional: start the server + tunnel automatically when you log in to Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\autostart.ps1          (install)
#   powershell -ExecutionPolicy Bypass -File scripts\windows\autostart.ps1 -Remove  (uninstall)
param([switch]$Remove)
$name = "WindowDesignAgent"
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "Removed."; exit }
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $root `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\windows\start.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Installed. It runs at your next login; the public URL will be in tunnel-url.txt."
