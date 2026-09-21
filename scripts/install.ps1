<#
.SYNOPSIS
    Paracord server installer for Windows - one command, install and upgrade.

.DESCRIPTION
    One line in a normal PowerShell window:

        irm https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.ps1 | iex

    Running it that way needs no execution-policy flag (the script is never
    saved and run as a file), and the script asks Windows for administrator
    permission itself: installing for the whole computer gets auto-start and a
    firewall rule so friends can connect. Decline the permission box and it
    installs just for you instead.

    It downloads the Windows server release, installs it, generates the config
    via `paracord-server init`, starts the server, turns the one-time owner
    setup token into a ready-to-open link and opens that link in the browser.

    Re-running upgrades the binary in place: config\ and data\ are preserved and
    the previous paracord-server.exe is kept under backups\.

    It also still works as a file:

        powershell -ExecutionPolicy Bypass -File install.ps1

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
    Skip auto-start registration (and, for a per-user install, skip starting the
    server). Env fallback: PARACORD_NO_SERVICE=1.

.PARAMETER NoBrowser
    Never open a browser; just print the setup link.
    Env fallback: PARACORD_NO_BROWSER=1.

.PARAMETER NoElevate
    Never ask for administrator permission; install just for this user.
    Env fallback: PARACORD_NO_ELEVATE=1.

.PARAMETER Relaunched
    Internal. Set on the copy this script starts for itself after the Windows
    permission box is accepted, so it can say the window is safe to close.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$InstallDir,
    [string]$ReleaseBaseUrl,
    [string]$LocalArchive,
    [string]$GitHubRepo,
    [switch]$NoService,
    [switch]$NoBrowser,
    [switch]$NoElevate,
    [switch]$Relaunched
)

# Deliberately not a #Requires statement: this script is meant to be piped into
# `iex`, and #Requires is only honoured for real script files. A plain check
# works in both shapes.
if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "paracord-install: error: this needs Windows PowerShell 5.1 or newer (found $($PSVersionTable.PSVersion))."
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Env-var fallbacks (parity with scripts/install.sh) ----------------------
if (-not $Version)        { $Version        = $env:PARACORD_VERSION }
if (-not $InstallDir)     { $InstallDir     = $env:PARACORD_INSTALL_DIR }
if (-not $ReleaseBaseUrl) { $ReleaseBaseUrl = $env:PARACORD_RELEASE_BASE_URL }
if (-not $LocalArchive)   { $LocalArchive   = $env:PARACORD_LOCAL_ARCHIVE }
if (-not $GitHubRepo)     { $GitHubRepo     = $env:PARACORD_GITHUB_REPO }
if (-not $GitHubRepo)     { $GitHubRepo     = 'Scdouglas1999/Paracord' }
if (-not $ReleaseBaseUrl) { $ReleaseBaseUrl = "https://github.com/$GitHubRepo/releases/download" }
if ($env:PARACORD_NO_SERVICE -eq '1') { $NoService = [switch]$true }
if ($env:PARACORD_NO_BROWSER -eq '1') { $NoBrowser = [switch]$true }
if ($env:PARACORD_NO_ELEVATE -eq '1') { $NoElevate = [switch]$true }

$TaskName = 'Paracord Server'
$ApiUrl   = "https://api.github.com/repos/$GitHubRepo/releases/latest"
$DocsUrl  = "https://github.com/$GitHubRepo/blob/main/docs/port-forwarding.md"
$SelfUrl  = $env:PARACORD_SCRIPT_URL
if (-not $SelfUrl) { $SelfUrl = "https://raw.githubusercontent.com/$GitHubRepo/main/scripts/install.ps1" }

function Write-Step([string]$msg) { Write-Host "`n==> $msg" }
function Fail([string]$msg) { throw "paracord-install: error: $msg" }
# The closing Details block is deliberately quieter than the steps above it.
function Write-Dim([string]$msg) { Write-Host $msg -ForegroundColor DarkGray }

# Print a captured log file, if there is one to print.
function Show-TextFile([string]$path) {
    if (-not $path) { return }
    if (-not (Test-Path $path)) { return }
    foreach ($line in (Get-Content -Path $path)) { Write-Host $line }
}

# First non-empty line of a file, trimmed. Empty string when unreadable.
function Get-FirstLine([string]$path) {
    try {
        foreach ($line in (Get-Content -Path $path)) {
            $trimmed = $line.Trim()
            if ($trimmed) { return $trimmed }
        }
    } catch { }
    return ''
}

# First value of a key inside a TOML section, unquoted; '' when absent.
function Get-TomlValue([string]$path, [string]$section, [string]$key) {
    if (-not (Test-Path $path)) { return '' }
    $current = ''
    try {
        foreach ($line in (Get-Content -Path $path)) {
            $trimmed = $line.Trim()
            if ($trimmed -match '^\[([^\]]+)\]$') {
                $current = $Matches[1]
                continue
            }
            if ($current -ne $section) { continue }
            if ($trimmed.StartsWith('#')) { continue }
            if ($trimmed -match ('^' + [regex]::Escape($key) + '\s*=\s*(.+)$')) {
                $value = $Matches[1].Trim()
                $hash = $value.IndexOf('#')
                if ($hash -gt 0) { $value = $value.Substring(0, $hash).Trim() }
                return $value.Trim('"')
            }
        }
    } catch { }
    return ''
}

# -- Platform check -----------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
if ($arch -ne 'AMD64') {
    Fail "no prebuilt Paracord server for Windows/$arch - releases ship x64 only"
}

# GitHub requires TLS 1.2+ and a User-Agent. Set before any download, including
# the one the elevation step below makes.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'paracord-install' }

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

# -- Administrator permission -------------------------------------------------
#
# Piped through `iex` there is no script file to hand to a new PowerShell, so
# fetch one. A file run keeps its own path. Either way the elevated copy does
# the whole install in its own window, which stays open (-NoExit) so whoever
# ran this can read the setup link it prints.
# An explicit -InstallDir or -LocalArchive means someone scripted this run, so
# it finishes where it was told to instead of raising a permission box.
$canElevate = (-not $IsAdmin) -and (-not $NoElevate) -and (-not $InstallDir) -and (-not $LocalArchive) `
    -and [Environment]::UserInteractive
if ($canElevate) {
    Write-Host 'Installing Paracord for this whole computer - so it starts by itself and your friends can reach it - needs administrator permission.'
    Write-Host 'Choose Yes in the Windows box that appears; the install then continues in a new window.'
    $handedOver = $false
    try {
        $selfPath = Get-Variable -Name PSCommandPath -ValueOnly -ErrorAction SilentlyContinue
        if ($selfPath -and (Test-Path $selfPath)) {
            $scriptCopy = $selfPath
        } else {
            $scriptCopy = Join-Path ([System.IO.Path]::GetTempPath()) ("paracord-install-" + [guid]::NewGuid().ToString('N') + ".ps1")
            Invoke-WebRequest -Uri $SelfUrl -OutFile $scriptCopy -Headers $headers
        }
        # Administrator processes do not inherit this window's environment, so
        # every override is re-stated on the command line.
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"' + $scriptCopy + '"'), '-Relaunched')
        if ($Version)        { $psArgs += @('-Version',        ('"' + $Version + '"')) }
        if ($InstallDir)     { $psArgs += @('-InstallDir',     ('"' + $InstallDir + '"')) }
        if ($ReleaseBaseUrl) { $psArgs += @('-ReleaseBaseUrl', ('"' + $ReleaseBaseUrl + '"')) }
        if ($LocalArchive)   { $psArgs += @('-LocalArchive',   ('"' + $LocalArchive + '"')) }
        if ($GitHubRepo)     { $psArgs += @('-GitHubRepo',     ('"' + $GitHubRepo + '"')) }
        if ($NoService)      { $psArgs += '-NoService' }
        if ($NoBrowser)      { $psArgs += '-NoBrowser' }
        Start-Process -FilePath 'powershell' -Verb RunAs -ArgumentList $psArgs | Out-Null
        $handedOver = $true
    } catch {
        Write-Host ''
        Write-Host 'No administrator permission, so Paracord is being installed just for you.'
        Write-Host 'It will start when you log in, and you can re-run this later to install it for the whole computer.'
    }
    if ($handedOver) {
        Write-Host ''
        Write-Host 'The install is finishing in the administrator window - the link to finish setting up appears there.'
        return
    }
}

# -- Paths --------------------------------------------------------------------
if (-not $InstallDir) {
    if ($IsAdmin) { $InstallDir = Join-Path $env:ProgramFiles 'Paracord' }
    else          { $InstallDir = Join-Path $env:LOCALAPPDATA 'Paracord' }
}
$InstallDir  = [System.IO.Path]::GetFullPath($InstallDir)
$ConfigPath  = Join-Path $InstallDir 'config\paracord.toml'
$ConfigDir   = Split-Path $ConfigPath
$DataDir     = Join-Path $InstallDir 'data'
$ExePath     = Join-Path $InstallDir 'paracord-server.exe'
$BackupsDir  = Join-Path $InstallDir 'backups'
# Forward-slash form for the config file: sqlite:// URLs and std::path both
# accept it on Windows, and it avoids TOML escaping problems.
$InstallDirFwd = $InstallDir -replace '\\', '/'

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("paracord-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

# State the ending text reads.
$versionLabel  = ''
$serverStarted = $false
$serviceDesc   = 'nothing starts it automatically yet'
$firewallNote  = ''
$claimLink     = ''
$claimSource   = ''
$browserOpened = $false

try {
    Write-Host "Paracord server installer"
    if ($IsAdmin) {
        Write-Host "Installing for everyone on this computer. The server will start with the computer."
    } else {
        Write-Host "Installing just for you (no administrator password needed)."
        Write-Host "The server will start when you log in."
    }

    # -- Resolve release ------------------------------------------------------
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
                Fail "could not query $ApiUrl - check connectivity, or pass -Version / -LocalArchive"
            }
            if (-not $tag) { Fail "release lookup returned no tag_name - pass -Version explicitly" }
        }
        $versionNum = $tag.TrimStart('v')
        $versionLabel = $versionNum
        $asset = "paracord-server-windows-x64-$versionNum.zip"
        $downloadUrl = "$ReleaseBaseUrl/$tag/$asset"
        Write-Host "Release: $tag  asset: $asset"
    }

    # -- Download ------------------------------------------------------------
    if ($LocalArchive) {
        $archive = (Resolve-Path $LocalArchive).Path
        $asset = Split-Path $archive -Leaf
        # Offline installs have no release tag; the archive name usually carries
        # the version.
        if ($asset -match '^paracord-server-windows-x64-(.+)\.zip$') { $versionLabel = $Matches[1] }
    } else {
        $archive = Join-Path $TmpDir $asset
        Write-Step "Downloading $downloadUrl"
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $archive -Headers $headers
        } catch {
            Fail "download failed: $($_.Exception.Message)`nURL: $downloadUrl"
        }
    }

    # -- Checksum verification (when the release publishes them) -------------
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
            Fail "SHA-256 mismatch for $(Split-Path $archive -Leaf):`n  expected: $expected`n  actual:   $actual`nThe archive is not installed - the download may be corrupted or tampered with."
        }
        Write-Host "SHA-256 verified: $actual"
    } elseif ($csumFound) {
        Write-Warning "paracord-install: a checksum file was published but has no entry for $asset; cannot verify - installing anyway"
    } else {
        Write-Warning "paracord-install: this release does not publish SHA-256 checksums - the archive cannot be integrity-verified. Downloaded from the official $GitHubRepo releases over TLS."
    }

    # -- Extract -------------------------------------------------------------
    Write-Step "Unpacking"
    $extract = Join-Path $TmpDir 'x'
    Expand-Archive -Path $archive -DestinationPath $extract -Force
    # Zip layout: files at the archive root, or under a paracord-server\ dir.
    $serverExe = Get-ChildItem -Path $extract -Recurse -Filter 'paracord-server.exe' | Select-Object -First 1
    if (-not $serverExe) { Fail "archive contains no paracord-server.exe - unexpected layout" }
    $payloadDir = $serverExe.Directory.FullName

    # -- Install -------------------------------------------------------------
    Write-Step "Installing to $InstallDir"
    $isUpgrade = Test-Path $ExePath
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
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
        # Not a problem: voice and video run on Paracord's own media engine.
        Write-Host "Note: this build ships no optional LiveKit companion - voice and video do not need it."
    }

    # -- Config generation ---------------------------------------------------
    if (Test-Path $ConfigPath) {
        Write-Host "Existing config preserved at $ConfigPath"
    } else {
        Write-Step "Generating configuration"
        # `init` prints its own operator walkthrough. Hold it back: this
        # installer prints one short set of instructions at the end, and two
        # competing sets of next steps is how a simple install starts to look
        # complicated. It is shown in full if `init` fails.
        $initLog = Join-Path $TmpDir 'init.log'
        $initErr = Join-Path $TmpDir 'init.err.log'
        $initProc = Start-Process -FilePath $ExePath `
            -ArgumentList @('-c', ('"' + $ConfigPath + '"'), 'init') `
            -WorkingDirectory $InstallDir -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $initLog -RedirectStandardError $initErr
        $initCode = 1
        if ($initProc) { $initCode = $initProc.ExitCode }
        if ($initCode -ne 0) {
            Show-TextFile $initLog
            Show-TextFile $initErr
            Fail "paracord-server init exited with code $initCode"
        }
        if (-not (Test-Path $ConfigPath)) {
            Show-TextFile $initLog
            Show-TextFile $initErr
            Fail "paracord-server init did not create $ConfigPath"
        }

        # Pin the generated ./data/... paths to the install directory so the
        # server finds its database/certs/uploads regardless of the process
        # working directory (a scheduled task starts in System32). `$` is
        # escaped because it is special inside a -replace replacement string.
        $toml = Get-Content $ConfigPath -Raw
        $toml = $toml -replace '\./data/', (($InstallDirFwd -replace '\$', '$$') + '/data/')
        # UTF8 without BOM - Set-Content -Encoding UTF8 prepends a BOM under
        # Windows PowerShell 5.1, which the TOML parser may reject.
        [System.IO.File]::WriteAllText($ConfigPath, $toml, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "Settings written to $ConfigPath"
    }

    # -- Addresses, read from the config the server actually uses ------------
    $tlsOn     = Get-TomlValue $ConfigPath 'tls' 'enabled'
    $tlsPort   = Get-TomlValue $ConfigPath 'tls' 'port'
    $bindAddr  = Get-TomlValue $ConfigPath 'server' 'bind_address'
    $voiceCfg  = Get-TomlValue $ConfigPath 'voice' 'port'
    $publicUrl = Get-TomlValue $ConfigPath 'server' 'public_url'
    $bindPort = '8090'
    if ($bindAddr -match ':(\d+)$') { $bindPort = $Matches[1] }
    if (-not ($tlsPort -match '^\d+$')) { $tlsPort = '8443' }
    $webScheme = 'https'
    $webPort   = $tlsPort
    if ($tlsOn -eq 'false') {
        $webScheme = 'http'
        $webPort   = $bindPort
    }
    $voicePort = $webPort
    if ($voiceCfg -match '^\d+$') { $voicePort = $voiceCfg }
    # '{0}://' rather than "$webScheme://": a colon after a variable name is a
    # scope qualifier to the parser.
    $localUrl = '{0}://localhost:{1}' -f $webScheme, $webPort
    $shareUrl = $localUrl
    if ($publicUrl) { $shareUrl = $publicUrl.TrimEnd('/') }

    # -- Firewall (elevated only) --------------------------------------------
    if ($IsAdmin) {
        Write-Step "Letting friends reach this computer on port $webPort"
        $made = 0
        $wanted = @(
            @{ Name = "Paracord Server app (TCP $webPort)";               Proto = 'TCP'; Port = $webPort },
            @{ Name = "Paracord Server voice and video (UDP $voicePort)"; Proto = 'UDP'; Port = $voicePort }
        )
        try {
            foreach ($rule in $wanted) {
                $ruleName  = $rule['Name']
                $ruleProto = $rule['Proto']
                $rulePort  = $rule['Port']
                # A display name is not unique: without this, every upgrade adds
                # another copy of the same rule.
                $have = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
                if (-not $have) {
                    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
                        -Protocol $ruleProto -LocalPort $rulePort -Action Allow -ErrorAction Stop | Out-Null
                }
            }
            $made = 1
        } catch {
            # Older systems without the NetSecurity module. A missing netsh must
            # not fail an install that is otherwise finished.
            try {
                & netsh advfirewall firewall add rule "name=Paracord Server TCP $webPort" dir=in action=allow protocol=TCP localport=$webPort | Out-Null
                if ($LASTEXITCODE -eq 0) { $made = 1 }
                & netsh advfirewall firewall add rule "name=Paracord Server UDP $voicePort" dir=in action=allow protocol=UDP localport=$voicePort | Out-Null
                if ($LASTEXITCODE -eq 0) { $made = 1 }
            } catch {
                $made = 0
            }
        }
        if ($made) {
            $firewallNote = "opened for port $webPort (TCP) and $voicePort (UDP)"
        } else {
            $firewallNote = 'could not be opened; friends outside this computer cannot connect yet'
            Write-Warning "paracord-install: could not create firewall rules - add them manually:"
            Write-Warning ('  netsh advfirewall firewall add rule name="Paracord TCP" dir=in action=allow protocol=TCP localport=' + $webPort)
            Write-Warning ('  netsh advfirewall firewall add rule name="Paracord UDP" dir=in action=allow protocol=UDP localport=' + $voicePort)
        }
    } else {
        $firewallNote = 'not opened (that needs administrator permission), so only this computer can reach the server'
    }

    # -- Auto-start ----------------------------------------------------------
    if ($IsAdmin -and -not $NoService) {
        Write-Step "Setting Paracord to start with the computer"
        if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
            Fail "the ScheduledTasks module is not available on this system - re-run with -NoService and start the server manually"
        }

        # paracord-server is a plain console executable - it never calls
        # StartServiceCtrlDispatcher, so SCM registration (sc.exe create) can
        # only fail: every start dies with error 1053 "did not respond in a
        # timely fashion". A scheduled task with an AtStartup trigger is the
        # supported auto-start mechanism for plain executables, and its
        # restart settings cover crashes.
        $legacy = Get-Service -Name 'Paracord' -ErrorAction SilentlyContinue
        if ($legacy) {
            Write-Warning "paracord-install: a legacy 'Paracord' Windows service registration exists from an older installer - it can never start (the server is not service-aware). Remove it with: sc.exe delete Paracord"
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
        $serviceDesc = "scheduled task '$TaskName' (starts with the computer, restarts on crash)"

        # The task runs as SYSTEM, and `init` may ACL the generated config to
        # the installing user only - grant SYSTEM modify on config\ and data\
        # so the server can read its config and write its database/uploads.
        # Everything else under the install dir already inherits SYSTEM access
        # from Program Files, so no grant is needed there.
        & icacls $ConfigDir /grant 'NT AUTHORITY\SYSTEM:(OI)(CI)(M)' /T | Out-Null
        & icacls $DataDir /grant 'NT AUTHORITY\SYSTEM:(OI)(CI)(M)' /T | Out-Null

        # `init` writes the config owner-only (it holds the JWT secret), which
        # also *disables inheritance* on that file. A directory grant carrying
        # (OI)(CI) is an inheritance instruction and does not reach a file that
        # has stopped inheriting, so the file above can still end up readable by
        # the installing user alone. The task runs as SYSTEM, so that is the
        # difference between a server that starts and one that exits 1 with
        # nothing in any log. Grant the file directly, with no inheritance
        # flags, and verify it rather than trusting the exit code.
        & icacls $ConfigPath /grant 'NT AUTHORITY\SYSTEM:(M)' | Out-Null
        # `-match` against an array filters it rather than answering true/false,
        # so the lines that do not mention SYSTEM would make this fire on a
        # grant that worked. Join first, then ask.
        $configAcl = (& icacls $ConfigPath 2>&1) -join "`n"
        if ($configAcl -notmatch 'NT AUTHORITY\\SYSTEM') {
            Fail ("could not grant SYSTEM access to $ConfigPath - the scheduled task runs as SYSTEM and cannot start without it. Current ACL:`n" + $configAcl)
        }

        Start-ScheduledTask -TaskName $TaskName
        $deadline = (Get-Date).AddSeconds(15)
        $running = $false
        while ((Get-Date) -lt $deadline) {
            $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($t -and $t.State -eq 'Running') { $running = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if ($running) {
            $serverStarted = $true
            Write-Host "Paracord is running and will start again with the computer."
        } else {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
            $detail = 'unknown'
            if ($info) { $detail = '0x{0:X8}' -f $info.LastTaskResult }
            Write-Warning "paracord-install: task did not reach Running (last result $detail) - inspect with 'Get-ScheduledTaskInfo `"$TaskName`"' or Task Scheduler"
        }
    } elseif (-not $IsAdmin -and -not $NoService) {
        # User-level install: Start Menu shortcut + logon autostart shortcut.
        Write-Step "Adding Paracord to the Start Menu and starting it"
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
        $serviceDesc = 'Start Menu shortcut plus a Startup entry (starts when you log in)'
        Start-Process -FilePath $ExePath -ArgumentList "-c `"$ConfigPath`"" -WorkingDirectory $InstallDir
        $serverStarted = $true
    } else {
        Write-Host "Auto-start skipped (-NoService). Start the server with:"
        Write-Host "    cd `"$InstallDir`"; .\paracord-server.exe -c `"$ConfigPath`""
    }

    # -- The one link that finishes setup ------------------------------------
    #
    # The server mints the one-time owner token on its first real start, not
    # during `init`, and writes it beside the config. Wait for it - but only
    # when this run started the server and there is a first owner to create.
    $claimTokenFile = Join-Path $ConfigDir 'first-owner-claim.txt'
    $claimLinkFile  = Join-Path $ConfigDir 'first-owner-claim-link.txt'
    if (-not $isUpgrade) {
        $deadline = Get-Date
        if ($serverStarted) { $deadline = (Get-Date).AddSeconds(20) }
        $said = $false
        while ($true) {
            if ((Test-Path $claimLinkFile) -or (Test-Path $claimTokenFile)) { break }
            if ((Get-Date) -ge $deadline) { break }
            if (-not $said) {
                Write-Host 'Waiting for the server to finish starting...'
                $said = $true
            }
            Start-Sleep -Milliseconds 500
        }

        $claimToken = ''
        if (Test-Path $claimLinkFile) {
            $published = Get-FirstLine $claimLinkFile
            if ($published -match '#claim=(.+)$') {
                # Use the server's token, but against the loopback address: the
                # server builds its link from the address it shares with other
                # people, which can be a name only they can resolve.
                $claimToken = $Matches[1].Trim()
                $claimSource = 'link file'
            } elseif ($published) {
                $claimLink = $published
                $claimSource = 'link file (verbatim)'
            }
        }
        if ((-not $claimLink) -and (-not $claimToken) -and (Test-Path $claimTokenFile)) {
            $claimToken = Get-FirstLine $claimTokenFile
            if ($claimToken) { $claimSource = 'token file' }
        }
        if ((-not $claimLink) -and $claimToken) {
            $claimLink = '{0}/setup-server#claim={1}' -f $localUrl, $claimToken
        }
        if ($claimLink) { Write-Host "Setup link ready (source: $claimSource)." }
    }

    # Opening a browser is a convenience, never a requirement: every failure
    # path falls through to printing the link.
    if ($claimLink -and -not $NoBrowser) {
        try {
            Start-Process $claimLink
            $browserOpened = $true
        } catch {
            $browserOpened = $false
        }
    }

    # -- Ending --------------------------------------------------------------
    Write-Host ''
    if ($isUpgrade) {
        $tail = '.'
        if ($serverStarted) { $tail = ' and restarted.' }
        if ($versionLabel) {
            Write-Host ('Paracord was updated to ' + $versionLabel + $tail)
        } else {
            Write-Host ('Paracord was updated' + $tail)
        }
        Write-Host 'Your accounts, messages and settings are kept.'
        if (-not $serverStarted) {
            Write-Host ("Start it again with:  cd `"$InstallDir`"; .\paracord-server.exe -c `"$ConfigPath`"")
        }
    } else {
        if ($serverStarted) {
            Write-Host 'Paracord is installed and running.'
        } else {
            Write-Host 'Paracord is installed.'
        }
        Write-Host ''
        if ($claimLink) {
            if ($browserOpened) {
                Write-Host '1. Finish setting up (opens in your browser):'
            } else {
                Write-Host '1. Finish setting up - open this link in your browser:'
            }
            Write-Host "     $claimLink"
            Write-Host '   Your browser may show a one-time security warning because the server made its own'
            Write-Host '   certificate - choose Advanced, then Continue. (The desktop app never shows this.)'
        } elseif ($serverStarted) {
            Write-Host '1. Finish setting up - open this link in your browser:'
            Write-Host "     $localUrl/setup-server"
            Write-Host '   It asks for the one-time setup code your server printed when it started.'
            if (Test-Path $claimTokenFile) {
                Write-Host '   The code is also saved here:'
                Write-Host "     $claimTokenFile"
            }
        } else {
            Write-Host '1. Start the server:'
            Write-Host ("     cd `"$InstallDir`"; .\paracord-server.exe -c `"$ConfigPath`"")
            Write-Host '   It prints a link that finishes setting up - open that link in your browser.'
        }
        Write-Host '2. Then invite friends: open your server in the app and press Invite.'
        Write-Host ''
        Write-Host 'Friends outside your home network: the server tries to open the door on your'
        Write-Host "router by itself. If someone can't connect, see $DocsUrl"
        Write-Host ''
        Write-Host 'To update later, run this same command again. Your data is kept.'
    }

    Write-Dim ''
    Write-Dim 'Details'
    if ($versionLabel) { Write-Dim "  Version:   $versionLabel" }
    Write-Dim "  Installed: $InstallDir"
    Write-Dim "  Settings:  $ConfigPath"
    Write-Dim "  Your data: $DataDir"
    Write-Dim "  Starts by: $serviceDesc"
    if ($webPort -eq $voicePort) {
        Write-Dim "  Ports:     $webPort (TCP for the app, UDP for voice and video)"
    } else {
        Write-Dim "  Ports:     $webPort TCP (app), $voicePort UDP (voice and video)"
    }
    if ($firewallNote) { Write-Dim "  Firewall:  $firewallNote" }
    Write-Dim "  Address:   $shareUrl"
    if (-not $IsAdmin) {
        Write-Dim '  Installed for you only. Re-run this in an administrator window to install it'
        Write-Dim '  for the whole computer.'
    }
    Write-Host ''
    if ($Relaunched) {
        Write-Host 'You can close this window when you are done reading.'
    }
}
finally {
    Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
