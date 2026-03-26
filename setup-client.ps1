$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

function Refresh-ProcessPath {
  $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
}

function Ensure-GitInstalled {
  if (Get-Command git -ErrorAction SilentlyContinue) {
    return
  }

  Write-Host 'Git not found. Installing with winget...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is not available; cannot auto-install Git.'
  }

  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw 'Git installation via winget failed.'
  }

  Refresh-ProcessPath
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git was installed but is not available on PATH. Restart the terminal and retry.'
  }
}

function Update-ClientFromGitHub {
  $repoRoot = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    Write-Host 'No local git repository found. Skipping update check.'
    return
  }

  Push-Location $repoRoot
  try {
    $originUrl = (& git remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($originUrl)) {
      Write-Host 'No origin remote configured. Skipping update check.'
      return
    }

    if ($originUrl -notmatch 'github\.com') {
      Write-Host "Origin remote is not GitHub ($originUrl). Skipping auto-update."
      return
    }

    $localChanges = (& git status --porcelain)
    if (-not [string]::IsNullOrWhiteSpace($localChanges)) {
      Write-Host 'Local changes detected. Skipping auto-update to avoid overwrite.'
      return
    }

    Write-Host 'Checking for updates from GitHub...'
    & git fetch --prune origin
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Fetch failed. Continuing with local files.'
      return
    }

    $upstream = (& git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($upstream)) {
      $branch = (& git branch --show-current)
      if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
        Write-Host 'Could not determine current branch. Skipping update pull.'
        return
      }

      & git branch --set-upstream-to "origin/$branch" $branch *> $null
      $upstream = (& git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
      if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($upstream)) {
        Write-Host 'No upstream tracking branch is configured. Skipping update pull.'
        return
      }
    }

    $behindCountText = (& git rev-list --count "HEAD..$upstream")
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Could not determine update status. Skipping update pull.'
      return
    }

    $behindCount = 0
    [void][int]::TryParse(($behindCountText | Out-String).Trim(), [ref]$behindCount)
    if ($behindCount -le 0) {
      Write-Host 'Client is already up to date.'
      return
    }

    Write-Host "Updating client from $upstream ($behindCount commits behind)..."
    & git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Update pull failed. Continuing with current local files.'
      return
    }

    Write-Host 'Client files updated from GitHub.'
  }
  finally {
    Pop-Location
  }
}

Ensure-GitInstalled
Update-ClientFromGitHub

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
