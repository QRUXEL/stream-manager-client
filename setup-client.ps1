$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

if (-not (Test-Path -Path .\ffplay.exe)) {
  Write-Host 'Copying ffplay.exe from c:\tools\ffplay.exe to client folder...'
  Copy-Item -Path 'c:\tools\ffplay.exe' -Destination (Join-Path $PSScriptRoot 'ffplay.exe') -Force
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Bun...'
  $installScript = Invoke-RestMethod -Uri 'https://bun.sh/install.ps1'
  Invoke-Expression $installScript
}

$bunBin = Join-Path $env:USERPROFILE '.bun\bin'
if (Test-Path $bunBin) {
  if (($env:Path -split ';') -notcontains $bunBin) {
    $env:Path = "$bunBin;$env:Path"
  }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw 'Bun was not found after installation.'
}

bun --version
bun install
bun run client
