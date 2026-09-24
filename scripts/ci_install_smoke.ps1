<#
.SYNOPSIS
    End-to-end smoke test for scripts/install.ps1 on a Windows runner.

.DESCRIPTION
    The Windows twin of scripts/ci_install_smoke.sh. It packages the server this
    job just built (target\release\paracord-server.exe) exactly the way the
    release does (paracord-server-windows-x64-<version>.zip), then runs the real
    installer against it, under both Windows PowerShell 5.1 (powershell.exe,
    what `irm ... | iex` runs in on a stock Windows) and PowerShell 7 (pwsh):

      1. A local archive whose .sha256 does not match is refused, and nothing
         is installed.
      2. The download path: the zip and a SHA256SUMS.txt served over HTTP. A
         tampered SHA256SUMS.txt is refused; the real one is verified. This run
         goes through the documented one-liner shape (the script text piped to
         Invoke-Expression, settings from PARACORD_* variables) and answers the
         router question yes (PARACORD_ALLOW_INTERNET=1).
      3. A fresh install for the whole computer, home network only
         (-HomeNetworkOnly), under Windows PowerShell 5.1: the scheduled task is
         registered and running as SYSTEM, the firewall rules exist, the server
         answers /health over HTTPS, the owner setup link is printed, and the
         config says auto_port_forward = false.
      4. Re-running it upgrades in place: the config is kept byte for byte, the
         previous binary is backed up, and the server answers again.
      5. -AllowInternet under PowerShell 7 with -NoService: the config says
         auto_port_forward = true and nothing is started.
      6. Cleanup: the installer has no uninstaller, so this removes the task,
         the process, the firewall rules and the install directories it made,
         and checks they are gone.

    Needs an elevated session (GitHub's Windows runners are), Python for the
    throwaway HTTP server, and curl.exe (both preinstalled on the runners).

    Usage (from the repository root, in pwsh):
        pwsh -NoProfile -File scripts/ci_install_smoke.ps1
#>
[CmdletBinding()]
param(
    [string]$ServerExe = 'target\release\paracord-server.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot
$Installer = Join-Path $RepoRoot 'scripts\install.ps1'

$script:Passed = 0
$script:Failures = New-Object System.Collections.Generic.List[string]
function Pass([string]$what) { $script:Passed++; Write-Host "  PASS  $what" }
function Fail([string]$what) { $script:Failures.Add($what); Write-Host "  FAIL  $what" -ForegroundColor Red }
function Note([string]$what) { Write-Host "  ....  $what" }
function Check([bool]$ok, [string]$what) { if ($ok) { Pass $what } else { Fail $what } }

function Assert-LogContains([string]$log, [string]$pattern, [string]$what) {
    $text = Get-Content -Raw -Path $log
    if ($text -match $pattern) { Pass $what } else { Fail "$what (log lacks /$pattern/)" }
}

# First value of `key` inside [section] of a TOML file ('' when absent).
function Get-TomlValue([string]$path, [string]$section, [string]$key) {
    $current = ''
    foreach ($line in (Get-Content -Path $path)) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[([^\]]+)\]$') { $current = $Matches[1]; continue }
        if ($current -ne $section -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -match ('^' + [regex]::Escape($key) + '\s*=\s*(.+)$')) {
            return $Matches[1].Trim().Trim('"')
        }
    }
    return ''
}

# Run the installer in a child shell and capture everything it prints.
# $Shell is 'powershell' (Windows PowerShell 5.1) or 'pwsh' (PowerShell 7).
function Invoke-Installer([string]$Shell, [string]$Log, [string[]]$Arguments) {
    $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Installer) + $Arguments
    & $Shell @argList *> $Log
    $code = $LASTEXITCODE
    Write-Host "  ....  $Shell install.ps1 $($Arguments -join ' ') -> exit $code"
    return $code
}

# The documented one-liner shape: the script text through Invoke-Expression,
# every setting from the environment.
function Invoke-InstallerAsOneLiner([string]$Shell, [string]$Log, [hashtable]$Environment) {
    $saved = @{}
    foreach ($name in $Environment.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $Environment[$name])
    }
    try {
        $command = "Get-Content -Raw -LiteralPath '$Installer' | Invoke-Expression"
        & $Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $command *> $Log
        $code = $LASTEXITCODE
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
    Write-Host "  ....  $Shell (one-liner) -> exit $code"
    return $code
}

function Wait-Health([int]$Port, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        # The fresh server serves its own self-signed certificate: -k.
        $status = & curl.exe -sk -o NUL -w '%{http_code}' "https://127.0.0.1:$Port/health" 2>$null
        if ($status -eq '200') { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    return $port
}

$TaskName = 'Paracord Server'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('paracord-install-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work -Force | Out-Null
$SystemInstall = 'C:\ParacordInstallSmoke'
$Installs = New-Object System.Collections.Generic.List[string]
$Installs.Add($SystemInstall)
$HttpServer = $null

try {
    # ---------------------------------------------------------------------
    Write-Host '== Preconditions'
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    if (-not $isAdmin) { throw 'this smoke needs an elevated session (GitHub Windows runners are)' }
    if (-not (Test-Path $ServerExe)) { throw "no server binary at $ServerExe - build it first (cargo build --release --bin paracord-server)" }
    foreach ($tool in @('powershell', 'pwsh', 'curl.exe', 'python')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is required" }
    }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        throw "a scheduled task '$TaskName' already exists on this machine - refusing to touch it"
    }
    & powershell -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' | ForEach-Object { Note "Windows PowerShell $_" }
    & pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' | ForEach-Object { Note "PowerShell $_" }

    # ---------------------------------------------------------------------
    Write-Host '== Package the server the way the release does'
    $version = '9.9.9-smoke'
    $asset = "paracord-server-windows-x64-$version.zip"
    $pkg = Join-Path $Work 'pkg\paracord-server'
    New-Item -ItemType Directory -Path $pkg -Force | Out-Null
    Copy-Item $ServerExe (Join-Path $pkg 'paracord-server.exe')
    Copy-Item 'config\paracord.example.toml' (Join-Path $pkg 'paracord.example.toml')
    Set-Content -Path (Join-Path $pkg 'README.txt') -Value "Paracord Server v$version (smoke package)"
    $zip = Join-Path $Work $asset
    Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zip -Force
    $sha = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Check (Test-Path $zip) "built $asset ($sha)"

    # ---------------------------------------------------------------------
    Write-Host '== 1. A local archive with a wrong .sha256 is refused'
    $badDir = Join-Path $Work 'bad-local'
    New-Item -ItemType Directory -Path $badDir -Force | Out-Null
    $badZip = Join-Path $badDir $asset
    Copy-Item $zip $badZip
    Set-Content -Path "$badZip.sha256" -Value (('0' * 64) + "  $asset") -NoNewline
    $inst = Join-Path $Work 'inst-bad-local'
    $log = Join-Path $Work 'bad-local.log'
    $code = Invoke-Installer 'powershell' $log @('-LocalArchive', $badZip, '-InstallDir', $inst, '-NoService', '-NoBrowser')
    Check ($code -ne 0) 'install.ps1 exits non-zero on a checksum mismatch'
    Assert-LogContains $log 'SHA-256 mismatch' 'the mismatch is reported'
    Check (-not (Test-Path $inst)) 'nothing was installed'

    # ---------------------------------------------------------------------
    Write-Host '== 2. Download over HTTP with SHA256SUMS.txt'
    $www = Join-Path $Work 'www'
    $tagDir = Join-Path $www "v$version"
    New-Item -ItemType Directory -Path $tagDir -Force | Out-Null
    Copy-Item $zip (Join-Path $tagDir $asset)
    $sums = Join-Path $tagDir 'SHA256SUMS.txt'
    # Tampered first: the right name, the wrong hash.
    [System.IO.File]::WriteAllText($sums, ('f' * 64) + "  $asset`n")
    $httpPort = Get-FreePort
    $HttpServer = Start-Process -FilePath 'python' -PassThru -WindowStyle Hidden `
        -ArgumentList @('-m', 'http.server', "$httpPort", '--bind', '127.0.0.1', '--directory', "`"$www`"")
    $baseUrl = "http://127.0.0.1:$httpPort"
    $up = $false
    for ($i = 0; $i -lt 40 -and -not $up; $i++) {
        $status = & curl.exe -s -o NUL -w '%{http_code}' "$baseUrl/v$version/SHA256SUMS.txt" 2>$null
        if ($status -eq '200') { $up = $true } else { Start-Sleep -Milliseconds 250 }
    }
    Check $up "throwaway release server up on $baseUrl"

    $inst = Join-Path $Work 'inst-bad-download'
    $log = Join-Path $Work 'bad-download.log'
    $code = Invoke-Installer 'powershell' $log @('-ReleaseBaseUrl', $baseUrl, '-Version', $version, '-InstallDir', $inst, '-NoService', '-NoBrowser')
    Check ($code -ne 0) 'a tampered SHA256SUMS.txt stops the install'
    Assert-LogContains $log 'SHA-256 mismatch' 'the mismatch is reported'
    Check (-not (Test-Path $inst)) 'nothing was installed'

    [System.IO.File]::WriteAllText($sums, "$sha  $asset`n")
    $inst = Join-Path $Work 'inst-download'
    $Installs.Add($inst)
    $log = Join-Path $Work 'download.log'
    $code = Invoke-InstallerAsOneLiner 'powershell' $log @{
        PARACORD_RELEASE_BASE_URL = $baseUrl
        PARACORD_VERSION          = $version
        PARACORD_INSTALL_DIR      = $inst
        PARACORD_NO_SERVICE       = '1'
        PARACORD_NO_BROWSER       = '1'
        PARACORD_ALLOW_INTERNET   = '1'
    }
    Check ($code -eq 0) 'the one-liner shape installs from the download'
    Assert-LogContains $log "SHA-256 verified: $sha" 'the download is verified against SHA256SUMS.txt'
    Check (Test-Path (Join-Path $inst 'paracord-server.exe')) 'paracord-server.exe installed'
    $cfg = Join-Path $inst 'config\paracord.toml'
    Check (Test-Path $cfg) 'config generated by paracord-server init'
    if (Test-Path $cfg) {
        Check ((Get-TomlValue $cfg 'network' 'auto_port_forward') -eq 'true') 'PARACORD_ALLOW_INTERNET=1 is written as auto_port_forward = true'
        $toml = Get-Content -Raw $cfg
        Check ($toml -notmatch '\./data/') 'no ./data/ path is left relative to the working directory'
        Check ($toml.Contains((($inst -replace '\\', '/') + '/data/'))) 'data paths are pinned to the install directory'
    }
    Assert-LogContains $log 'Auto-start skipped' 'PARACORD_NO_SERVICE=1 starts nothing'

    # ---------------------------------------------------------------------
    Write-Host '== 3. Fresh install for the whole computer (Windows PowerShell 5.1)'
    Set-Content -Path "$zip.sha256" -Value "$sha  $asset" -NoNewline
    $log = Join-Path $Work 'system.log'
    $code = Invoke-Installer 'powershell' $log @('-LocalArchive', $zip, '-InstallDir', $SystemInstall, '-HomeNetworkOnly', '-NoBrowser')
    Check ($code -eq 0) 'install.ps1 finishes'
    Assert-LogContains $log "SHA-256 verified: $sha" 'the local archive is verified against its .sha256'
    Assert-LogContains $log 'Installing for everyone on this computer' 'an elevated run installs for the whole computer'
    $sysCfg = Join-Path $SystemInstall 'config\paracord.toml'
    Check ((Get-TomlValue $sysCfg 'network' 'auto_port_forward') -eq 'false') '-HomeNetworkOnly is written as auto_port_forward = false'
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Check ($null -ne $task) "scheduled task '$TaskName' is registered"
    if ($task) {
        Check ($task.Principal.UserId -match 'SYSTEM') 'the task runs as SYSTEM'
        Check ($task.State -eq 'Running') "the task is running (state $($task.State))"
    }
    $webPort = [int](Get-TomlValue $sysCfg 'tls' 'port')
    Check (Wait-Health $webPort 90) "the server answers https://127.0.0.1:$webPort/health"
    $rules = @(Get-NetFirewallRule -DisplayName 'Paracord Server*' -ErrorAction SilentlyContinue)
    Check ($rules.Count -ge 2) "firewall rules created ($($rules.Count))"
    Assert-LogContains $log '/setup-server#claim=' 'the one-time owner setup link is printed'
    Assert-LogContains $log 'Only people on your home network can join' 'the ending says home network only'
    $configBefore = [System.IO.File]::ReadAllBytes($sysCfg)

    # ---------------------------------------------------------------------
    Write-Host '== 4. Re-running upgrades in place'
    $log = Join-Path $Work 'upgrade.log'
    $code = Invoke-Installer 'powershell' $log @('-LocalArchive', $zip, '-InstallDir', $SystemInstall, '-NoBrowser')
    Check ($code -eq 0) 'the upgrade finishes'
    Assert-LogContains $log 'Paracord was updated' 'it says it updated'
    $configAfter = [System.IO.File]::ReadAllBytes($sysCfg)
    Check ([Convert]::ToBase64String($configBefore) -eq [Convert]::ToBase64String($configAfter)) 'the config is kept byte for byte'
    $backups = @(Get-ChildItem -Path (Join-Path $SystemInstall 'backups') -Filter 'paracord-server-*.exe' -ErrorAction SilentlyContinue)
    Check ($backups.Count -ge 1) 'the previous binary is backed up'
    Check (Wait-Health $webPort 90) 'the upgraded server answers /health'
    $rules = @(Get-NetFirewallRule -DisplayName 'Paracord Server*' -ErrorAction SilentlyContinue)
    Check ($rules.Count -eq 2) "the upgrade did not duplicate the firewall rules ($($rules.Count))"

    # ---------------------------------------------------------------------
    Write-Host '== 5. -AllowInternet under PowerShell 7, nothing started'
    $inst = Join-Path $Work 'inst-pwsh'
    $Installs.Add($inst)
    $log = Join-Path $Work 'pwsh.log'
    $code = Invoke-Installer 'pwsh' $log @('-LocalArchive', $zip, '-InstallDir', $inst, '-AllowInternet', '-NoService', '-NoBrowser')
    Check ($code -eq 0) 'install.ps1 finishes under pwsh'
    $cfg = Join-Path $inst 'config\paracord.toml'
    Check ((Get-TomlValue $cfg 'network' 'auto_port_forward') -eq 'true') '-AllowInternet is written as auto_port_forward = true'
    Assert-LogContains $log 'Paracord asks your router' 'the ending says the router is asked'
    $code = Invoke-Installer 'pwsh' (Join-Path $Work 'both.log') @('-LocalArchive', $zip, '-InstallDir', $inst, '-AllowInternet', '-HomeNetworkOnly', '-NoService', '-NoBrowser')
    Check ($code -ne 0) '-AllowInternet with -HomeNetworkOnly is refused'
}
catch {
    Fail "smoke aborted: $($_.Exception.Message)"
}
finally {
    # ---------------------------------------------------------------------
    Write-Host '== 6. Cleanup'
    if ($HttpServer -and -not $HttpServer.HasExited) { Stop-Process -Id $HttpServer.Id -Force -ErrorAction SilentlyContinue }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    foreach ($dir in $Installs) {
        $exe = Join-Path $dir 'paracord-server.exe'
        Get-Process -Name 'paracord-server' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and ($_.Path -eq $exe) } |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Get-NetFirewallRule -DisplayName 'Paracord Server*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    foreach ($dir in $Installs) { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    Check ($null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) 'the scheduled task is gone'
    Check (@(Get-NetFirewallRule -DisplayName 'Paracord Server*' -ErrorAction SilentlyContinue).Count -eq 0) 'the firewall rules are gone'
    Check (-not (Test-Path $SystemInstall)) 'the install directory is gone'
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "$($script:Passed) passed, $($script:Failures.Count) failed"
if ($script:Failures.Count -gt 0) {
    $script:Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
exit 0
