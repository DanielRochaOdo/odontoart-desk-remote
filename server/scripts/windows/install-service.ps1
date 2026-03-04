param(
  [string]$ServiceName = "RemoteSupportServer",
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$serverDir = Resolve-Path (Join-Path $PSScriptRoot "..\\..")
$distPath = Join-Path $serverDir "dist\\index.js"

if (!(Test-Path $distPath)) {
  if ($SkipBuild) {
    throw "Arquivo dist/index.js nao encontrado. Rode npm run build no servidor."
  }
  Push-Location $serverDir
  if (!(Test-Path "node_modules")) {
    npm install
  }
  npm run build
  Pop-Location
}

$nodePath = (Get-Command node -ErrorAction Stop).Source

$toolsDir = Join-Path $serverDir "tools\\nssm"
$nssmExe = Join-Path $toolsDir "nssm.exe"
if (!(Test-Path $nssmExe)) {
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $zipUrl = "https://nssm.cc/release/nssm-2.24.zip"
  $zipPath = Join-Path $toolsDir "nssm.zip"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  $extractDir = Join-Path $env:TEMP ("nssm-" + [guid]::NewGuid())
  Expand-Archive -Path $zipPath -DestinationPath $extractDir
  $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
  $sourceExe = Join-Path $extractDir "nssm-2.24\\$arch\\nssm.exe"
  Copy-Item -Force $sourceExe $nssmExe
  Remove-Item -Force $zipPath
  Remove-Item -Recurse -Force $extractDir
}

$logDir = Join-Path $serverDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  & $nssmExe install $ServiceName $nodePath
}

& $nssmExe set $ServiceName AppDirectory $serverDir
& $nssmExe set $ServiceName AppParameters "`"$distPath`""
& $nssmExe set $ServiceName AppStdout (Join-Path $logDir "server.out.log")
& $nssmExe set $ServiceName AppStderr (Join-Path $logDir "server.err.log")
& $nssmExe set $ServiceName AppRotateFiles 1
& $nssmExe set $ServiceName AppRotateOnline 1
& $nssmExe set $ServiceName AppRotateBytes 10485760
& $nssmExe set $ServiceName AppRotateSeconds 86400
& $nssmExe set $ServiceName Start SERVICE_AUTO_START
& $nssmExe set $ServiceName AppEnvironmentExtra "NODE_ENV=production"

& $nssmExe start $ServiceName

Write-Host "Servico instalado/iniciado: $ServiceName"
Write-Host "Logs: $logDir"
