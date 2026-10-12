# S7 checkpoint: desktop host service

Package S7 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §2.2–§2.6, §2.8–§2.10 and the host commands
of §9.5. Branch `feat/setup`. Builds on S6 (`paracord-host`, `init --profile
desktop-host`, `/host/*`, token file) and S4 (key provisioning in `init`,
`restore-backup --escrow-key-stdin`).

**No service, Scheduled Task or LaunchAgent was installed, enabled or started
on this machine.** The live test exists and was not run (`PARACORD_HOSTCTL_LIVE`
unset everywhere here).

## 1. What exists

| Piece | Where |
|---|---|
| New crate (workspace member) | `crates/paracord-hostctl` |
| Service managers: systemd user unit, per-user Scheduled Task, LaunchAgent (install / set_autostart / start / stop / remove / status) | `src/service/{mod,systemd,schtasks,launchd}.rs` |
| Every process goes through `CommandRunner` (tests record commands; `SystemRunner` sets `CREATE_NO_WINDOW` on Windows, retries `ETXTBSY` on Linux) | `src/runner.rs` |
| Layout (§2.2), `host.json` (0600, atomic, `deny_unknown_fields`, version 1) | `src/layout.rs`, `src/state.rs` |
| Binary install: temp file beside the target, fsync, rename, 0755; `.previous`; dirs 0700; free space (statvfs / `GetDiskFreeSpaceExW`) | `src/fsutil.rs` |
| Preflight (§2.3) with injectable probes | `src/preflight.rs` |
| Keychain probe + delete (same `Paracord` / `probe:<uuid>` roundtrip as S4's `at_rest_boot::keychain`, fresh-entry read-back, platform stores only) | `src/keychain.rs` |
| Control channel: loopback client **pinned to the host's own certificate** (`[tls] cert_path`), token read per call; existing-server probe | `src/control.rs` |
| `init`, `--version`, `restore-backup` invocations | `src/sidecar.rs` |
| Windows Firewall rule pair through one UAC prompt; decline is not fatal | `src/firewall.rs` |
| Setup orchestration, claim/escrow, status, Settings actions, launch supervision, update, rollback, restore | `src/host.rs` |
| Tauri commands | `client/src-tauri/src/host.rs` (stubs replaced) |
| Client | `client/src/lib/host/{types,commands,rows}.ts`, `client/src/stores/hostStore.ts` |

### Service definitions (§2.4)

Golden files in `crates/paracord-hostctl/tests/golden/`
(`paracord-host.service`, `paracord-host-task.xml`,
`com.paracord.desktop.host.plist`); `UPDATE_GOLDEN=1` regenerates. The unit is
the spec text verbatim and runs
`<host>/bin/paracord-host -c <config> --log-file <host>/logs/server.log`.
Names never collide with the installers' (`paracord-host.service`,
`\Paracord\Paracord on this computer`, `com.paracord.desktop.host`). The
Scheduled Task XML is written as UTF-16 LE with a BOM to a temp file and
deleted after `schtasks /Create /XML … /F`.

Status is read in non-localized form: `systemctl --user show
--property=…`, PowerShell `Get-ScheduledTask` (State enum + LastTaskResult +
enabled triggers), `launchctl print` / `print-disabled`. `ServiceStatus {
state: not_installed|stopped|starting|running|failed, enabled, exit_code }`;
exit 78 is surfaced as `storage_key_problem` with the reason from the log.

## 2. Setup (§2.6) and the contract for S13

`host_setup_start({ port })` runs **rows 1 and 2** and returns. **Rows 4 and 5
run only once `escrow` is in `host.json.setup.completed_steps`** (written by
`host_write_escrow`), so the first backup carries the key escrow (§4.7). The
page calls `host_setup_start` again after row 3 and for **Try again**;
finished steps come back as `ok` without work. `start` and `reach` are never
skipped (they report the present). The command resolves when the run stops;
a failed step is reported by its event, not by rejecting.

Events (`host://progress`, `HostProgress`): `run` then `ok` per step, so row 1
emits install/init/service/start; **a row is done when its last step is ok**
(row 1 = `start`). Codes and details (spec copy):

| Row/step | fail `code` | detail |
|---|---|---|
| 1 install | `install_failed` | Couldn't copy Paracord's server files ({error}). |
| 1 init | `init_failed` | the binary's reason line |
| 1 service | `service_failed` | Couldn't register Paracord to run in the background ({error}). (ok event may carry `firewall_declined` / `firewall_failed`) |
| 1 start | `start_timeout` / `start_failed` / `storage_key` | Paracord on this computer didn't start. / … can't open its storage key: {reason} |
| 2 storage | `storage_unencrypted` / `status_unavailable` | Paracord on this computer is running without encryption. |
| 4 reach | warn/ok, `code` = reachability state (`asking` after 15 s; `status_unavailable`) | §5.4 copy verbatim |
| 5 backup | `backup_failed` | The first backup didn't finish ({error}). |

**`hostStore` (what S13 renders):**

- `rows: HostRow[]` — `{ row, title, detail, state: waiting|run|ok|warn|fail, step, code, chips }`, chips from `show_me_how | try_again | show_details | what_can_i_do | allow`. Copy for all five rows lives in `lib/host/rows.ts` (`HOST_ROW_COPY`), plus `reachabilityCopy()` for Settings / claim mode, `PREFLIGHT_COPY`, `setupCanContinue()`, `previewStatus()` (`not_running | starting | online`).
- `runSetup({ port, account })` → `'done' | 'failed'`. `account()` is row 3: the page derives identity + credential, calls `useHostStore.getState().claim(request)` (`host_claim`), publishes prekeys, then `writeEscrow(wrappingKey)`; reject with an `Error` whose message is the row's detail. `phase` is `idle | running | account | done | failed`. Each row is shown running ≥ 300 ms (`MIN_RUN_MS`); nothing else is delayed.
- `retry()` (Try again), `retryReachability()` (re-emits row 4), `allowFirewall()`, `logsTail(200)` (Show details), `runPreflight()` / `preflight`.
- Settings (§2.9): `loadInfo()` → `info: HostInfo`, `loadStatus()` → `status`, `start`, `stop`, `setAutostart`, `backupNow`, `remove(deleteData)`, `rollbackUpdate`; errors land in `error`.
- **App start:** someone must call `useHostStore.getState().onLaunch()` once when the desktop app boots (S13 / App bootstrap; not wired by S7 because `App.tsx` is not mine). It returns `launch: { info, update, start_error }`; `update.kind === 'failed'` → the banner "Paracord on this computer didn't start after the update." with Show details and **Restore the backup from before the update** (`rollbackUpdate`).

**S13a fixture:** the scripted `host_setup_start` emits rows 1, 2, 4, 5 in one
call. With the real contract the second call (after row 3) emits rows 4–5; and
the store calls `host_info` before each run. The fixture needs `host_info`
(returning `completed_steps`, with `escrow` after the page's
`host_write_escrow`) and a second-call script. Everything else matches
(codes, copy, events).

## 3. Launch, update, restore (§2.8, §4.8)

- `host_on_launch`: if hosting, update when the bundled sidecar's
  `--version` is newer than `installed_version` (and not `held_version`),
  then start the service if autostart is on and it isn't running (≤ 30 s
  health wait). No background polling anywhere.
- Update: the server must be up for `POST /host/backup-now` (it is started if
  needed; if that or the backup fails → `not_started`, nothing changed).
  Then: record `update` in `host.json`, stop, `bin/paracord-host` →
  `.previous`, copy the new one in, start, wait ≤ 60 s. Failure is recorded
  and shown on every launch; **nothing is reverted** until the person asks.
- `host_rollback_update`: stop, `.previous` back to `bin/`, `restore-backup`
  of the pre-update archive (no escrow key: the key is in the keychain) into
  `<root>/restores/<stamp>/`, the service re-registered with that generation's
  config (`host.json.config_path`), start. The new version is **held** (not
  retried automatically).
- `host_restore({ archivePath, wrappingKey })`: on an existing host: stop,
  `restore-backup --escrow-key-stdin` (key on stdin only), activate the
  generation, start. On a fresh computer: install, `init`, then **delete the
  key `init` just generated** (S4: `--escrow-key-stdin` refuses to replace a
  different key; the server never started, so nothing used it), restore,
  record `claim`/`escrow`; rows 1, 2, 4, 5 then run through
  `host_setup_start`. A database already under the root is refused up front;
  any later failure removes the half-made root and resets `host.json`.

## 4. Tauri commands

§9.5 commands, all on `spawn_blocking`; mutating ones serialized by one lock.
**Added beyond §9.5** (each has a `generate_handler!` line, all used by
`hostStore`): `host_info`, `host_on_launch`, `host_rollback_update`,
`host_allow_firewall` (→ `"allowed" | "declined"`). JS arguments are
camelCase (`{ wrappingKey }`, `{ deleteData }`, `{ archivePath, wrappingKey }`).

## 5. Tests and gates

| Gate | Result |
|---|---|
| `cargo test -p paracord-hostctl` | 55 unit + 5 golden + 2 live (inert without the env var) pass; lib run 3× for flakiness: stable |
| `cargo clippy -p paracord-hostctl --all-targets -D warnings` | clean |
| same with `--target x86_64-pc-windows-gnu` | clean (Windows paths compile: firewall, `GetDiskFreeSpaceExW`, schtasks) |
| `--target aarch64-apple-darwin` | not checkable here (`ring` needs an Apple toolchain); the launchd code is exercised by unit tests on Linux; S8's macOS job runs it |
| `cargo clippy -p paracord-desktop --all-targets -D warnings` | clean |
| `cargo test -p paracord-desktop --lib host::` | pass |
| `cargo fmt` on my files | clean |
| `paracord-host --version` (debug build) | `paracord-server 3.3.0` |
| `npm run typecheck`, eslint on my files, `test:tokens`, `test:motion-lint` | pass |
| `npm run test:unit` | 4843 passed, 2 failed in `MessageInput.test.tsx` (that file is modified in the working tree by another package; not S7) |
| `tauriCommandRegistry.test.ts` | pass (every `invoke` in `lib/host/commands.ts` is registered) |

What the unit tests cover with a fake service manager, a fake server and a
shell-script stand-in for `paracord-host` (Unix): the full row sequence and
resume, the row-3 gate, init reason line, exit 78 with the log's reason,
start timeout, storage refusal (non-keychain source), reach copy and chips,
backup failure, retry of row 4, claim from the claim file (and refusal of a
second claim), 409 escrow, autostart, remove with and without data (keychain
entry deleted only with data), log tail, update success, failed update not
reverted then rollback (`.previous`, archive path, generation config, held
version), update without a backup changes nothing, fresh restore (generated
key deleted, escrow key only on stdin), refused restore over an existing
database. Exact command lines for systemd, schtasks and launchctl.

**Live test** `crates/paracord-hostctl/tests/live_service.rs`, only with
`PARACORD_HOSTCTL_LIVE=1` (S15 container, S8 CI jobs): installs
`paracord-host-test-<rand>` running a sleeper, checks install doesn't start
it, start → running, autostart off, stop → stopped, start with autostart off,
autostart on, remove (twice). Cleanup on drop. With
`PARACORD_HOSTCTL_LIVE_HOST_BINARY=<paracord-host>` it also runs preflight and
setup rows 1–2 against the real binary (needs an unlocked keychain), checks an
encrypted status, stop/start, and removes everything (firewall untouched).

## 6. Deviations and decisions

1. **Rows 4–5 wait for the escrow** (second `host_setup_start` call) rather
   than running in the same call as rows 1–2, so the first backup contains
   `key_escrow`.
2. **Windows autostart off disables the logon trigger**, not the task
   (`Enabled=false` would make `schtasks /Run` — the Start button — fail).
   macOS autostart off is `launchctl disable`; Start then enables for the
   bootstrap and disables again.
3. `launchctl kickstart` without `-k` right after a bootstrap (RunAtLoad
   already started it); `-k` when it was already loaded.
4. The loopback client pins the host's own certificate file instead of
   trusting any loopback certificate; the existing-server probe (reads
   `/health` only, sends nothing) accepts any certificate.
5. `host.json` carries extra fields: `instance_id`, `config_path` (after a
   restore), `update`, `held_version`; and the step names `claim`, `escrow`.
6. `remove(false)` keeps data and `install`/`init`/`claim`/`escrow`, so a
   later Host resumes on the same server; `remove(true)` deletes the keychain
   entry first and stops if that fails (data kept).
7. The keychain probe mirrors S4's `at_rest_boot::keychain::probe` (same
   service, account shape and fresh-entry read-back) because that module lives
   in the server binary crate; key generation/provisioning stays in `init`
   (S4's `provision_configured_source`).
8. A `--version` flag on the server CLI (`cli.rs`, one attribute) — S4 already
   committed it with its own change in 78b36e88.
9. `start` and `reach` are never skipped on resume (they report the present).

## 7. Files outside the S7 row

None beyond the row (`cli.rs` landed in S4's commit, item 8). Shared files:
`Cargo.toml` members line, `Cargo.lock` (new crate entry),
`client/src-tauri/Cargo.toml` (dep), `client/src-tauri/src/lib.rs` (four
`generate_handler!` lines).

## 8. Open

- S13: wire `onLaunch()` at desktop boot; update the S13a fixture (§2 above).
- S8: run `live_service.rs` in `hostctl-smoke-{linux,macos,windows}`; the
  macOS compile is first proven there.
- S15: set `PARACORD_HOSTCTL_LIVE_HOST_BINARY` for the real-binary run.
- `restore-backup` writes a generation config whose claim file location is
  the generation directory; irrelevant after a claim, noted for S13's restore
  UI.
