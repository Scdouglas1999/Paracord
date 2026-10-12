# S14 checkpoint: installers and docs

Package S14 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §4.2 (installer key sources), §5 (reachability
copy) and the doc changes listed with them. Branch `feat/setup`. Built on S4
(key sources, `encrypt-storage`, escrow, exit 78) and S5 (states, no third-party
lookups).

## 1. What changed

### Installers

| Piece | `install.sh` | `install.ps1` |
|---|---|---|
| Router question | default **yes** (Enter, no terminal, CI); `--home-network-only` / `PARACORD_ALLOW_INTERNET=0` say no | same (`-HomeNetworkOnly`) |
| Key source on a fresh install | root + systemd >= 250 + `systemd-creds`: **systemd-creds** (`config/at-rest-key.cred`, root:root 0600, TPM-sealed when the machine has one); other Linux: **file** (`config/at-rest.key`, 0600, the service user); macOS per user: **keychain**; macOS as a LaunchDaemon: **file** | **file** (`config\at-rest.key`), SYSTEM granted read on a whole-computer install and checked |
| How the key is made | `paracord-server init --key-source <s> [--key-file <p>]` (new flag, see §2); the credential step runs as root, everything else as the service user; ownership settled afterwards | the same flag |
| systemd unit | `LoadCredentialEncrypted=paracord-at-rest-key:<file>` written from the config on every install and upgrade; a missing credential stops the install | n/a (scheduled task, file key) |
| Upgrade of an unencrypted install | asks on a terminal ("Encrypt now? [Y/n]"), `--encrypt-storage` does it unasked, `--no-encrypt-storage` / `PARACORD_ENCRYPT_STORAGE=0` never offers; unattended it only prints the one command. Stops the service (systemd system/user, launchd), runs `encrypt-storage --key-source <s>`, settles ownership, restarts through the normal service step. A failure stops the installer with "nothing was lost: a backup was taken first ... run this installer again; it resumes" | `-EncryptStorage` / `-NoEncryptStorage` / `PARACORD_ENCRYPT_STORAGE`; stops the running server of this install |
| Older release (no `--key-source` in `init --help`) | installs unencrypted with a warning that says so; never silent | same |
| PostgreSQL install | prints the `encrypt-storage` pointer, does not convert | same |
| Escrow reminder | three lines in the closing text on a fresh install or a conversion: the key exists only on this computer, save a recovery copy under the recovery phrase, link to `docs/encryption.md#recovering-the-storage-key`; Details gains `Storage:` (where the key is, plus the spec §4.6 protection sentence). When an unencrypted install is left alone the closing text names `--encrypt-storage` | same |

The installers do not call the escrow endpoint: it needs the owner's identity
key, which only a signed-in client has.

### Docker

- `Dockerfile`: `ENV PARACORD_AT_REST_ENABLED=false` with a comment (S4 note 3.2).
- `docker-entrypoint.sh`: a comment only.
- `docs/docker-setup.md`: the env table row, and a new section "Encrypting stored
  data" (why it is off, supplying `PARACORD_AT_REST_KEY` from outside `/data`,
  converting an existing volume with `encrypt-storage --key-source env`).
  The `PARACORD_AUTO_PORT_FORWARD` row now says `true` in a new config and
  that a container on Docker's default network usually cannot reach the router.

### Docs

| File | Change |
|---|---|
| `docs/encryption.md` | "One password" (derivation, what the server learns, offline guessing against the auth key hash and the wrapped identity, the fake `version: 1` residual risk, change/recover/Start over, desktop remembered unlock) replaces the two-password keystore text; "Stored data on the server" (key sources and what the admin screen says, what it does not do including SSD remanence and the unencrypted pre-change backup, "Encrypting an existing server", "Recovering the storage key"); the algorithms table and the channel-message paragraph follow |
| `docs/port-forwarding.md` | rewritten around the §5.4 states and copy; no third-party site anywhere (no ifconfig.me, no port-checker sites): the public address is read from the router's own status page, the proof is "A friend connected from outside"; two-routers / shared-address section; auto-forward default yes |
| `docs/getting-started.md` | the installer's new question and encryption, a "host from the desktop app" option, the `host:stage` developer note |
| `docs/deployment.md` | router default, a "Stored-data encryption" section with the per-installer key table and the upgrade offer, backup bullet |
| `docs/backup-recovery.md` | key sources in the retained material; "Restoring an encrypted server without its key" (app path and `restore-backup --escrow-key-stdin`) |
| `README.md` | `host:stage` before `tauri build`, and the compile-only placeholder (coordinator request from S8) |

## 2. Outside the S14 file list (named, additive)

1. **`paracord-server init --key-source <s> [--key-file <p>]`**
   (`cli.rs`, `main.rs::run_init`, `at_rest_boot::provision_new_config_with`).
   S4 offered either "init with the env var set" or "ask for an init flag"; the
   env route skips generation and would have left the installer hand-editing
   `[at_rest]`/`[host]` text, so it asked for the flag. An explicit choice never
   degrades: it errors on an existing config (points at `encrypt-storage`), on
   `PARACORD_AT_REST_*` in the environment, on PostgreSQL and on an existing
   database. Test: `init_key_source_puts_the_key_where_the_installer_says`.
2. **S4 bug found by the container run**: for the `systemd-creds` source the
   key file path was not written to `[at_rest] key_file` (`apply_record`,
   `apply_record_to_text`), so the installer, `placement_from_config`
   (`restore-backup --escrow-key-stdin`, `provision_configured_source`) and
   `encrypt-storage` resume could not find the credential. Fixed in both;
   test `a_systemd_credential_records_where_its_file_is`.
3. `scripts/ci_install_smoke.{sh,ps1}` (the plan lists only `ci.yml`, but the
   `install-smoke*` jobs are those scripts) and `.github/workflows/ci.yml`
   (`install-smoke*` only; see §4).

## 3. Deviations and decisions

1. **Windows uses a file, not the Credential Manager, under SYSTEM** (spec §4.2
   says `keychain`, label `machine`). `init` run by the installing user would
   fill that user's vault, not SYSTEM's; running `init` as SYSTEM (a one-shot
   task) would leave the config ACL'd to SYSTEM only and unreadable by the
   installer that must edit it. The honest label is `same_disk` and the installer
   says so. A later change can move the key into SYSTEM's vault. The same
   decision applies to a macOS LaunchDaemon (a daemon cannot unlock a login
   keychain), which gets a file.
2. **The web/headless owner claim does not write the escrow yet.** Only the
   desktop host flow (`flows.ts`) calls it. The installer text and
   `docs/encryption.md` therefore say the call exists (`POST
   /api/v1/admin/storage-key/escrow`) and that until the first-owner page makes
   it, the owner should keep a copy of the key file. **Update both when S13/S9
   wires the claim page**, and then drop the "does not make it yet" sentence in
   `docs/encryption.md` ("Recovering the storage key").
3. The hand restore (`--escrow-key-stdin`) needs the escrow key as base64url;
   there is no CLI to derive it from the phrase, so `docs/backup-recovery.md`
   points owners at the app's "Restore from a backup instead".
4. The encryption offer on upgrade only asks on a terminal. Unattended runs
   print the command instead of converting, because a conversion deletes the old
   database and an unattended upgrade must not do that unasked.
5. The Dockerfile line makes `PARACORD_AT_REST_ENABLED=false` permanent in the
   image; operators override it with their own env, and `init`-style generation
   is skipped as S4 designed.
6. `config/paracord.example.toml` still says `auto_port_forward = false` (and
   "reads as false"); it is an example, not generated, and not S14's file. The
   generated config already defaults to true.
7. `CLAUDE.md` is gitignored and exists only in the main checkout, which the
   ground rules forbid touching. The coordinator's request to add the
   `host:stage` note there is **not done**; the text to add under "Build & Run
   Commands" is in §6.

## 4. Checks

| Check | Result |
|---|---|
| `shellcheck` install.sh, ci_install_smoke.sh, docker-entrypoint.sh; `bash -n` / `sh -n` | clean |
| PowerShell full-grammar parse of `install.ps1` and `ci_install_smoke.ps1` (`mcr.microsoft.com/powershell`) | ok; `install.ps1` is still pure ASCII |
| `actionlint` on `ci.yml` | clean |
| `scripts/ci_install_smoke.sh` on the host (non-root, root step skipped, stub binary) | 91 assertions pass |
| The same script in a throwaway `archlinux` container as a sudo user with a fake `systemctl` 255 and the real `systemd-creds` (root step **runs**: user, unit with `LoadCredentialEncrypted`, credential root:600) | 101 assertions pass |
| Real server binary in the container (a scratch script outside the repo): root install with systemd-creds -> credential decrypted into `$CREDENTIALS_DIRECTORY` -> server healthy, `Stored data: encrypted (... key: systemd-creds ...)`, database header not SQLite; plaintext install (init with `PARACORD_AT_REST_ENABLED=false`, server run to create the DB) -> unattended upgrade only hints and changes nothing -> `--encrypt-storage` converts, config records `key_source`/`key_file`, unit gains the credential line, server healthy on it; non-root user install -> 0600 key file, server healthy, DB encrypted | all pass |
| `cargo clippy -p paracord-server --all-targets -- -D warnings`, `cargo fmt` | clean |
| `cargo test -p paracord-server at_rest` (unit 9, `at_rest_boot` 4, `at_rest_encrypt_storage` 2) and the new `init_key_source...` test | pass |

Not run, and why: `install.ps1` itself (no Windows here; the Windows job
`install-smoke-windows` now asserts the key file, SYSTEM's access, the
encrypted database and the 5b conversion, and gets Strawberry Perl for the
OpenSSL build, which that job lacked after S4); the macOS keychain branch of
`install.sh` (no macOS); the interactive prompts of `install.ps1`; a TPM-sealed
credential (no TPM in the container: label came out `machine`).
Nothing was installed on this machine: every run was in a container or a temp
directory with `PARACORD_NO_SYSTEMD=1`.

## 5. For later packages

- **S13/S9:** have the first-owner claim page call the admin escrow (§3.2), then
  edit `docs/encryption.md` and `scripts/install.{sh,ps1}` reminder wording.
- **S8/S15:** `install-smoke-windows` is the only place `install.ps1`'s new
  paths run; watch its first CI result.
- The installers' Details block now has a `Storage:` line; live-drive-style
  scripts that parse the closing text should not depend on its length (the smoke
  allows 20 lines for a fresh install).

## 6. Text for `CLAUDE.md` (main checkout, not committed here)

Under "Build & Run Commands", after the Rust block:

```
`client/src-tauri` is a workspace member and bundles the `paracord-host`
sidecar, so every `--workspace` cargo command needs a staged file first:
cd client && npm run host:stage -- --placeholder   # compile-only
cd client && npm run host:stage -- --release       # before `npx tauri build`
Plain `cargo build --release --bin paracord-server` and `-p <crate>` do not.
```
