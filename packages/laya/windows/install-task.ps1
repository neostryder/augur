# Registers the Laya server as a logon task for the current user. No administrator rights needed.
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'Augur\laya'))
$pwsh = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$pwsh`" -NoProfile -File `"$Root\run-laya.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Augur Laya' -Action $action -Trigger $trigger -Settings $settings -Description 'Local Laya decision model for Augur' -Force | Out-Null
'registered'
