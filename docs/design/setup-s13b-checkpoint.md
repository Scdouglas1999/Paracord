# S13b checkpoint: the remaining first-run pieces

Package S13b of the first-run program, finishing what
[`setup-s13-checkpoint.md`](setup-s13-checkpoint.md) §5–§6 left: restore from
a backup, claim-mode escrow, the failed-update banner, M1's recovery refusal,
the per-device Privacy line and the small follow-ups. Spec:
[`setup-spec.md`](../setup-spec.md) §1.4, §2.8, §2.11, §3.8, §4.7, §4.8.

## 1. What was built

### Restore from a backup (§1.4, §4.8)

| Piece | Where |
|---|---|
| "Restore from a backup instead" under the swatches on Host › Name, only when preflight is `ok` and not `already_hosting` | `components/firstRun/NameStep.tsx` |
| New path `restore` (`/welcome/restore/backup`, `/welcome/restore/setup`; desktop only; Back returns to Host › Name) | `stores/firstRunStore.ts`, `pages/firstRun/FirstRunPage.tsx` |
| Restore › Backup: the system file picker card, the file's date/size/version, the phrase box (numbering from the saved file ignored), errors under each field | `components/firstRun/RestoreStep.tsx`, `firstRun.css` (`.fr-pick`, `.fr-backup`, `.fr-inp--area`) |
| Checks before anything runs: no escrow in the backup, an unencrypted backup, a phrase that is not the backup owner's (the phrase's public key against the escrow's `owner_public_key`), a malformed phrase | `pages/firstRun/restore.ts` |
| Restore › Setup: row 0 "Restoring from your backup" (`host_restore` with the escrow key of the archive's instance), then host rows 1–5 through `hostStore.runSetup`; row 3 is retitled "Protecting its key with your recovery phrase" and escrows the key again for the **new** instance; the phrase is dropped when setup finishes; "This computer already has a server database" → row 0 fails with no Try again; Continue → Sign in on this computer's server ("Your server is back…") | `pages/firstRun/flows.ts` (`pickBackup`, `checkRestorePhrase`, `runRestoreSetup`), `FirstRunPage.tsx` |
| Tauri `host_pick_backup` (dialog plugin, already a dependency) → `BackupFile` or null; hostctl reads only `manifest.json` (≤ 1 MiB) | `client/src-tauri/src/host.rs`, `lib.rs` (one `generate_handler!` line), `crates/paracord-hostctl/src/backup_file.rs` (+ `flate2`, `tar` deps, both already in the lock) |
| `hostStore.pickBackup()`, `hostStore.restore()`; `commands.hostPickBackup` | `stores/hostStore.ts`, `lib/host/commands.ts` |

**Why row 3 runs on a restore.** `init` gives the restored server a new
instance id and there is no `storage-key.escrow` under the new root, so
backups after a restore carried no escrow and the next restore was impossible.
`Host::restore_fresh` now records only `claim` (not `escrow`), so S7's gate
makes rows 4–5 wait for the page's `host_write_escrow` exactly as on a new
host. The live run proves the first backup after the restore carries an escrow
for the new instance that the same phrase opens.

### Manual restores: `paracord-server escrow-key`

`paracord-server escrow-key [--archive <backup>] [--instance-id <id>]` reads
the phrase from stdin (one line; `1.` numbering and the old "artifact"
spelling accepted), checks it against the archive escrow's owner key, prints
only the b64url escrow key. Pipe it into `restore-backup --escrow-key-stdin`.
The BIP39 list is `crates/paracord-server/data/bip39-english.txt`, pinned by
the official SHA-256 (`2f5eed53…`). Tests use the shared vectors
(`credential_vectors.json` `phrase[0]` + `escrow[0]` → `A5duufT…`).
`ed25519-dalek` (workspace dep) added to `paracord-server`.
`docs/backup-recovery.md` now gives the pipe, what it refuses, and how to save
a recovery copy again on a server restored by hand.

### Claim-mode escrow (§2.11, §4.7)

`HostStatus.instance_id: Option<String>` (contract, `serde(default)`, skipped
when absent) is filled from the running `[host] instance_id`. After the claim
the page reads `/admin/host-status`; if storage is encrypted and not yet
escrowed it derives the key from the new owner's phrase and calls
`POST /admin/storage-key/escrow` (a 409 "already escrowed" counts as done).
A failure, or a server without an instance id, never fails setup (the account
exists): row 2 becomes a **warn** that says why and to keep a copy of the key.
Contracts regenerated (`contracts:check` 55 verified). Docs:
`docs/encryption.md` "Recovering the storage key" (the "does not make it yet"
sentence is gone), `scripts/install.sh` / `install.ps1` reminder (fresh
install: the setup page saves it, check the storage row; upgrade/conversion:
save one under the owner's phrase). Both still contain "recovery copy" for
`ci_install_smoke`.

### The launch banner (§2.8)

`components/host/HostLaunchBanner.tsx` (+ `hostLaunchView.ts`, pure, tested)
draws `useHostStore.launch` as an Index banner strip (index-spec §6.8) in the
app's `BannerStack` (one line in `lib/AppProviders.tsx`):

| State | Copy | Actions |
|---|---|---|
| `update.kind === 'failed'` or `info.update_failure` | Paracord on this computer didn't start after the update. | **Show details** (last 200 log lines in a dialog), **Restore the backup from before the update** (`rollbackUpdate`) |
| restoring | Restoring the backup from before the update… | — |
| restored | Paracord on this computer is running {from} again, with the backup from before the update. {to} won't be installed again until a newer version comes out. | dismiss |
| restore failed | Restoring the backup from before the update didn't finish: {error}. | Show details, Try again |
| `not_started` | Paracord on this computer wasn't updated, and nothing changed: {detail}. | dismiss |
| `storage_key_problem` | Paracord on this computer can't open its storage key: {reason}. | Show details, Try again (`start` then `onLaunch`) |
| `start_error` | Paracord on this computer didn't start: {reason}. | Show details, Try again |

### M1's recovery refusal

No first-run screen sends a phrase to a server except "Forgot your password?"
(SignInStep → `/recover`); that page shows `credentialErrorMessage`, i.e. "No
account on this server uses that recovery phrase." New test
`pages/AccountRecoverPage.noAccount.test.tsx` drives it. The restore phrase is
checked locally against the backup's owner key (no server round trip), and a
wrong one says "That recovery phrase doesn't unlock this backup. It needs the
phrase of the account that set up the server." `errorMessage` now passes the
shell's string rejections through (they were shown as "An unexpected error
occurred").

### Small fixes

- Settings › Privacy: "Only on this computer." under "Ask for my password when
  Paracord opens" on one-password accounts (`PrivacySection` `perDevice`, set
  in `UserSettings.tsx`, one line); test `PrivacySection.test.tsx`.
- `config/paracord.example.toml`: `auto_port_forward = true`, comment updated.
- `docs/deployment.md`: "Invite link guessing limits" (30/min, 20 misses → 10
  min lockout, in memory per process: a restart resets it, replicas count
  separately, trusted proxy needed).
- `npm run test:motion` takes a port: `PARACORD_E2E_APP_PORT=<p>` (stub on
  p + 2; default 4173/4175) in `playwright.config.ts`.

## 2. Bugs found by the live run (fixed)

1. **A fresh desktop restore could never finish** (S7 + S4): `init --profile
   desktop-host` writes no TLS certificate (the server makes it on first
   start), and `restore-backup` demands the original certificate. Now a
   desktop-host config (`[host] enabled`, `tls.auto_generate`, no ACME) with
   neither cert nor key restores without carrying TLS material; the restored
   server makes its own certificate (a new identity on a new computer, which
   friends' apps already flag). Any other config still must bring its
   original certificate. `crates/paracord-server/src/restore.rs`.
2. **A failed fresh restore left the archive's key in the keychain.**
   `restore_fresh` now deletes the config's keychain entry before removing the
   half-made root. Unit test
   `a_fresh_restore_that_stops_takes_back_the_key_it_may_have_stored`.
3. The escrow gap above (restored servers had no escrow).

## 3. Checks

| Check | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -D warnings` (after `host:stage --placeholder`) | clean |
| `cargo test -p paracord-hostctl -p paracord-server -p paracord-contracts` | all pass (hostctl 59 unit, server 115 unit incl. 5 `escrow_key`) |
| `cargo test -p paracord-api --test host_control --test escrow_vector --test host_backups --test backup_status_event`; `-p paracord-desktop --lib host` | 15 + 1 + 2 + 1; 11 pass |
| `npm run typecheck`, `test:unit` | clean; 487 files, 4850 passed |
| `npm run lint` | 0 errors (242 warnings; none in new files) |
| `test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast`, `contracts:check` | pass |
| `PARACORD_E2E_APP_PORT=5013 npm run test:motion` | 20 passed (5013/5015) |
| `setup-s13.spec.ts` (5003/5005, WP `s13b`) | 34 passed (29 S13 + 5 new) |
| `setup-harness.spec.ts` | 21 passed |
| `real-server.setup-claim` + `setup-join` (release build with this UI, own servers, media 18291) | 2 passed; the claim spec now runs an encrypted server (file key, `[host] instance_id`/`escrow_file`) and asserts the escrow file exists, names the phrase's public key, and unwraps (HKDF + AES-GCM in Node) to the server's own key file |
| shellcheck / `bash -n` install.sh; install.ps1 still ASCII | pass (PowerShell grammar parse not run: no pwsh image here) |

### Compare (`node e2e/setup-compare.mjs s13b`, 1280×800)

Prototype references: 29, mean of means 0.92% (S13: 0.94%). New derived
references (`setup-reference.mjs`, labeled derived in `manifest.json`):

| State | Mean |
|---|---|
| host-name-restore-link | 0.26% |
| restore-backup-empty / -chosen | 0.42% / 0.76% |
| restore-wrong-phrase / restore-no-escrow | 1.00% / 0.73% |
| restore-setup-running / -done | 0.54% / 0.43% |
| restore-database-exists | 0.44% |
| update-failed-banner / update-rolled-back-banner | 3.00% / 3.30% |

Shots in `output/design-reference/setup-build/s13b/` (plus `restore-sign-in`,
`update-failed-details`), side-by-sides in `…/s13b/compare/`, read. The banner
difference is the app behind the strip, not the strip: the S13 scene has no
gateway, so the app shows "This server isn't yours to open" where the
reference shows the prototype's channel; the strip's place, size, ink and
actions match. `claim-mode-setup-at-rest-on` stays 0.53% because the scene's
status now carries `instance_id` (and the test asserts one escrow call).

### Live restore (release build, scratch root, no service installed)

1. **Source** (this machine, port 18520/18521, `.live-env-s13b`): the release
   `paracord-server` with this UI, `file` key source and `[host]
   instance_id`/`escrow_file`, claimed through the real `/setup-server` page
   by headless Chromium; row 2 "Encrypted on disk, with the key stored on the
   same disk…" ok; `storage-key.escrow` written; `POST /admin/backup` →
   archive with `key_escrow`. `escrow-key --archive` with the shown phrase →
   43-char key; with the vector phrase → "not the one of this server's owner";
   on a non-archive → "… is not a Paracord backup".
2. **Restore** (throwaway `archlinux` container, `dbus-run-session` +
   `gnome-keyring-daemon`, `--cap-add=IPC_LOCK`): new env-gated test
   `crates/paracord-hostctl/tests/live_restore.rs` drives the real `Host` with
   the real runner, keychain and binary; only the service manager is a child
   process. `inspect_backup` → `escrow-key --archive` → `Host::restore`
   (install, init, generated key deleted, `restore-backup
   --escrow-key-stdin`) → rows 1–2 (encrypted, `setup_required` false, new
   instance id ≠ archive's) → `write_escrow` with `escrow-key --instance-id
   <new>` → rows 4–5 (router: no answer, warn) → the backup row 5 made has an
   escrow for the new instance with the same owner key, and `escrow-key
   --archive` on it accepts the phrase → `remove(true)`. **Pass; 0 keychain
   entries left.** The owner's keychain and services were never touched.

Run it again: build `paracord-server`, make an escrowed archive, then in such
a container set `PARACORD_HOSTCTL_LIVE_RESTORE_{BINARY,ARCHIVE,PHRASE_FILE}`
and run the `live_restore` test binary. Without the variables it does nothing.

Scratch removed: `.live-env-s13b`, the copied binary, the source script, the
containers (`--rm`).

## 4. Files outside the S13 row (smallest, named)

- `crates/paracord-contracts/src/host.rs` (`HostStatus.instance_id`),
  `contracts/api-contracts.json`, `client/src/api/generated/{HostStatus.ts,validators.js}` (generated).
- `crates/paracord-api/src/routes/host_status.rs` (one line).
- `crates/paracord-hostctl/{Cargo.toml,src/lib.rs,src/host.rs,src/host_tests.rs}`, new `src/backup_file.rs`, `tests/live_restore.rs` (S7).
- `crates/paracord-server/{Cargo.toml,src/cli.rs,src/main.rs,src/restore.rs}`, new `src/escrow_key.rs`, `data/bip39-english.txt` (S4/S6 regions: one subcommand, one restore branch).
- `client/src-tauri/src/{host.rs,lib.rs}` (one command, one handler line).
- `client/src/lib/AppProviders.tsx` (one banner line), `components/user/{PrivacySection,UserSettings}.tsx` (the helper line).
- `client/playwright.config.ts`, `e2e/motion-gate.spec.ts` (comment), `e2e/fixtures/firstRunServer.ts` (`atRest` option).
- `scripts/install.{sh,ps1}`, `docs/{encryption,backup-recovery,deployment}.md`, `config/paracord.example.toml`, `docs/setup-spec.md` (§4.8 and §9.2, additive).
- `Cargo.lock` (dependency edges only, no new packages).

## 5. Deviations

1. Restore shows **row 3** ("Protecting its key with your recovery phrase")
   where the spec says rows 1, 2, 4, 5: the restored server needs its escrow
   again (§1 above), and a hidden step that can fail would be dishonest.
2. After a restore the owner **signs in with username and password**; the
   phrase is used only to unlock the backup. A phrase sign-in would force a
   new password (§3.8) or a keystore install from the key backup without the
   password (an S3 change). "Forgot your password?" there goes to `/recover`.
3. The restore preview shows the unnamed server ("Your server"): the name and
   color come with the backup and aren't known before the restore.
4. Claim-mode escrow failure is a warn on row 2, not a failed row 3 (the
   account already exists; Try again would re-claim).
5. A restored desktop host gets a **new TLS certificate** (new computer, new
   identity; friends' apps ask them to check it).

## 6. Open

- If the owner later used "Start over" (a new identity), an older backup's
  escrow still names the old key: the old phrase restores the data, and the
  re-escrow is then sealed under the old phrase while the server records the
  new owner key. Rare; worth a check against `users.public_key` in the escrow
  endpoint (S4/S6).
- `escrow-key` echoes the phrase as typed (no new tty dependency); the doc says so.
- The banner's app background in the S13 scene is not a populated app (no
  gateway); the strip is verified, the app behind it is the scene's.
- `install.ps1` grammar parse not run here (no PowerShell image); the change
  is one `if/else` with `''` escaping. CI `install-smoke-windows` runs it.
- `CLAUDE.md` `host:stage` note (S14 §6) still not in the main checkout.
