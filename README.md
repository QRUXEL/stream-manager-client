# Stream Manager Client

Use this one-liner on a fresh Windows install:

```powershell
$env:STREAM_MANAGER_REPO_URL="https://github.com/QRUXEL/stream-manager-client.git"; $tmp=Join-Path $env:TEMP "install-client.ps1"; irm https://raw.githubusercontent.com/QRUXEL/stream-manager-client/main/install-client.ps1 -OutFile $tmp; powershell -NoProfile -ExecutionPolicy Bypass -File $tmp
```

If you want to pass the repo URL directly instead of using an environment variable:

```powershell
$tmp=Join-Path $env:TEMP "install-client.ps1"; irm https://raw.githubusercontent.com/QRUXEL/stream-manager-client/main/install-client.ps1 -OutFile $tmp; powershell -NoProfile -ExecutionPolicy Bypass -File $tmp -RepoUrl "https://github.com/QRUXEL/stream-manager-client.git"
```

What this does:
- Installs Git (via winget) if needed.
- Clones or updates the client repository.
- Runs `setup-client.ps1` to install dependencies and start the client.
