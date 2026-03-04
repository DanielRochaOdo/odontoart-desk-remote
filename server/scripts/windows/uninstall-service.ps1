param(
  [string]$ServiceName = "RemoteSupportServer"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$serverDir = Resolve-Path (Join-Path $PSScriptRoot "..\\..")
$nssmExe = Join-Path $serverDir "tools\\nssm\\nssm.exe"

if (!(Test-Path $nssmExe)) {
  throw "nssm.exe nao encontrado. Rode o install-service.ps1 primeiro."
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  Write-Host "Servico nao encontrado: $ServiceName"
  exit 0
}

& $nssmExe stop $ServiceName
& $nssmExe remove $ServiceName confirm

Write-Host "Servico removido: $ServiceName"
