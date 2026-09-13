<#
.SYNOPSIS
    Paracord server installer for Windows — one-command install and upgrade.

.DESCRIPTION
    Downloads the Windows server release, installs it, generates the config via
    `paracord-server init`, and (when run elevated) registers an auto-start
    scheduled task plus inbound firewall rules for TCP/UDP 8443.

    Re-running upgrades the binary in place: config\ and data\ are preserved and
    the previous paracord-server.exe is kept under backups\.

    Quick start (elevated PowerShell):
        powershell -ExecutionPolicy Bypass -File install.ps1

    or fetch straight from GitHub:
        irm https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.ps1 -OutFile install.ps1
        powershell -ExecutionPolicy Bypass -File .\install.ps1

.PARAMETER Version
    Release version to install ("2.0.0" or "v2.0.0"). Defaults to the latest
    release resolved via the GitHub API. Env fallback: PARACORD_VERSION.

.PARAMETER InstallDir
    Install destination. Default: %ProgramFiles%\Paracord when elevated,
    %LOCALAPPDATA%\Paracord otherwise. Env fallback: PARACORD_INSTALL_DIR.

.PARAMETER ReleaseBaseUrl
    URL base holding <tag>/<asset>. Env fallback: PARACORD_RELEASE_BASE_URL.

.PARAMETER LocalArchive
    Path to a local paracord-server-windows-x64-*.zip for offline installs.
    Env fallback: PARACORD_LOCAL_ARCHIVE.

.PARAMETER GitHubRepo
    owner/repo for release lookup. Env fallback: PARACORD_GITHUB_REPO
    (default Scdouglas1999/Paracord).

.PARAMETER NoService
    Skip scheduled-task registration even when elevated.
    Env fallback: PARACORD_NO_SERVICE=1.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version,
    [string]$InstallDir,
    [string]$ReleaseBaseUrl,
    [string]$LocalArchive,
    [string]$GitHubRepo,
    [switch]$NoService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Env-var fallbacks (parity with scripts/install.sh) ──────────────────────
if (-not $Version)        { $Version        = $env:PARACORD_VERSION }
if (-not $InstallDir)     { $InstallDir     = $env:PARACORD_INSTALL_DIR }
if (-not $ReleaseBaseUrl) { $ReleaseBaseUrl = $env:PARACORD_RELEASE_BASE_URL }
if (-not $LocalArchive)   { $LocalArchive   = $env:PARACORD_LOCAL_ARCHIVE }
if (-not $GitHubRepo)     { $GitHubRepo     = $env:PARACORD_GITHUB_REPO }
if (-not $GitHubRepo)     { $GitHubRepo     = 'Scdouglas1999/Paracord' }
if (-not $ReleaseBaseUrl) { $ReleaseBaseUrl = "https://github.com/$GitHubRepo/releases/download" }
if ($env:PARACORD_NO_SERVICE -eq '1') { $NoService = [switch]$true }

$TaskName = 'Paracord Server'
$ApiUrl   = "https://api.github.com/repos/$GitHubRepo/releases/latest"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" }
function Fail([string]$msg) { throw "paracord-install: error: $msg" }

# ── Platform check ───────────────────────────────────────────────────────────
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
if ($arch -ne 'AMD64') {
    Fail "no prebuilt Paracord server for Windows/$arch — releases ship x64 only"
}

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

# ── Paths ────────────────────────────────────────────────────────────────────
if (-not $InstallDir) {
    if ($IsAdmin) { $InstallDir = Join-Path $env:ProgramFiles 'Paracord' }
    else          { $InstallDir = Join-Path $env:LOCALAPPDATA 'Paracord' }
}
$InstallDir  = [System.IO.Path]::GetFullPath($InstallDir)
$ConfigPath  = Join-Path $InstallDir 'config\paracord.toml'
$DataDir     = Join-Path $InstallDir 'data'
$ExePath     = Join-Path $InstallDir 'paracord-server.exe'
$BackupsDir  = Join-Path $InstallDir 'backups'
# Forward-slash form for the config file: sqlite:// URLs and std::path both
# accept it on Windows, and it avoids TOML escaping problems.
$InstallDirFwd = $InstallDir -replace '\\', '/'

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("paracord-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    Write-Host "Paracord server installer"
    if ($IsAdmin) { Write-Host "  (elevated — auto-start task available)" }
    else          { Write-Host "  (not elevated — user install; no auto-start task)" }

    # GitHub requires TLS 1.2+ and a User-Agent.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'paracord-install' }

    # ── Resolve release ──────────────────────────────────────────────────────
    $tag = $null
    if ($LocalArchive) {
        if (-not (Test-Path $LocalArchive)) { Fail "LocalArchive '$LocalArchive' does not exist" }
        Write-Step "Using local archive: $LocalArchive"
    } else {
        if ($Version) {
            $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
        } else {
            Write-Step "Resolving latest Paracord release"
            try {
                $tag = (Invoke-RestMethod -Uri $ApiUrl -Headers $headers).tag_name
            } catch {
                Fail "could not query $ApiUrl — check connectivity, or pass -Version / -LocalArchive"
            }
            if (-not $tag) { Fail "release lookup returned no tag_name — pass -Version explicitly" }
        }
        $versionNum = $tag.TrimStart('v')
        $asset = "paracord-server-windows-x64-$versionNum.zip"
        $downloadUrl = "$ReleaseBaseUrl/$tag/$asset"
        Write-Host "Release: $tag  asset: $asset"
    }

    # ── Download ─────────────────────────────────────────────────────────────
    if ($LocalArchive) {
        $archive = (Resolve-Path $LocalArchive).Path
        $asset = Split-Path $archive -Leaf
    } else {
        $archive = Join-Path $TmpDir $asset
        Write-Step "Downloading $downloadUrl"
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $archive -Headers $headers
        } catch {
            Fail "download failed: $($_.Exception.Message)`nURL: $downloadUrl"
        }
    }

    # ── Checksum verification (when the release publishes them) ──────────────
    $expected = $null
    $csumFound = $false
    if ($LocalArchive -and (Test-Path "$archive.sha256")) {
        $expected = (Get-Content "$archive.sha256" -Raw).Trim().Split(' ')[0]
        $csumFound = $true
    } elseif (-not $LocalArchive) {
        foreach ($name in @("$asset.sha256", 'SHA256SUMS', 'SHA256SUMS.txt', 'checksums.txt')) {
            $cfile = Join-Path $TmpDir $name
            try {
                Invoke-WebRequest -Uri "$ReleaseBaseUrl/$tag/$name" -OutFile $cfile -Headers $headers
                $content = Get-Content $cfile -Raw
                if ($name -eq "$asset.sha256") {
                    $expected = $content.Trim().Split(' ')[0]
                } else {
                    $line = ($content -split "`n") | Where-Object { $_ -match "[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($asset))`r?$" } | Select-Object -First 1
                    if ($line) { $expected = $line.Trim().Split(' ')[0].Trim() }
                }
                $csumFound = $true
                break
            } catch { }
        }
    }
    if ($expected) {
        $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected.ToLowerInvariant()) {
            Fail "SHA-256 mismatch for $(Split-Path $archive -Leaf):`n  expected: $expected`n  actual:   $actual`nThe archive is not installed — the download may be corrupted or tampered with."
        }
        Write-Host "SHA-256 verified: $actual"
    } elseif ($csumFound) {
        Write-Warning "paracord-install: a checksum file was published but has no entry for $asset; cannot verify — installing anyway"
    } else {
        Write-Warning "paracord-install: this release does not publish SHA-256 checksums — the archive cannot be integrity-verified. Downloaded from the official $GitHubRepo releases over TLS."
    }

    # ── Extract ──────────────────────────────────────────────────────────────
    Write-Step "Unpacking"
    $extract = Join-Path $TmpDir 'x'
    Expand-Archive -Path $archive -DestinationPath $extract -Force
    # Zip layout: files at the archive root, or under a paracord-server\ dir.
    $serverExe = Get-ChildItem -Path $extract -Recurse -Filter 'paracord-server.exe' | Select-Object -First 1
    if (-not $serverExe) { Fail "archive contains no paracord-server.exe — unexpected layout" }
    $payloadDir = $serverExe.Directory.FullName

    # ── Install ──────────────────────────────────────────────────────────────
    Write-Step "Installing to $InstallDir"
    $isUpgrade = Test-Path $ExePath
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path $ConfigPath) -Force | Out-Null
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null

    $stage = Join-Path $InstallDir (".install-stage-" + $PID)
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Get-ChildItem -Path $payloadDir -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $stage $_.Name) -Force
    }

    if ($isUpgrade) {
        if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
            $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($existingTask -and $existingTask.State -eq 'Running') {
                Write-Host "Stopping scheduled task '$TaskName' for the upgrade"
                Stop-ScheduledTask -TaskName $TaskName
                Start-Sleep -Seconds 2
            }
        }
        $backup = Join-Path $BackupsDir ("paracord-server-{0}.exe" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Move-Item $ExePath $backup -Force
        Write-Host "Previous binary backed up to $backup"
    }

    Get-ChildItem -Path $stage -File | ForEach-Object {
        Move-Item $_.FullName (Join-Path $InstallDir $_.Name) -Force
    }
    Remove-Item $stage -Recurse -Force
    if (-not (Test-Path $ExePath)) { Fail "install did not produce $ExePath" }
    if (-not (Test-Path (Join-Path $InstallDir 'livekit-server.exe'))) {
        Write-Warning "paracord-install: archive ships no livekit-server.exe — fine for the default native QUIC media; needed only if you later opt into LiveKit"
    }

    # ── Config generation ────────────────────────────────────────────────────
    if (Test-Path $ConfigPath) {
        Write-Host "Existing config preserved at $ConfigPath"
    } else {
        Write-Step "Generating configuration"
        Push-Location $InstallDir
        try {
            & $ExePath -c $ConfigPath init
            if ($LASTEXITCODE -ne 0) { Fail "paracord-server init exited with code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        if (-not (Test-Path $ConfigPath)) { Fail "paracord-server init did not create $ConfigPath" }

        # Pin the generated ./data/... paths to the install directory so the
        # server finds its database/certs/uploads regardless of the process
        # working directory (a scheduled task starts in System32). `$` is
        # escaped because it is special inside a -replace replacement string.
        $toml = Get-Content $ConfigPath -Raw
        $toml = $toml -replace '\./data/', (($InstallDirFwd -replace '\$', '$$') + '/data/')
        # UTF8 without BOM — Set-Content -Encoding UTF8 prepends a BOM under
        # Windows PowerShell 5.1, which the TOML parser may reject.
        [System.IO.File]::WriteAllText($ConfigPath, $toml, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "Pinned data paths in $ConfigPath to $DataDir"
    }

    # ── Firewall (elevated only) ─────────────────────────────────────────────
    if ($IsAdmin) {
        Write-Step "Firewall rules for TCP/UDP 8443"
        $made = 0
        try {
            New-NetFirewallRule -DisplayName 'Paracord Server HTTPS (TCP 8443)' `
                -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -ErrorAction Stop | Out-Null
            New-NetFirewallRule -DisplayName 'Paracord Server QUIC media (UDP 8443)' `
                -Direction Inbound -Protocol UDP -LocalPort 8443 -Action Allow -ErrorAction Stop | Out-Null
            $made = 1
        } catch {
            foreach ($proto in 'TCP', 'UDP') {
                & netsh advfirewall firewall add rule "name=Paracord Server $proto 8443" dir=in action=allow protocol=$proto localport=8443 | Out-Null
                if ($LASTEXITCODE -eq 0) { $made = 1 }
            }
        }
        if ($made) {
            Write-Host "Inbound allow rules created for port 8443 (TCP + UDP)."
        } else {
            Write-Warning "paracord-install: could not create firewall rules — add them manually:"
            Write-Warning '  netsh advfirewall firewall add rule name="Paracord TCP 8443" dir=in action=allow protocol=TCP localport=8443'
            Write-Warning '  netsh advfirewall firewall add rule name="Paracord UDP 8443" dir=in action=allow protocol=UDP localport=8443'
        }
        Write-Host "Plain-HTTP port 8090 is left closed — the HTTPS URL on 8443 is the one to share."
    } else {
        Write-Host "Firewall: not elevated, so no rules were created. To allow remote access run once as Administrator:"
        Write-Host '  netsh advfirewall firewall add rule name="Paracord TCP 8443" dir=in action=allow protocol=TCP localport=8443'
        Write-Host '  netsh advfirewall firewall add rule name="Paracord UDP 8443" dir=in action=allow protocol=UDP localport=8443'
    }

    # ── Scheduled task / shortcuts ───────────────────────────────────────────
    if ($IsAdmin -and -not $NoService) {
        Write-Step "Scheduled task (auto-start)"
        if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
            Fail "the ScheduledTasks module is not available on this system — re-run with -NoService and start the server manually"
        }

        # paracord-server is a plain console executable — it never calls
        # StartServiceCtrlDispatcher, so SCM registration (sc.exe create) can
        # only fail: every start dies with error 1053 "did not respond in a
        # timely fashion". A scheduled task with an AtStartup trigger is the
        # supported auto-start mechanism for plain executables, and its
        # restart settings cover crashes.
        $legacy = Get-Service -Name 'Paracord' -ErrorAction SilentlyContinue
        if ($legacy) {
            Write-Warning "paracord-install: a legacy 'Paracord' Windows service registration exists from an older installer — it can never start (the server is not service-aware). Remove it with: sc.exe delete Paracord"
        }

        $action = New-ScheduledTaskAction -Execute $ExePath `
            -Argument ('-c "{0}"' -f $ConfigPath) `
            -WorkingDirectory $InstallDir
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
            -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings -Force `
            -Description 'Paracord self-hosted chat server' | Out-Null
        Write-Host "Registered scheduled task '$TaskName' (SYSTEM, starts at boot, restarts on crash)"

        # The task runs as SYSTEM, and `init` may ACL the generated config to
        # the installing user only — grant SYSTEM modify on config\ and data\
        # so the server can read its config and write its database/uploads.
        # Everything else under the install dir already inherits SYSTEM access
        # from Program Files, so no grant is needed there.
        & icacls (Split-Path $ConfigPath) /grant 'NT AUTHORITY\SYSTEM:(OI)(CI)(M)' /T | Out-Null
        & icacls $DataDir /grant 'NT AUTHORITY\SYSTEM:(OI)(CI)(M)' /T | Out-Null

        Start-ScheduledTask -TaskName $TaskName
        $deadline = (Get-Date).AddSeconds(15)
        $running = $false
        while ((Get-Date) -lt $deadline) {
            $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($t -and $t.State -eq 'Running') { $running = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if ($running) {
            Write-Host "Scheduled task '$TaskName' is running (Get-ScheduledTask '$TaskName')"
        } else {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
            $detail = if ($info) { '0x{0:X8}' -f $info.LastTaskResult } else { 'unknown' }
            Write-Warning "paracord-install: task did not reach Running (last result $detail) — inspect with 'Get-ScheduledTaskInfo `"$TaskName`"' or Task Scheduler"
        }
    } elseif (-not $IsAdmin) {
        # User-level install: Start Menu shortcut + logon autostart shortcut.
        Write-Step "Start Menu shortcut"
        $wsh = New-Object -ComObject WScript.Shell
        $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $shortcutPath = Join-Path $startMenu 'Paracord Server.lnk'
        $sc = $wsh.CreateShortcut($shortcutPath)
        $sc.TargetPath = $ExePath
        $sc.Arguments = "-c `"$ConfigPath`""
        $sc.WorkingDirectory = $InstallDir
        $sc.Save()
        $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Paracord Server.lnk'
        Copy-Item $shortcutPath $startup -Force
        Write-Host "Created Start Menu shortcut and a Startup entry (server starts at logon)."

        Write-Host "Starting the server now in a new window…"
        Start-Process -FilePath $ExePath -ArgumentList "-c `"$ConfigPath`"" -WorkingDirectory $InstallDir
    } else {
        Write-Host "Scheduled-task setup skipped (-NoService). Run the server with:"
        Write-Host "    cd `"$InstallDir`"; .\paracord-server.exe -c `"$ConfigPath`""
    }

    # ── Summary ──────────────────────────────────────────────────────────────
    $shareUrl = 'https://localhost:8443'
    Write-Host @"

  +- Paracord installed -------------------------------------------------
  |
  |  Install dir:  $InstallDir
  |  Config:       $ConfigPath
  |  Data:         $DataDir
  |
  |  Open / share: $shareUrl   (self-signed cert - accept the
  |  one-time browser warning)
  |
  |  Next steps:
  |   1. Claim the server: a fresh instance has no owner and refuses
  |      registrations until claimed. Open $shareUrl/setup-server and paste
  |      the one-time claim token from
  |      $(Join-Path (Split-Path $ConfigPath) 'first-owner-claim.txt')
  |      (also printed in the server log). That creates your owner account,
  |      names the server and opens its first space. Do this before sharing.
  |   2. Invite others: share the URL, or create an invite link in-app.
  |   3. Remote access + voice/video: forward port 8443 (TCP + UDP) to this
  |      machine. TCP carries HTTPS, UDP carries native QUIC media.
  |
  |  Upgrade: re-run this installer any time — config and data are
  |  preserved and the old binary is backed up under $BackupsDir.
  |
  +----------------------------------------------------------------------
"@
    if ($IsAdmin -and -not $NoService) {
        Write-Host "  Task: Get-ScheduledTask '$TaskName' | Start-ScheduledTask -TaskName '$TaskName' | Stop-ScheduledTask -TaskName '$TaskName'"
    }
    if (-not $IsAdmin) {
        Write-Host "  Tip: re-run elevated for a system-wide install with an auto-start task:"
        Write-Host "       powershell -ExecutionPolicy Bypass -File install.ps1"
    }
    Write-Host ""
}
finally {
    Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
