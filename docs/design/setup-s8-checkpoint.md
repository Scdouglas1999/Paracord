# S8 checkpoint: sidecar bundling, release, CI service smoke

Package S8 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §2.1. Branch `feat/setup`. Builds on S6
(`paracord-host`), S7 (`paracord-hostctl`, its `live_service` test) and S4
(SQLCipher). Nothing was pushed; CI cannot run here, so every workflow change is
validated by actionlint and a YAML parse only.

## 1. What exists

| Piece | Where |
|---|---|
| `bundle.externalBin: ["binaries/paracord-host"]` | `client/src-tauri/tauri.conf.json` |
| Staging script and `npm run host:stage` | `client/scripts/stage-host-sidecar.mjs`, `client/package.json` (scripts only) |
| Staged files are never committed | `client/src-tauri/binaries/.gitignore` |
| Missing sidecar is a loud build error; a placeholder is refused in a release build | `client/src-tauri/build.rs` |
| Size-optimized build profile for the sidecar | `[profile.host]` in the root `Cargo.toml` |
| Inno Setup ships `paracord-host.exe` beside `Paracord.exe` | `installer/paracord-client.iss` |
| Release: build and stage per target before `tauri build`, then prove it is inside the package | `.github/workflows/release.yml` (macOS x2, Windows, Linux) |
| CI: `hostctl-smoke-linux`, `hostctl-smoke-macos`, `hostctl-smoke-windows` | `.github/workflows/ci.yml` |
| CI: Strawberry Perl for the OpenSSL build on Windows | `storage-encryption-targets`, `cross-platform-smoke`, `hostctl-smoke-windows`, release Windows job |
| CI: stand-in sidecar for compile-only jobs | `migration-feature-sanity`, `rust`, `cross-platform-smoke`, `coverage` |

### The staging script

`node scripts/stage-host-sidecar.mjs [--release] [--target <triple>] [--placeholder]`.

- Default: debug `paracord-host` for this machine (dev). `--release` builds with
  `--profile host --locked`. `--target` builds for an explicit triple and stages
  under that name. Output:
  `client/src-tauri/binaries/paracord-host-<triple>[.exe]`.
- Finds the build output through `cargo metadata`, so `CARGO_TARGET_DIR` works.
- Refuses to build without `client/dist` (the binary embeds the UI), fails if
  cargo fails, and fails if the staged file is under 1 MB. No fallbacks.
- `--placeholder` writes a marked text file for jobs that only compile.

### Missing sidecar

Tauri already stops with `resource path ... doesn't exist` when the file is
missing, but that says nothing about what to do. `build.rs` runs first and
panics with the file it wants, `npm run host:stage`, the release form of the
command, and the placeholder option. It also panics if the staged file is the
placeholder and `PROFILE=release`, so `tauri build` can never bundle a stand-in.
Both messages were seen locally.

Consequence worth knowing: `client/src-tauri` is a root workspace member, so
**every** `cargo check|clippy|test --workspace` compiles its build script and
needs a staged file. That is why five CI jobs (and `scripts/setup.sh`) now stage
`--placeholder` first. A developer's first `cargo check --workspace` needs
`cd client && npm run host:stage -- --placeholder` (or a real `npm run host:stage`).
`CLAUDE.md` and `README.md` should say so (S14 owns the docs; not edited here).

### Release workflow

Each client job: `npm ci` → (new) `npm run build` → (new)
`npm run host:stage -- --release --target <triple>` → `tauri build` → (new)
a check that `paracord-host` is inside the artifact (`Paracord.app/Contents/MacOS`,
`target/release/paracord-host.exe` plus the NSIS installer exists, the `.deb`
listing). Targets: `aarch64-apple-darwin` and `x86_64-apple-darwin` (native
runners, as the client already is), `x86_64-pc-windows-msvc`,
`x86_64-unknown-linux-gnu`. The `npm run build` is needed because the script
checks `client/dist`; `tauri build` runs it again through `beforeBuildCommand`
(about a minute, accepted rather than editing Tauri's config). The signing key
is still only in the `tauri build` step. Server archive jobs are untouched.

The Windows step sets `OPENSSL_SRC_PERL=C:\Strawberry\perl\bin\perl.exe` and
throws if it is not there, so Git's msys perl can never be picked up by
`openssl-src`. The Inno script names the MSVC-triple file in `binaries/`, so the
Inno compiler itself fails if the stage step was skipped.

### CI smoke jobs

All three run `cargo test --locked -p paracord-hostctl --test live_service
-- --nocapture --test-threads=1` with `PARACORD_HOSTCTL_LIVE=1`.

| Job | Setup | Extra |
|---|---|---|
| `hostctl-smoke-linux` (ubuntu-latest) | `sudo loginctl enable-linger $USER`, `systemctl start user@UID`, wait for `/run/user/UID/bus`, export `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` | lifecycle only (no secret service on the runner; S15's container covers the real binary on Linux) |
| `hostctl-smoke-macos` (macos-14) | prints `launchctl print gui/UID` first | lifecycle blocks the job; then builds `paracord-host` and runs the real-binary setup rows 1-2 with `continue-on-error: true` (needs the login keychain unlocked; the first run decides whether that can become blocking). **This job is the first macOS compile of `paracord-hostctl`.** |
| `hostctl-smoke-windows` (windows-latest) | Strawberry Perl env | lifecycle, then the real-binary run, both blocking |

An "update on the macOS runner" keychain-prompt check (plan risk row) is not
covered: that needs a signed bundle pair and is a release-time observation.

## 2. Bundle size delta

Measured on Linux (x86_64), `CARGO_TARGET_DIR=…/Paracord-glass/target`.

| Measurement | Size |
|---|---|
| `paracord-host`, profile `host` (strip + thin LTO), Linux | 66,592,368 B (63.5 MiB) |
| `paracord-host`, debug (`npm run host:stage`, dev) | 873.7 MiB (debuginfo; dev only) |
| plain `release` `paracord-server`, for comparison | 85,955,864 B (82.0 MiB) |
| `paracord-host` for Windows, `x86_64-pc-windows-gnu` cross-build, profile `host` | 59.6 MiB (GUI subsystem PE, confirmed with `file`) |
| desktop exe, `tauri build --no-bundle` | 50,094,072 B |
| `.deb` without the sidecar (`bundle.externalBin=[]`) | 16,466,100 B |
| `.deb` with the sidecar | 43,275,860 B |
| **Delta, `.deb`** | **+26.8 MB compressed (+63.5 MiB installed, in `/usr/bin`)** |

The plan estimated +30-50 MB; the compressed Linux package lands just under it.
`profile.host` saves about 22 MB over a plain release build. macOS and Windows
MSVC deltas are **not measured here** (no toolchain); expect the Windows MSVC
exe near the gnu figure and the NSIS/MSI (LZMA) near +25 MB. The release workflow
does not print a delta; compare artifact sizes of a tagged build against the
previous release.

## 3. Verified locally

| Check | Result |
|---|---|
| `npm run host:stage` (debug) and `-- --release` | both staged; release build 4m14s cold |
| Missing sidecar: `cargo check -p paracord-desktop` | clear panic with the staging command |
| `--placeholder` then `cargo check` | passes; `cargo check --release` refuses the placeholder |
| `npx tauri build --no-bundle` with the real sidecar (`beforeBuildCommand` blanked so S13's in-progress UI files cannot affect it) | built; Tauri copied `paracord-host` beside `paracord-desktop`, which is where `bundled_sidecar()` looks |
| `tauri build --bundles deb`, with and without | `usr/bin/paracord-host` (mode 755) present only with; sizes above |
| Windows: `npm run host:stage -- --release --target x86_64-pc-windows-gnu` | staged `paracord-host-x86_64-pc-windows-gnu.exe` (`.exe` naming, no chmod); then removed |
| actionlint (the pinned image the repo uses) on `ci.yml`, `release.yml`, `security-*.yml` | clean; `release.yml`/`ci.yml` also parse as YAML |
| `bash -n scripts/setup.sh` | ok |

Not run: any workflow, the Inno compiler, NSIS/MSI, macOS anything, and no
service was installed on this machine.

## 4. Files outside the S8 row

Smallest additive changes, all needed for the row to work:

- `Cargo.toml`: the `[profile.host]` table (3 keys).
- `client/src-tauri/build.rs`: the sidecar check (the "loud error" lives here).
- `scripts/setup.sh`: stages a placeholder if none exists before its
  `cargo check --workspace`, which would otherwise fail on a fresh checkout.
- `ci.yml` jobs other than the new ones: a stand-in step in four jobs and a
  Strawberry Perl step in `storage-encryption-targets` / `cross-platform-smoke`.

## 5. Open

- **S14 / docs:** say in CLAUDE.md, README and `deployment.md` that a first
  `cargo check --workspace` needs `npm run host:stage -- --placeholder`.
- First CI run of the macOS job decides whether the real-binary step can drop
  `continue-on-error`. Watch `launchctl bootstrap gui/UID` on the hosted runner.
- Ubuntu runner: if `user@UID.service` does not come up, the job fails at the
  bus wait with a clear message; the fallback would be `systemd-run --user` in
  a container, which S15 already does.
- Signing: the sidecar is not signed separately. On macOS the bundle signature
  covers it when an Apple identity is configured; otherwise it is unsigned like
  the app. Windows ships it unsigned, like `paracord-desktop.exe` (SmartScreen
  risk row unchanged).
- Windows MSVC and macOS compile of `paracord-host` itself is first proven by
  the smoke jobs and the release run.
