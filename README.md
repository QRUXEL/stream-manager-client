# Stream Manager Client

Use this one-liner on a fresh Windows install:

```powershell
$tmp=Join-Path $env:TEMP "install-client.ps1"; irm https://raw.githubusercontent.com/QRUXEL/stream-manager-client/main/install-client.ps1 -OutFile $tmp; powershell -NoProfile -ExecutionPolicy Bypass -File $tmp
```

If you want to override the default repo URL:

```powershell
$tmp=Join-Path $env:TEMP "install-client.ps1"; irm https://raw.githubusercontent.com/QRUXEL/stream-manager-client/main/install-client.ps1 -OutFile $tmp; powershell -NoProfile -ExecutionPolicy Bypass -File $tmp -RepoUrl "https://github.com/QRUXEL/stream-manager-client.git"
```

What this does:
- Installs Git (via winget) if needed.
- Installs FFmpeg (via winget) if `ffplay` is missing.
- Clones or updates the client repository.
- Runs `setup-client.ps1` to install dependencies and start the client.
