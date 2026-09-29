# Starts the Laya server. The scheduled task runs this through conhost --headless, so no window appears.
# Settings come from defaults below, then from server.env beside this file (KEY=VALUE per line, # for comments).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$defaults = @{
  LAYA_HOME = $root; HF_HOME = (Join-Path $root 'hf'); HF_HUB_OFFLINE = '1'; LAYA_REVISION = 'reviewed'
  LAYA_HOST = '127.0.0.1'; LAYA_PORT = '8010'; LAYA_PRELOAD = '1'; PYTHONIOENCODING = 'utf-8'
}
foreach ($k in $defaults.Keys) { Set-Item -Path "Env:$k" -Value $defaults[$k] }
$file = Join-Path $root 'server.env'
if (Test-Path $file) {
  foreach ($line in Get-Content $file) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith('#')) { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
  }
}
& (Join-Path $root 'venv\Scripts\python.exe') (Join-Path $root 'lora\serve_lora.py') *>> (Join-Path $root 'logs\server.log')
