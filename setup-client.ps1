$ErrorActionPreference = 'Stop'

$ExitCodeClientRestart = 90
$ExitCodeClientForceUpdate = 91

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

function Get-FfplayCommand {
  $ffplay = Get-Command ffplay.exe -ErrorAction SilentlyContinue
  if ($ffplay) {
    return $ffplay
  }

  return (Get-Command ffplay -ErrorAction SilentlyContinue)
}

function Ensure-FfplayInstalled {
  $localFfplayPath = Join-Path $PSScriptRoot 'ffplay.exe'
  if (Test-Path -Path $localFfplayPath) {
    return
  }

  $ffplayCommand = Get-FfplayCommand
  if (-not $ffplayCommand) {
    Write-Host 'ffplay not found. Installing FFmpeg with winget...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget is not available; cannot auto-install FFmpeg.'
    }

    winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Primary FFmpeg package install failed. Trying fallback package ID...'
      winget install --id FFmpeg.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -ne 0) {
        throw 'FFmpeg installation via winget failed.'
      }
    }

    Refresh-ProcessPath
    $ffplayCommand = Get-FfplayCommand
  }

  if (-not $ffplayCommand) {
    throw 'ffplay was not found after FFmpeg installation.'
  }

  $ffplaySource = $ffplayCommand.Source
  if ([string]::IsNullOrWhiteSpace($ffplaySource) -and $ffplayCommand.PSObject.Properties['Path']) {
    $ffplaySource = $ffplayCommand.Path
  }

  if ([string]::IsNullOrWhiteSpace($ffplaySource) -or -not (Test-Path -Path $ffplaySource)) {
    throw 'Unable to resolve ffplay executable path after installation.'
  }

  Write-Host "Copying ffplay.exe from $ffplaySource to client folder..."
  Copy-Item -Path $ffplaySource -Destination $localFfplayPath -Force
}

function Get-GstreamerCommand {
  $gstPlay = Get-Command gst-play-1.0.exe -ErrorAction SilentlyContinue
  if ($gstPlay) {
    return $gstPlay
  }

  $gstPlay = Get-Command gst-play-1.0 -ErrorAction SilentlyContinue
  if ($gstPlay) {
    return $gstPlay
  }

  $gstLaunch = Get-Command gst-launch-1.0.exe -ErrorAction SilentlyContinue
  if ($gstLaunch) {
    return $gstLaunch
  }

  return (Get-Command gst-launch-1.0 -ErrorAction SilentlyContinue)
}

function Find-GstreamerExecutableFromCommonPaths {
  $pathCandidates = @()
  $roots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:LOCALAPPDATA,
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    'C:\gstreamer'
  )

  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root)) {
      continue
    }

    $pathCandidates += (Join-Path $root 'GStreamer\1.0\msvc_x86_64\bin\gst-play-1.0.exe')
    $pathCandidates += (Join-Path $root 'GStreamer\1.0\msvc_x86\bin\gst-play-1.0.exe')
    $pathCandidates += (Join-Path $root 'GStreamer\1.0\msvc_x86_64\bin\gst-launch-1.0.exe')
    $pathCandidates += (Join-Path $root 'GStreamer\1.0\msvc_x86\bin\gst-launch-1.0.exe')
    $pathCandidates += (Join-Path $root 'gstreamer\1.0\msvc_x86_64\bin\gst-play-1.0.exe')
    $pathCandidates += (Join-Path $root 'gstreamer\1.0\msvc_x86\bin\gst-play-1.0.exe')
    $pathCandidates += (Join-Path $root 'gstreamer\1.0\msvc_x86_64\bin\gst-launch-1.0.exe')
    $pathCandidates += (Join-Path $root 'gstreamer\1.0\msvc_x86\bin\gst-launch-1.0.exe')
    $pathCandidates += (Join-Path $root '1.0\msvc_x86_64\bin\gst-play-1.0.exe')
    $pathCandidates += (Join-Path $root '1.0\msvc_x86\bin\gst-play-1.0.exe')
    $pathCandidates += (Join-Path $root '1.0\msvc_x86_64\bin\gst-launch-1.0.exe')
    $pathCandidates += (Join-Path $root '1.0\msvc_x86\bin\gst-launch-1.0.exe')
  }

  foreach ($candidate in $pathCandidates) {
    if (Test-Path -Path $candidate) {
      $binDir = Split-Path -Path $candidate -Parent
      if (-not [string]::IsNullOrWhiteSpace($binDir)) {
        $pathEntries = $env:Path -split ';'
        if ($pathEntries -notcontains $binDir) {
          $env:Path = "$binDir;$env:Path"
        }
      }

      return $candidate
    }
  }

  return $null
}

function Find-GstreamerExecutableWithWhere {
  $commands = @('gst-play-1.0.exe', 'gst-play-1.0', 'gst-launch-1.0.exe', 'gst-launch-1.0')
  foreach ($commandName in $commands) {
    $matches = (& where.exe $commandName 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $matches) {
      continue
    }

    foreach ($match in $matches) {
      $candidate = ($match | Out-String).Trim()
      if ([string]::IsNullOrWhiteSpace($candidate)) {
        continue
      }

      if (Test-Path -Path $candidate) {
        return $candidate
      }
    }
  }

  return $null
}

function Find-GstreamerExecutableWithRecursiveSearch {
  $roots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:LOCALAPPDATA,
    'C:\gstreamer'
  )

  $targets = @('gst-play-1.0.exe', 'gst-launch-1.0.exe')
  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -Path $root)) {
      continue
    }

    foreach ($target in $targets) {
      $match = Get-ChildItem -Path $root -Filter $target -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($match) {
        return $match.FullName
      }
    }
  }

  return $null
}

function Resolve-GstreamerExecutablePath {
  $fromWhere = Find-GstreamerExecutableWithWhere
  if ($fromWhere) {
    return $fromWhere
  }

  $gstCommand = Get-GstreamerCommand
  if ($gstCommand) {
    $source = $gstCommand.Source
    if ([string]::IsNullOrWhiteSpace($source) -and $gstCommand.PSObject.Properties['Path']) {
      $source = $gstCommand.Path
    }

    if (-not [string]::IsNullOrWhiteSpace($source) -and (Test-Path -Path $source)) {
      return $source
    }
  }

  $fromCommonPaths = Find-GstreamerExecutableFromCommonPaths
  if ($fromCommonPaths) {
    return $fromCommonPaths
  }

  return Find-GstreamerExecutableWithRecursiveSearch
}

function Ensure-GstreamerInstalled {
  $gstSource = Resolve-GstreamerExecutablePath
  if (-not $gstSource) {
    Write-Host 'GStreamer not found. Installing with winget...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget is not available; cannot auto-install GStreamer.'
    }

    $packageIds = @(
      'GStreamer.GStreamer',
      'GStreamer.GStreamer.1.0',
      'GStreamerProject.GStreamer'
    )

    $installed = $false
    foreach ($packageId in $packageIds) {
      winget install --id $packageId -e --source winget --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) {
        $installed = $true
        break
      }

      Write-Host "winget did not install/update package ID $packageId. Trying next option..."
    }

    if (-not $installed) {
      Write-Host 'GStreamer install by package ID failed. Trying name-based install...'
      winget install --name GStreamer -e --source winget --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) {
        $installed = $true
      }
      else {
        Write-Host 'winget name-based install did not apply an install/update. Continuing with binary discovery...'
      }
    }

    Refresh-ProcessPath
    $gstSource = Resolve-GstreamerExecutablePath
  }

  if (-not $gstSource) {
      throw 'GStreamer was not found after installation. Checked PATH, where.exe, common install folders, and recursive discovery roots.'
  }

  if ([string]::IsNullOrWhiteSpace($gstSource) -or -not (Test-Path -Path $gstSource)) {
    throw 'Unable to resolve GStreamer executable path after installation.'
  }

  & $gstSource --version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'GStreamer command was found but failed to execute.'
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
Ensure-FfplayInstalled
Ensure-GstreamerInstalled

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

while ($true) {
  Write-Host 'Starting client runtime...'
  bun run client
  $exitCode = $LASTEXITCODE

  if ($exitCode -eq $ExitCodeClientForceUpdate) {
    Write-Host 'Client requested FORCE UPDATE. Refreshing from GitHub before restart...'
    Ensure-GitInstalled
    Update-ClientFromGitHub
    bun install
    Start-Sleep -Seconds 1
    continue
  }

  if ($exitCode -eq $ExitCodeClientRestart) {
    Write-Host 'Client requested restart. Restarting runtime...'
    Start-Sleep -Seconds 1
    continue
  }

  if ($exitCode -eq 0) {
    Write-Host 'Client exited normally. Restarting runtime...'
    Start-Sleep -Seconds 1
    continue
  }

  Write-Host "Client exited with code $exitCode. Restarting runtime..."
  Start-Sleep -Seconds 2
}
