$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv .venv
    & $pythonPath -m pip install -r requirements-lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies.' }
}
$url = 'http://localhost:8795'
try {
    $existing = Invoke-RestMethod "$url/api/info" -TimeoutSec 2
    if ($existing.data_path -ne (Join-Path $PSScriptRoot 'data')) { throw 'Another service is using this port.' }
    Start-Process $url
    Write-Host "Trazo is already running at $url"
    exit 0
} catch {}
Start-Process -FilePath $pythonPath -ArgumentList 'server.py' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $info = Invoke-RestMethod "$url/api/info" -TimeoutSec 2
        Write-Host "PC: $url"
        Write-Host "iPad: $($info.url)"
        Start-Process $url
        exit 0
    } catch {}
}
throw 'Could not start Trazo. Check server-error.log.'
