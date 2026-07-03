<#
.SYNOPSIS
    Export the libvpx (VP9) build environment for the Paracord desktop client on Windows.

.DESCRIPTION
    The Tauri desktop crate (paracord-desktop) enables the `vpx` feature by default,
    which links libvpx for VP9 video encode/decode. On Windows libvpx is provided by
    the vcpkg `x64-windows-static` triplet under tmp-vcpkg/. The env-libvpx-sys build
    script discovers it through the VPX_LIB_DIR / VPX_INCLUDE_DIR / VPX_VERSION vars.

    These vars used to live in a global .cargo/config.toml [env] block, but cargo's
    [env] cannot be scoped per-OS, so the Windows-only paths leaked onto Linux/macOS
    builds (which discover libvpx through pkg-config instead). This script sets the
    same vars for the current PowerShell session only — nothing is written to a file
    that other platforms read.

    Dot-source it so the exports survive in your shell:

        . .\scripts\set-vpx-env.ps1
        cargo build --bin paracord-server
        # or, from client\:  npx tauri build

    Never disable or remove the `vpx` feature to dodge a linker error — that silently
    breaks screen share and video calls at runtime. Fix the build environment instead.

.PARAMETER VcpkgRoot
    Path to the vcpkg install prefix. Defaults to the repo's tmp-vcpkg/ directory.

.PARAMETER Version
    libvpx version string reported to env-libvpx-sys. Defaults to 1.16.0.
#>
[CmdletBinding()]
param(
    [string]$VcpkgRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp-vcpkg'),
    [string]$Version = '1.16.0'
)

$ErrorActionPreference = 'Stop'

$installed = Join-Path $VcpkgRoot 'installed\x64-windows-static'
$libDir = Join-Path $installed 'lib'
$includeDir = Join-Path $installed 'include'

if (-not (Test-Path (Join-Path $includeDir 'vpx\vpx_encoder.h'))) {
    Write-Warning "libvpx headers not found under '$includeDir'."
    Write-Warning "Build them first:  cd tmp-vcpkg; vcpkg install libvpx:x64-windows-static"
}

$env:VPX_LIB_DIR = $libDir
$env:VPX_INCLUDE_DIR = $includeDir
$env:VPX_VERSION = $Version
$env:VPX_STATIC = '1'

Write-Host 'libvpx build environment set for this session:'
Write-Host "  VPX_LIB_DIR     = $env:VPX_LIB_DIR"
Write-Host "  VPX_INCLUDE_DIR = $env:VPX_INCLUDE_DIR"
Write-Host "  VPX_VERSION     = $env:VPX_VERSION"
Write-Host "  VPX_STATIC      = $env:VPX_STATIC"
