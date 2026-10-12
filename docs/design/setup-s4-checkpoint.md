# S4 checkpoint: stored-data encryption with an automatic key

Package S4 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §4. Branch `feat/setup`.

## 1. SQLCipher on every target

`libsqlite3-sys = { version = "0.30", features = ["bundled-sqlcipher-vendored-openssl"] }`
in `[workspace.dependencies]`, depended on by `paracord-db` (and so unified
into sqlx's and rusqlite's SQLite). Every binary now carries SQLCipher with a
statically built OpenSSL (`openssl-src` 300.6.1, OpenSSL 3.6.3); CommonCrypto
is not used on macOS, so there is one crypto provider everywhere. A SQLCipher
build opens a plaintext database normally when no key is set.

| Target | How it was proven |
|---|---|
| Linux x86_64 | built and tested here: `paracord-db --test sqlcipher_open` (keyed file is not plaintext on disk, opens only with its key, plaintext DB still opens without one), all server tests, a live instance |
| Windows `x86_64-pc-windows-gnu` (cross) | `cargo build --target x86_64-pc-windows-gnu --bin paracord-server --bin paracord-host` links; `sqlcipher_open` **run under Wine: 2/2 pass**; the Windows `paracord-server.exe` under Wine ran `init` (probe → Credential Manager, key stored and read back, config `key_source = "keychain"`), then started: "Stored data: encrypted (database: yes, files: yes, key: keychain, protection: login)" and a SQLCipher `paracord.db` (it then stopped at the QUIC UDP bind, a Wine socket limitation unrelated to storage) |
| Windows MSVC, macOS arm64, macOS x86_64 | cannot run here. New CI job `storage-encryption-targets` (`.github/workflows/ci.yml`): `cargo test -p paracord-db --test sqlcipher_open --target …` on `macos-14` (aarch64 native; x86_64 cross-built on arm64, as the release does, and run under Rosetta) and `windows-latest`, plus the real-keychain test on macOS arm64 and Windows. actionlint clean |

Reasoning for the targets I could not run: `openssl-src` builds on macOS with
the system clang and perl (both on the runner) and selects `darwin64-x86_64-cc`
/ `darwin64-arm64-cc` from the target, with cc-rs passing `-arch`; the release
already builds `paracord-server` for both macOS triples on `macos-14`. On MSVC
`openssl-src` needs perl (Strawberry Perl is on GitHub's Windows image) and
falls back to `no-asm` when nasm is absent. If the Windows job picks up Git's
msys perl instead, set `OPENSSL_SRC_PERL=C:\Strawberry\perl\bin\perl.exe` on
that job — the new CI job will show it before a release does. Build cost: one
OpenSSL compile per target (~1 min here, cached by rust-cache).

## 2. What was built

| Piece | Where |
|---|---|
| Key sources `keychain` / `systemd-creds` / `file` / `env`, `resolve_key`, exit **78** with one line `at-rest key: <reason naming the source>` | `crates/paracord-server/src/at_rest_boot.rs` |
| Keychain via `keyring` 3 with the desktop's platform features (Secret Service over zbus/async-io, `apple-native`, `windows-native`; never the mock store). Every write is read back through a fresh entry; the probe writes, reads and deletes `Paracord / probe:<uuid>` | `at_rest_boot::keychain` |
| `systemd-creds` reader (`$CREDENTIALS_DIRECTORY/paracord-at-rest-key`) and writer (`systemd-creds encrypt --with-key=host+tpm2` when `has-tpm2`, else `host`; read back with `decrypt`) | `at_rest_boot` |
| `file` source: created `0600` (`create_new`, never replaces), Windows `icacls` owner-only; reads refuse group/other bits (`chmod 600` in the message) and another owner | `at_rest_boot` |
| Generation (§4.3): a config this start generated (plain first run and `init`) gets a key: keychain when the probe works, else `<config dir>/at-rest.key` (`same_disk`); stored, read back, **then** `[at_rest] enabled/encrypt_sqlite/encrypt_files = true`, `key_source`, `key_file`/`keychain_account`, `protection`, and `[host] instance_id` (uuid) + `escrow_file` written into the file as text (comments kept; the template's commented example line becomes the assignment). On failure the generated config is removed so the next start does not run unencrypted | `at_rest_boot::provision_new_config`, called in `main.rs` after `Config::load` and in `run_init` |
| Boot (§4.4): `build_at_rest_profile` moved out of `main.rs` (TOTP cryptor unchanged, so MFA works on every at-rest server); `boot` checks the key against the SQLite file on one connection before any pool (a pool only reports a timeout): wrong key, plaintext DB with a key ("not encrypted yet … run encrypt-storage"), encrypted DB with no key → clear refusal | `at_rest_boot::boot` (L291 region) |
| Status (§4.5): `sqlite_encrypted` from `PRAGMA cipher_version` on the live pool **and** the file header not being `SQLite format 3\0`; published to `paracord_core::storage_key` and to `reachability::hub().set_storage(..)` (so `INSTANCE_STATUS_UPDATE` carries it); `notify_changed()` after an escrow | `at_rest_boot::publish_status` (one line after migrations), `paracord_db::{sqlcipher_version, sqlite_main_file, sqlite_storage_encrypted, check_sqlite_key, sqlite_file_has_plaintext_header}` |
| Escrow (§4.7): `derive_escrow_key` (HKDF-SHA256, salt `paracord/host-storage-escrow/v1`, info instance id), `seal_escrow`/`open_escrow` (AES-256-GCM, AAD `paracord/host-storage-escrow/v1\|<instance_id>`); runtime `StorageKeyRuntime::write_escrow[_at]` write-once (temp file + hard link, 0600, 409 when present), `read_escrow_file`, `unwrap_escrow`; `BackupManifest.recovery.key_escrow` filled from the running server's escrow | `paracord-util/src/at_rest.rs`, `paracord-core/src/storage_key.rs` (new), `paracord-core/src/backup.rs` |
| S6 seams wired: `host_status::seams::storage` returns the runtime status; `seams::write_escrow` looks up the claiming owner's identity public key and calls `write_escrow_at` (409: no owner / no identity key / not encrypted / no instance id / already escrowed; 400 bad key). The 501 `not_built` path and `StatusError::NotBuilt` are gone | `crates/paracord-api/src/routes/host_status.rs` |
| `init --profile desktop-host` key: `at_rest_boot::provision_configured_source` (S6's seam in `host_mode.rs` now calls it) | `host_mode.rs` |
| `restore-backup --escrow-key-stdin`: reads b64url escrow key from stdin, unwraps the archive's `key_escrow`, stores the key in the config's source (refuses if the source already holds a *different* key), then restores. Activation scripts only demand the env key for the `env` source | `cli.rs`, `restore.rs`, `backup::read_archive_manifest` |
| `encrypt-storage --key-source keychain\|systemd-creds\|file\|env [--key-file]` (§4.8): refuses while the server's port answers and when at-rest is already on; backup → key stored + read back → `ATTACH … KEY` + `sqlcipher_export` (WAL folded in first, `user_version` copied) → fresh-connection `cipher_integrity_check`, `quick_check`, every table's row count compared → swap (plaintext aside, encrypted in, plaintext deleted) → attachments (`attachment:<id>`) and federation cache (`federation-cache:<origin>:<id>`) encrypted in place with temp + rename, each verified by decrypting → config updated last → journal removed → prints the escrow next step. Journal `data/.encrypt-storage.journal` (never holds the key) makes reruns resume; debug builds honor `PARACORD_ENCRYPT_STORAGE_STOP_AFTER=key\|database\|files:<n>` for tests | `crates/paracord-server/src/encrypt_storage.rs` (new) |
| MFA refusal text (§4.4) | `routes/auth.rs` (one string) |
| `live-env --at-rest` (env source, key kept in `<data>/at-rest.key.hex` for `--keep`); without it `PARACORD_AT_REST_ENABLED=false`; `PARACORD_LIVE_ENV_BIN` to point at another build | `scripts/live-env.mjs` |

### The new-config default (S0 deviation 3, resolved)

New configs now come out with `enabled = true` through generation, exactly as
§4.2/§4.3 say; `Config::default()` keeps `false` (nothing claims a key before
one is stored). Generation is skipped, and says so in the log, when:
the operator set `PARACORD_AT_REST_ENABLED` or `PARACORD_AT_REST_KEY_SOURCE`
(their explicit choice, e.g. Docker and the test harnesses); the engine is
PostgreSQL (no automatic files-only mode; `encrypt-storage` converts it); or a
SQLite database already exists (a new key would lock it out — use
`encrypt-storage`).

## 3. Deviations and decisions

1. **Harnesses opt out explicitly.** A plain first run now reaches for the
   system keychain. So nothing in a test run writes to a developer's keychain,
   every harness that starts a server on a fresh config got one env line
   `PARACORD_AT_REST_ENABLED=false`: `client/e2e/{real-server-harness.mjs,
   messaging-server-harness.mjs, real-server.session-recovery.spec.ts}`,
   `client/scripts/release-real-ui-smoke.mjs`, 21 `scripts/release_*_smoke.py`.
   Left alone on purpose: `release_zero_config_first_run_smoke.py` (it proves
   the zero-config default; on CI's runners there is no Secret Service, so it
   gets the `file` source), `ci_install_smoke.sh` (S14's; `init` there now
   generates a file key on CI).
2. **Docker is not changed yet.** `docker-entrypoint.sh` relies on the first
   run; inside a container the probe fails, so a fresh container would now get
   a `file` key in `/data`. Spec §4.2 says Docker stays off unless the
   operator turns it on: S14 should add `ENV PARACORD_AT_REST_ENABLED=false`
   to the `Dockerfile` (one line; I did not touch the Dockerfile, no package
   owns it).
3. **Headless escrow needs an instance id.** Generation and `encrypt-storage`
   always write `[host] instance_id` and `escrow_file` (with `[host] enabled =
   false`), so every server that S4 encrypted can escrow. A server encrypted by
   hand with the `env` source and no instance id gets 409 "no instance id".
4. **`sqlite_encrypted` is cipher_version AND the file header**, because with
   SQLCipher in every build `cipher_version` alone is always non-empty.
5. **`encrypt-storage` keeps the pre-change backup** (unencrypted) and says so
   in its output; TOTP/webhook secrets stored plaintext before are not
   re-encrypted (they now sit inside the SQLCipher database, and the read path
   already handles both forms).
6. `config.rs`: one word, `generate_config_template` is `pub(crate)` (a test
   renders the real template). `host_mode.rs`: S6's seam body replaced by the
   call (as S6 asked). `host_control.rs` (S6's test): the 501 row replaced by
   "the escrow needs an owner" (409) and the owner test extended with a real
   escrow under the S1 vector identity that unwraps to the storage key, then
   409 on the second write.
7. Escrow vector for S1/S3: identity private key
   `d2cb3a96…959f8d9c` (vectors.json `wrap[0]`), instance id
   `7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a` → `escrow_key =
   03976eb9f4df480870ebee2d4d495ad22dcc239d87193d5fb9382ef36f2388cf`
   (node:crypto `hkdfSync`, pinned in `paracord-util` tests). The client
   derivation should add this to `vectors.json`.

## 4. Checks

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean for S4 files (remaining diffs are other packages' in-progress files: `events.rs`, `paracord-hostctl`, `src-tauri/src/host.rs`) |
| `cargo clippy -p paracord-{util,db,core,server,api} --all-targets -- -D warnings` | ok |
| `cargo test -p paracord-util` | at_rest 11 passed (incl. escrow vector) |
| `cargo test -p paracord-db -p paracord-core -p paracord-util` | all passed (334 core, 212 db lib, …) |
| `cargo test -p paracord-server` | 109 unit + `at_rest_boot` 4 + `at_rest_encrypt_storage` 2 + other 5, all pass |
| `cargo test -p paracord-api --test host_control` | 17 passed |
| Plan check `cargo test -p paracord-server at_rest` | covers: first run → file key 0600 + SQLCipher DB, env opt-out, never over an existing DB; exit 78 for missing key file, readable key file, plaintext DB with key, wrong key, env unset, keychain account unset, systemd-creds outside a unit; plaintext → encrypted migration with row counts and file reads (AAD-checked, exactly once), server boots on it; interrupted run (after key, after one file) resumes with the same key; escrow under the S1 vector key → backup manifest → key file deleted → wrong phrase refused → `restore-backup --escrow-key-stdin` puts the same key back and restores |
| Real Secret Service (isolated) | `archlinux` container, `dbus-run-session` + `gnome-keyring-daemon` (`--cap-add=IPC_LOCK`): `keychain_source_roundtrips_through_the_real_store` passes; plain `init` → `key_source = "keychain"`, `protection = "login"`, no key file, exactly one keychain entry (probe deleted); server healthy on it, DB header random; entry deleted → **exit 78** "the system keychain has no entry Paracord / host-storage-key:…"; no session bus → **exit 78** "the system keychain is locked or not running (Secret Service: no secret service provider or dbus session found)". The owner's keychain (ksecretd) was never touched |
| Windows cross + Wine | §1 |
| live (18460) `live-env --at-rest` (debug build, `PARACORD_TEST_ALLOW_LEGACY_SIGNUP=1` because S2 refuses legacy sign-up in release until S3 lands) + `live-drive` | **all PASS (25/25)** on an encrypted instance; DB header not plaintext |
| `encrypt-storage` on a copy of a populated plaintext `.live-env-s4` | plaintext `live-drive` run (25/25 PASS) + 3 uploaded attachments → copy → `encrypt-storage --key-source file`: 117 tables / 461 rows checked, 3 files encrypted, config updated; the copy boots ("Stored data: encrypted …"), signs in, and serves the attachment decrypted (200, original text) |

Scratch data (`.live-env-s4*`, Wine prefix, container) deleted.

## 5. For later packages

- **S14:** installers choose sources (`systemd-creds`/`file`/`keychain`) — use
  `encrypt-storage --key-source …` for upgrades and either `init` with
  `PARACORD_AT_REST_KEY_SOURCE` set (generation is then skipped; provision the
  key yourself) or ask for an `init --key-source` flag; Dockerfile line (§3.2);
  docs/encryption.md must mention SSD remanence and the unencrypted pre-change
  backup.
- **S6/S7:** desktop restore (`init` in restore mode) must not generate a key,
  because `restore-backup --escrow-key-stdin` refuses to replace a different
  key in the source.
- **S8:** keep the `storage-encryption-targets` job (or fold it into the
  release matrix); watch the Windows MSVC perl.
- **S3/S13:** admin warn line "Stored messages and files are not encrypted…"
  reads `storage.enabled == false`; the escrow call after the claim is
  `POST /admin/storage-key/escrow` (owner) or `host_write_escrow`.
