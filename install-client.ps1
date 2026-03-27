param(
  [string]$RepoUrl = 'https://github.com/QRUXEL/stream-manager-client.git',
  [string]$Branch = 'main',
  [string]$InstallRoot,
  [switch]$ForceFresh
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) {
  Write-Host "[stream-manager-bootstrap] $Message"
}

function Resolve-DefaultInstallRoot {
  $base = ''
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $base = $env:USERPROFILE
  }
  elseif (-not [string]::IsNullOrWhiteSpace($env:HOMEDRIVE) -and -not [string]::IsNullOrWhiteSpace($env:HOMEPATH)) {
    $base = "$($env:HOMEDRIVE)$($env:HOMEPATH)"
  }
  else {
    $base = 'C:\Users\Public'
  }

  return Join-Path $base 'stream-manager-client'
}

function Refresh-ProcessPath {
  $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
}

function Ensure-GitInstalled {
  if (Get-Command git -ErrorAction SilentlyContinue) {
    return
  }

  Write-Info 'Git not found. Installing with winget...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is not available. Install Git manually, then re-run this bootstrap script.'
  }

  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw 'Git installation failed.'
  }

  Refresh-ProcessPath
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git appears installed but is not available on PATH yet. Open a new terminal and retry.'
  }
}

function Ensure-Repo([string]$TargetPath, [string]$TargetRepoUrl, [string]$TargetBranch, [bool]$Recreate) {
  if ($Recreate -and (Test-Path -Path $TargetPath)) {
    Write-Info "Removing existing folder at $TargetPath"
    Remove-Item -Path $TargetPath -Recurse -Force
  }

  $gitDir = Join-Path $TargetPath '.git'
  if (Test-Path -Path $gitDir) {
    Write-Info "Updating existing client repository at $TargetPath"
    Push-Location $TargetPath
    try {
      git remote set-url origin $TargetRepoUrl *> $null
      git fetch --prune origin
      if ($LASTEXITCODE -ne 0) {
        throw 'git fetch failed'
      }

      git checkout $TargetBranch
      if ($LASTEXITCODE -ne 0) {
        throw "git checkout $TargetBranch failed"
      }

      git pull --ff-only origin $TargetBranch
      if ($LASTEXITCODE -ne 0) {
        throw 'git pull --ff-only failed'
      }
    }
    finally {
      Pop-Location
    }
    return
  }

  if (Test-Path -Path $TargetPath) {
    $entries = Get-ChildItem -Path $TargetPath -Force -ErrorAction SilentlyContinue
    if ($entries -and $entries.Count -gt 0) {
      $backupPath = "$TargetPath.backup.$((Get-Date).ToString('yyyyMMddHHmmss'))"
      Write-Info "Existing non-git folder detected. Moving it to $backupPath"
      Move-Item -Path $TargetPath -Destination $backupPath -Force
    }
  }

  Write-Info "Cloning client repository from $TargetRepoUrl (branch $TargetBranch) into $TargetPath"
  git clone --branch $TargetBranch $TargetRepoUrl $TargetPath
  if ($LASTEXITCODE -ne 0) {
    throw 'git clone failed'
  }
}

function Try-GetOriginFromPath([string]$PathToCheck) {
  if ([string]::IsNullOrWhiteSpace($PathToCheck)) {
    return $null
  }

  $gitDir = Join-Path $PathToCheck '.git'
  if (-not (Test-Path -Path $gitDir)) {
    return $null
  }

  $origin = (& git -C $PathToCheck remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
    return $null
  }

  return ($origin | Out-String).Trim()
}

function Resolve-RepoUrl([string]$ExplicitRepoUrl) {
  if (-not [string]::IsNullOrWhiteSpace($ExplicitRepoUrl)) {
    return $ExplicitRepoUrl
  }

  if (-not [string]::IsNullOrWhiteSpace($env:STREAM_MANAGER_REPO_URL)) {
    return $env:STREAM_MANAGER_REPO_URL
  }

  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $candidates += (Join-Path $PSScriptRoot 'client')
    $candidates += $PSScriptRoot
  }
  $candidates += (Get-Location).Path

  foreach ($candidate in $candidates) {
    $origin = Try-GetOriginFromPath -PathToCheck $candidate
    if (-not [string]::IsNullOrWhiteSpace($origin)) {
      Write-Info "Detected client repo URL from local git checkout: $origin"
      return $origin
    }
  }

  return 'https://github.com/QRUXEL/stream-manager-client.git'
}

function Resolve-SetupScriptPath([string]$RootPath) {
  $candidatePaths = @(
    (Join-Path $RootPath 'setup-client.ps1'),
    (Join-Path $RootPath 'client\setup-client.ps1')
  )

  foreach ($candidate in $candidatePaths) {
    if (Test-Path -Path $candidate) {
      return $candidate
    }
  }

  return $null
}

Ensure-GitInstalled
$RepoUrl = Resolve-RepoUrl -ExplicitRepoUrl $RepoUrl

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Resolve-DefaultInstallRoot
}

Ensure-Repo -TargetPath $InstallRoot -TargetRepoUrl $RepoUrl -TargetBranch $Branch -Recreate:$ForceFresh

$setupScript = Resolve-SetupScriptPath -RootPath $InstallRoot
if ([string]::IsNullOrWhiteSpace($setupScript)) {
  throw "Setup script not found in $InstallRoot (expected setup-client.ps1 or client\\setup-client.ps1)."
}

Write-Info 'Launching client setup script...'
& powershell -NoProfile -ExecutionPolicy Bypass -File $setupScript
if ($LASTEXITCODE -ne 0) {
  throw "Client setup script failed with exit code $LASTEXITCODE"
}

Write-Info 'Bootstrap complete.'
