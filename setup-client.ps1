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

function Add-ToPathIfMissing([string]$PathEntry) {
  if ([string]::IsNullOrWhiteSpace($PathEntry)) {
    return
  }

  if (-not (Test-Path -Path $PathEntry)) {
    return
  }

  $pathEntries = $env:Path -split ';'
  if ($pathEntries -notcontains $PathEntry) {
    $env:Path = "$PathEntry;$env:Path"
  }
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
      Add-ToPathIfMissing -PathEntry $binDir

      return $candidate
    }
  }

  return $null
}

function Find-GstreamerExecutableWithWhere {
  $commands = @('gst-play-1.0.exe', 'gst-play-1.0', 'gst-launch-1.0.exe', 'gst-launch-1.0')
  foreach ($commandName in $commands) {
    $cmdOutput = (& cmd.exe /c "where $commandName 2>nul")
    $matches = @($cmdOutput | ForEach-Object { ($_ | Out-String).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($LASTEXITCODE -ne 0 -or -not $matches) {
      continue
    }

    foreach ($match in $matches) {
      $candidate = $match
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

function Find-GstreamerInstallRootsFromRegistry {
  $roots = @()
  $registryPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  foreach ($registryPath in $registryPaths) {
    $items = Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      $displayName = [string]$item.DisplayName
      if ([string]::IsNullOrWhiteSpace($displayName) -or $displayName -notmatch 'GStreamer') {
        continue
      }

      foreach ($propertyName in @('InstallLocation', 'InstallSource')) {
        $value = [string]$item.$propertyName
        if (-not [string]::IsNullOrWhiteSpace($value) -and (Test-Path -Path $value)) {
          $roots += $value
        }
      }
    }
  }

  if ($roots.Count -eq 0) {
    return @()
  }

  return ($roots | Select-Object -Unique)
}

function Find-GstreamerExecutableFromRegistry {
  $installRoots = Find-GstreamerInstallRootsFromRegistry
  if ($installRoots.Count -eq 0) {
    return $null
  }

  $relativeCandidates = @(
    'bin\gst-play-1.0.exe',
    'bin\gst-launch-1.0.exe',
    'msvc_x86_64\bin\gst-play-1.0.exe',
    'msvc_x86\bin\gst-play-1.0.exe',
    'msvc_x86_64\bin\gst-launch-1.0.exe',
    'msvc_x86\bin\gst-launch-1.0.exe',
    '1.0\msvc_x86_64\bin\gst-play-1.0.exe',
    '1.0\msvc_x86\bin\gst-play-1.0.exe',
    '1.0\msvc_x86_64\bin\gst-launch-1.0.exe',
    '1.0\msvc_x86\bin\gst-launch-1.0.exe'
  )

  foreach ($root in $installRoots) {
    foreach ($relativeCandidate in $relativeCandidates) {
      $candidate = Join-Path $root $relativeCandidate
      if (Test-Path -Path $candidate) {
        return $candidate
      }
    }
  }

  return $null
}

function Resolve-GstreamerExecutableCandidates {
  $candidates = @()

  $fromWhere = Find-GstreamerExecutableWithWhere
  if ($fromWhere) {
    $candidates += $fromWhere
  }

  $gstCommand = Get-GstreamerCommand
  if ($gstCommand) {
    $source = $gstCommand.Source
    if ([string]::IsNullOrWhiteSpace($source) -and $gstCommand.PSObject.Properties['Path']) {
      $source = $gstCommand.Path
    }

    if (-not [string]::IsNullOrWhiteSpace($source) -and (Test-Path -Path $source)) {
      $candidates += $source
    }
  }

  $fromCommonPaths = Find-GstreamerExecutableFromCommonPaths
  if ($fromCommonPaths) {
    $candidates += $fromCommonPaths
  }

  $fromRegistry = Find-GstreamerExecutableFromRegistry
  if ($fromRegistry) {
    $candidates += $fromRegistry
  }

  $fromRecursive = Find-GstreamerExecutableWithRecursiveSearch
  if ($fromRecursive) {
    $candidates += $fromRecursive
  }

  if ($candidates.Count -eq 0) {
    return @()
  }

  return ($candidates | Select-Object -Unique)
}

function Get-RunnableGstreamerExecutable {
  $candidates = Resolve-GstreamerExecutableCandidates
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -Path $candidate)) {
      continue
    }

    $binDir = Split-Path -Path $candidate -Parent
    Add-ToPathIfMissing -PathEntry $binDir

    try {
      & $candidate --version *> $null
      if ($LASTEXITCODE -eq 0) {
        return $candidate
      }
    }
    catch {
      Write-Host "Discovered gstreamer candidate is not runnable: $candidate"
    }
  }

  return $null
}

function Ensure-GstreamerInstalled {
  $gstSource = Get-RunnableGstreamerExecutable
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
    $gstSource = Get-RunnableGstreamerExecutable
  }

  if (-not $gstSource) {
      throw 'GStreamer was not found after installation. Checked PATH, where.exe, common install folders, and recursive discovery roots.'
  }

  if ([string]::IsNullOrWhiteSpace($gstSource) -or -not (Test-Path -Path $gstSource)) {
    throw 'Unable to resolve GStreamer executable path after installation.'
  }

  Write-Host "Using GStreamer executable: $gstSource"
}

function Get-MpvCommand {
  $mpv = Get-Command mpv.exe -ErrorAction SilentlyContinue
  if ($mpv) {
    return $mpv
  }

  return (Get-Command mpv -ErrorAction SilentlyContinue)
}

function Resolve-MpvCommandPath {
  $mpvCommand = Get-MpvCommand
  if (-not $mpvCommand) {
    Write-Host '[mpv-discovery] Get-Command did not find mpv.exe/mpv'
    return $null
  }

  $mpvSource = $mpvCommand.Source
  if ([string]::IsNullOrWhiteSpace($mpvSource) -and $mpvCommand.PSObject.Properties['Path']) {
    $mpvSource = $mpvCommand.Path
  }

  if ([string]::IsNullOrWhiteSpace($mpvSource) -or -not (Test-Path -Path $mpvSource)) {
    Write-Host "[mpv-discovery] Get-Command returned non-existent path: $mpvSource"
    return $null
  }

  Write-Host "[mpv-discovery] Get-Command candidate: $mpvSource"

  return $mpvSource
}

function Find-MpvExecutableWithWhere {
  $commands = @('mpv.exe', 'mpvnet.exe')
  foreach ($commandName in $commands) {
    Write-Host "[mpv-discovery] where lookup for: $commandName"
    $cmdOutput = (& cmd.exe /c "where $commandName 2>nul")
    $matches = @($cmdOutput | ForEach-Object { ($_ | Out-String).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $matches -or $matches.Count -eq 0) {
      Write-Host "[mpv-discovery] where returned no results for: $commandName"
    }
    foreach ($candidate in $matches) {
      Write-Host "[mpv-discovery] where candidate: $candidate"
      if (Test-Path -Path $candidate) {
        Write-Host "[mpv-discovery] where accepted: $candidate"
        return $candidate
      }
    }
  }

  return $null
}

function Find-MpvExecutableFromCommonPaths {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'MPV Player\mpv.exe'),
    (Join-Path $env:ProgramFiles 'MPV Player\mpvnet.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'MPV Player\mpv.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'MPV Player\mpvnet.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\mpv.net\mpv.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\mpv.net\mpvnet.exe'),
    (Join-Path $env:ProgramFiles 'mpv\mpv.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'mpv\mpv.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\mpv\mpv.exe')
  )

  foreach ($candidate in $candidates) {
    Write-Host "[mpv-discovery] common-path candidate: $candidate"
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -Path $candidate)) {
      Write-Host "[mpv-discovery] common-path accepted: $candidate"
      return $candidate
    }
  }

  $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  Write-Host "[mpv-discovery] winget package scan root: $wingetRoot"
  if (Test-Path -Path $wingetRoot) {
    $wingetMatch = Get-ChildItem -Path $wingetRoot -Filter mpv.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wingetMatch) {
      Write-Host "[mpv-discovery] winget package accepted: $($wingetMatch.FullName)"
      return $wingetMatch.FullName
    }
    Write-Host '[mpv-discovery] winget package scan did not find mpv.exe'
  } else {
    Write-Host '[mpv-discovery] winget package root does not exist'
  }

  return $null
}

function Find-MpvExecutableFromRegistry {
  $registryPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  foreach ($registryPath in $registryPaths) {
    Write-Host "[mpv-discovery] registry scan path: $registryPath"
    $items = Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      $displayName = [string]$item.DisplayName
      if ([string]::IsNullOrWhiteSpace($displayName) -or $displayName -notmatch 'mpv') {
        continue
      }

      foreach ($propertyName in @('InstallLocation', 'InstallSource')) {
        $root = [string]$item.$propertyName
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -Path $root)) {
          continue
        }

        Write-Host "[mpv-discovery] registry candidate root ($propertyName): $root"

        $direct = Join-Path $root 'mpv.exe'
        Write-Host "[mpv-discovery] registry direct candidate: $direct"
        if (Test-Path -Path $direct) {
          Write-Host "[mpv-discovery] registry accepted direct candidate: $direct"
          return $direct
        }

        $directMpvNet = Join-Path $root 'mpvnet.exe'
        Write-Host "[mpv-discovery] registry direct candidate: $directMpvNet"
        if (Test-Path -Path $directMpvNet) {
          Write-Host "[mpv-discovery] registry accepted direct candidate: $directMpvNet"
          return $directMpvNet
        }

        foreach ($target in @('mpv.exe', 'mpvnet.exe')) {
          $deep = Get-ChildItem -Path $root -Filter $target -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($deep) {
            Write-Host "[mpv-discovery] registry accepted recursive candidate: $($deep.FullName)"
            return $deep.FullName
          }
        }
      }
    }
  }

  return $null
}

function Get-RunnableMpvExecutable {
  $candidates = @(
    (Resolve-MpvCommandPath),
    (Find-MpvExecutableWithWhere),
    (Find-MpvExecutableFromCommonPaths),
    (Find-MpvExecutableFromRegistry)
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  $uniqueCandidates = @($candidates | Select-Object -Unique)
  if (-not $uniqueCandidates -or $uniqueCandidates.Count -eq 0) {
    Write-Host '[mpv-discovery] No discovery candidates produced.'
  }

  foreach ($candidate in $uniqueCandidates) {
    Write-Host "[mpv-discovery] probing candidate: $candidate"
    if (-not (Test-Path -Path $candidate)) {
      Write-Host "[mpv-discovery] candidate path does not exist: $candidate"
      continue
    }

    try {
      & $candidate --version *> $null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "[mpv-discovery] candidate runnable: $candidate"
        return $candidate
      }
      Write-Host "[mpv-discovery] candidate failed --version with exit code ${LASTEXITCODE}: $candidate"

      & $candidate --help *> $null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "[mpv-discovery] candidate runnable via --help: $candidate"
        return $candidate
      }
      Write-Host "[mpv-discovery] candidate failed --help with exit code ${LASTEXITCODE}: $candidate"

      if ($candidate -match '(?i)mpv(?:net)?\.exe$') {
        Write-Host "[mpv-discovery] accepting candidate despite probe failures (known mpv build behavior): $candidate"
        return $candidate
      }
    }
    catch {
      Write-Host "Discovered mpv candidate is not runnable: $candidate"
    }
  }

  return $null
}

function Ensure-MpvInstalled {
  Write-Host '[mpv-discovery] Starting mpv discovery/install sequence'
  $mpvSource = Get-RunnableMpvExecutable
  if (-not $mpvSource) {
    Write-Host 'mpv not found. Installing with winget...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget is not available; cannot auto-install mpv.'
    }

    $packageIds = @(
      'shinchiro.mpv',
      'MPV.MPV',
      'mpv.net'
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
      Write-Host 'mpv install by package ID failed. Trying name-based install...'
      winget install --name mpv -e --source winget --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) {
        $installed = $true
      }
      else {
        Write-Host 'winget name-based install did not apply an install/update. Continuing with binary discovery...'
      }
    }

    Refresh-ProcessPath
    $mpvSource = Get-RunnableMpvExecutable
  }

  if (-not $mpvSource) {
    Write-Host 'Warning: mpv was not found after installation attempts. Checked PATH, where.exe, common install folders, WinGet packages, and registry-derived paths.'
    Write-Host 'Continuing setup without mpv. Client will use ffplay/gstreamer unless MPV_PATH is configured later.'
    return
  }

  & $mpvSource --version *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: mpv command was found but failed to execute at $mpvSource"
    Write-Host 'Continuing setup without mpv. Client will use ffplay/gstreamer unless MPV_PATH is configured later.'
    return
  }

  $env:MPV_PATH = $mpvSource
  try {
    [System.Environment]::SetEnvironmentVariable('MPV_PATH', $mpvSource, 'User')
  }
  catch {
    Write-Host 'Warning: unable to persist MPV_PATH to user environment; continuing with current process value.'
  }

  Write-Host "Using mpv executable: $mpvSource"
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
Ensure-MpvInstalled

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
