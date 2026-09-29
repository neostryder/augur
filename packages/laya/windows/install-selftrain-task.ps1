# Registers the nightly self-training run for the current user. It trains only while the PC is idle and on mains power, and does nothing until enough new decisions exist.
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'Augur\laya'), [string]$Time = '03:30')
$python = Join-Path $Root 'venv\Scripts\python.exe'
$script = Join-Path $Root 'lora\selftrain.py'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$python`" `"$script`" run"
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName 'Augur Laya self-training' -Action $action -Trigger $trigger -Settings $settings -Description 'Trains Laya adapters from Augur decisions when enough new ones exist' -Force | Out-Null
'registered'
