# S0 checkpoint: contracts, schema, config, route stubs

Package S0 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §8.1 and §9. Branch `feat/setup`.

Everything below is what wave B builds on. Stubs answer 501
`{ "code": "not_built" }` (HTTP) or `Err("not built")` (Tauri) and are
greppable with `rg not_built`.

## 1. Contracts (`crates/paracord-contracts`)

New modules `credential.rs` and `host.rs`; additions to `invite.rs` and
`user.rs`. All exported to `contracts/api-contracts.json` and generated into
`client/src/api/generated/` (55 types).

| Rust type | Exported schema | Notes |
|---|---|---|
| `credential::KdfParams` | (inside others) | `alg, log_n: u8, r: u32, p: u32`; helpers `default_scrypt()`, `within_policy()` (2^17..2^20, r ≥ 8, p ≥ 1), `to_db_text()` / `from_db_text()` (`"scrypt:17:8:1"`) |
| `NewCredential`, `IdentityProof`, `NewIdentity` | (inside others) | as §9.2 |
| `CredentialRegister` | `CredentialRegister` | as §9.2 |
| `CredentialParams` | `CredentialParams` | **numeric** `version` on the wire: `{version:1}` or `{version:2,kdf,salt,epoch}` (custom serde + a `oneOf` schema; see §5 deviation 1) |
| `CredentialParamsRequest { identifier }` | yes | `POST /auth/credential/params` |
| `CredentialLoginRequest { identifier, auth_key }` | yes | |
| `CredentialUpgradeRequest { current_password, credential, identity }` | yes | |
| `ChangeCredentialRequest { current_auth_key, credential, wrapped_key, mfa_code? }` | yes | `PUT /users/@me/credential` |
| `ResetCredentialRequest { credential, wrapped_key, proof, mfa_code? }` | yes | |
| `CredentialEmailResetRequest { token, credential, identity }` | yes | v2 `/auth/reset-password` ("Start over") |
| `CredentialEpochResponse { epoch }` | yes | upgrade / change / reset |
| `KeyBackup` | yes | as §9.2 |
| `NewOwnerClaim` + `CredentialClaimRequest { token, #[flatten] owner }` | both | claim minus `password`, plus `credential`, `identity`, `initial_space_hue: i16` (0-359, required), `initial_space_template: InitialServerTemplate` (`"friends"`). `host_claim` takes `NewOwnerClaim` (Rust adds the token) |
| `credential::RegistrationMode` | (inside others) | `open` / `invite_only`; `From` both ways with `paracord_core::registration::RegistrationMode` |
| `PasswordRequirements` | yes | §3.4 shape; `enforced_by: client|server`, absent on older servers |
| `host::ReachabilityState`, `Reachability` | (inside others) | snake_case states |
| `host::KeySource` | (inside others) | **kebab-case**: `keychain`, `systemd-creds`, `file`, `env` — same spelling in the config file and on the wire; `as_str()` / `parse()` |
| `host::Protection` | (inside others) | `login`, `tpm`, `machine`, `same_disk`; `as_str()` |
| `StorageStatus`, `BackupStatus`, `TlsStatus`, `HostStatus` | `HostStatus` | as §9.2 |
| `InstanceStatusUpdate { reachability, storage, backups }` | yes | gateway `INSTANCE_STATUS_UPDATE` payload |
| `StorageKeyEscrowRequest { wrapping_key }` | yes | host + admin escrow |
| `UpdateBackupsRequest { enabled }` | yes | `PATCH /admin/backups` |
| `BackupNowResponse { name }` | yes | |
| `StorageKeyEscrow { version, instance_id, owner_public_key, iv, ciphertext }` | not exported | the escrow file / manifest JSON (§4.7), for S4/S6 |
| `HostPreflight { ok, port?, reason?, detail?, existing_url? }` + `HostPreflightReason` | `HostPreflight` | Tauri `host_preflight` |
| `HostProgress { row, step, state, detail?, code? }` + `HostSetupStep`, `HostProgressState` | `HostProgress` | Tauri `host://progress` |
| `invite::InviteGuildPreview` | — | `+ hue: Option<i16>`, `+ online_count: u32` (both absent on older servers) |
| `invite::InviteFace`, `InviteInstance` | (inside `InvitePreview`) | as §6.1 |
| `invite::InvitePreview` | — | `+ faces`, `+ expires_at`, `+ instance` (absent on older servers) |
| `user::UpdateSettingsRequest` | — | `+ link_previews: Option<bool>` (§9.1). `UserSettingsResponse` is unchanged: S12 adds the read side with its handler |

Encodings fixed in the module docs: b64url = RFC 4648 §5 **without padding**;
hex = lowercase. Schemas carry no KDF floor and no byte-length patterns on
purpose (the client must refuse weak parameters with the spec's own words, not
a contract error; the server checks lengths).

`client/scripts/generate-api-contracts.mjs` now registers the numeric formats
`uint8`, `uint16`, `int16`, `int64`, `uint64` with Ajv (annotations; the
schemas carry explicit ranges). `client/src/api/contractValidators.ts` exports
the new response validators (`isCredentialParams`, `isCredentialEpochResponse`,
`isKeyBackup`, `isPasswordRequirements`, `isHostStatus`,
`isInstanceStatusUpdate`, `isBackupNowResponse`, `isHostPreflight`,
`isHostProgress`).

## 2. Schema (`crates/paracord-db`)

Migration `20261013000001_first_run_setup.sql` in `migrations/` and
`migrations_pg/` (PG: `credential_epoch BIGINT`, native booleans; timestamps
TEXT on both). Columns `users.credential_version` (0/1/2, CHECK),
`credential_salt`, `credential_kdf`, `credential_epoch`; table
`account_key_backups`; `user_settings.link_previews BOOLEAN NOT NULL DEFAULT TRUE`.

New modules (all take any `sqlx::Executor`, so they work on the pool or inside
`&mut *tx`):

- `credentials.rs`: `VERSION_KEY_ONLY/LEGACY/ONE_PASSWORD`, `CredentialRow`,
  `get(executor, user_id)`,
  `set_first_one_password(executor, user_id, from_version, hash, salt, kdf, now) -> bool`
  (`WHERE credential_version = from_version`, sets version 2, epoch 1; errors
  for `from_version >= 2`),
  `replace_one_password(executor, user_id, expected_epoch, hash, salt, kdf, now) -> Option<new_epoch>`
  (`WHERE credential_version = 2 AND credential_epoch = expected_epoch`).
- `key_backups.rs`: `KeyBackupRow`, `get`, `put` (upsert; keeps
  `recovery_confirmed` only when the public key is unchanged), 
  `set_recovery_confirmed`, `delete`. Booleans bound as `bool`, read through
  `CAST(… AS INTEGER)` + `bool_from_any_row`; timestamps via
  `datetime_to_db_text`.

`users.rs` inserts now write `credential_version`: public-key accounts and the
deleted-user tombstone 0; `create_user` / `create_user_as_first_admin` write
1 for an Argon2 PHC hash and 0 otherwise (system users with `''`). S2's v2
sign-up writes 2 through `set_first_one_password(…, from_version = 1, …)` in
its transaction (or its own insert).

`migrate_export.rs` lists `account_key_backups` (its table-order test requires
every table).

## 3. Config (`crates/paracord-server/src/config.rs`)

| Key | New (`Default`, generated file) | Missing in existing file (serde) |
|---|---|---|
| `server.redirect_listener` | true | true |
| `network.auto_port_forward` | **true** (was false) | false |
| `network.reachability_retry_seconds` | 60 | 60 |
| `backup.auto_backup_enabled` | true | false |
| `backup.max_backups` | **14** (was 10) | 10 |
| `backup.auto_backup_interval_seconds` | 86400 | 86400 |
| `at_rest.enabled` | false (see deviation 3) | false |
| `at_rest.key_source` | `env` | `env` |
| `at_rest.key_file`, `keychain_account`, `protection` | unset | unset |
| `at_rest.keychain_service` | `"Paracord"` | `"Paracord"` |
| `link_previews.enabled` | true | true |
| `host.enabled` | false | false |
| `host.instance_id`, `control_token_file`, `escrow_file` | unset | unset |
| `auth.registration_mode` | `invite_only` (unchanged) | `open` (unchanged) |

Template: every new key written and documented, unset optionals written as
commented examples (`optional_string_line`, TOML-escaped, so Windows paths
round-trip — S6's profile can build a `Config` and call the template). The
at-rest "Disabled by default" comment is replaced; the backup and router
comments now say what new vs. missing-key files mean. Env overrides:
`PARACORD_AT_REST_KEY_SOURCE` (unknown value stops the server, like
`PARACORD_REGISTRATION_MODE`), `PARACORD_AT_REST_KEY_FILE`,
`PARACORD_LINK_PREVIEWS_ENABLED`, `PARACORD_REDIRECT_LISTENER`,
`PARACORD_REACHABILITY_RETRY_SECONDS`. Nothing reads `redirect_listener`,
`reachability_retry_seconds` or the key sources yet (S6, S5, S4).

`paracord_core::AppConfig` gains `link_previews_enabled`, `max_backups` and
`host: HostRuntimeConfig { enabled, instance_id, control_token_file, escrow_file }`,
filled in `main.rs` (one block next to `started_at`), so S6 and S12 read them
from `AppState` without each editing the six `AppConfig` literals. CLI
additions of §9.4 (`init --profile …`, `--log-file`, `encrypt-storage`,
`restore-backup --escrow-key-stdin`) are S4/S6's (they own `cli.rs`).

## 4. Routes and commands

`crates/paracord-api/src/lib.rs` registers every new §9.1 route:

| Route | Stub |
|---|---|
| `POST /auth/credential/{params,register,login,upgrade}`, `PUT /users/@me/credential`, `POST /users/@me/credential/reset`, `GET /users/@me/key-backup`, `POST /users/@me/key-backup/recovery-confirmed`, `POST /setup/credential-claim` | `routes/credential.rs` (S2) |
| `GET /host/status`, `POST /host/reachability/retry`, `POST /host/backup-now`, `POST /host/storage-key/escrow` | `routes/host.rs` (S6) |
| `GET /admin/host-status`, `POST /admin/reachability/retry`, `POST /admin/storage-key/escrow`, `PATCH /admin/backups` (chained onto the existing `GET /admin/backups`) | `routes/host_status.rs` (S6) |

The stubs take no extractors and no auth: the implementing package adds the
auth (session, admin, owner, loopback + host token) with the handler. The
changed existing routes (`/auth/reset-password`, `/auth/options`,
`/setup/password-requirements`, `/invites/{code}`, `POST /guilds/{id}/invites`,
`PATCH /users/@me/settings`) are not stubbed; their packages change them.
`routes/docs.rs` (OpenAPI) does not list the new routes yet; whoever builds a
route adds it there.

`GET /invites/{code}` had to fill the new required Rust fields to compile
(`routes/invites.rs`, `get_invite` only): `hue` from the server, `online_count`
from the member index × online users, `expires_at` from `created_at + max_age`,
`instance` from the setup row / runtime settings with **`credential_version: 1`
until S2 lands** (it is true until then), and **`faces: []` for S9** (comment
in the handler).

Tauri (`client/src-tauri`): `src/host.rs` (`host_preflight`,
`host_setup_start`, `host_claim`, `host_write_escrow`, `host_status`,
`host_retry_reachability`, `host_backup_now`, `host_start`, `host_stop`,
`host_set_autostart`, `host_remove`, `host_logs_tail`, `host_restore`) and
`src/trust_cmds.rs` (`trust_server`, `accept_changed_identity`), typed with the
contract types, registered in `generate_handler!` (two `mod` lines and one
block at the end of the list). JS arguments are Tauri's default camelCase
(`{ wrappingKey }`, `{ deleteData }`, `{ archivePath, wrappingKey }`,
`{ presentedFp }`). `probe_server`'s new fields and `take_pending_deep_links`
are not stubbed: S10 and S11 own those in `lib.rs`.

Client: `ServerFeature` gains `oneCredential` and `hostStatus`;
`olderServerReason(feature, serverName?)` names the server for the §3.12 copy
("{server} runs an older version of Paracord. Ask the person who runs it to
update, then try again.").

## 5. Differences from the spec (and why)

1. **`CredentialParams` wire version is a number.** The §9.2 Rust sketch uses
   `#[serde(tag = "version")]` with renames `"1"`/`"2"`, which serializes the
   tag as a *string*; §9.1, §3.3 and `InviteInstance.credential_version` all
   say numeric. Implemented numeric (custom serde via a wire struct and a
   hand-written `oneOf` schema with `const: 1` / `const: 2`); TS gets a
   discriminated union. A string `"2"` is rejected.
2. **Key-only backfill.** The spec's `UPDATE … WHERE password_hash IS NULL`
   matches nothing: `password_hash` is `NOT NULL`, and key-only accounts store
   `''` (public-key sign-up, feeds/sports users), `'!federated!'` or
   `'!deleted!'`. The migration uses
   `WHERE password_hash IS NULL OR password_hash NOT LIKE '$argon2%'` (every
   real password in this codebase is an Argon2 PHC string), and new inserts
   write the version (§2 above).
3. **`at_rest.enabled` for new configs stays false in `Default`.** §8.1 says
   new = true, but §4.3 says `enabled = true` is written only after the key is
   generated, stored and read back. That generation is S4's (first run) and
   S6's (`init --profile desktop-host`); writing true before it exists would
   make every fresh server (and every wave-B `live-env` run) exit. S4 flips the
   generated value in its generation step. `key_source` defaults to `env`
   (the existing-file rule); S4 writes `keychain`/`file` at generation.
4. **`KeySource` is kebab-case** (`systemd-creds`) on the wire too, so config
   and wire share one spelling (§4.2 uses `systemd-creds` in config; §9.2 says
   snake_case only for `ReachabilityState`).
5. **Template comment fix** applied to `[at_rest]` ("Disabled by default"),
   not `[retention]` (retention really is disabled by default).
6. Extra contract types beyond §9.2 (request/response bodies of §9.1,
   `PasswordRequirements`, preflight/progress, escrow file, status update) so
   every §9 route and command has a typed shape.

## 6. Files outside the S0 row (smallest additive changes)

- `Cargo.lock`; `paracord-contracts` dependency line in
  `crates/paracord-core/Cargo.toml`, `crates/paracord-server/Cargo.toml`,
  `client/src-tauri/Cargo.toml` (S4/S5/S6/S7/S10 can use contract types
  directly).
- `crates/paracord-core/src/{lib.rs (AppConfig fields), registration.rs (From impls)}`,
  `crates/paracord-server/src/main.rs` (AppConfig block only).
- `crates/paracord-api/src/routes/mod.rs` (three `mod` lines),
  `routes/invites.rs` (`get_invite` compile fill, above).
- `crates/paracord-db/src/{users.rs (insert columns), migrate_export.rs (table list), messages.rs (test helper)}`.
- Tests that build users on a *pre-migration* schema now insert with raw SQL,
  the existing pattern for `spaces.hue`: `paracord-db/src/messages.rs` tests,
  `paracord-api/tests/{message_recovery,prekey_publication,index_hue_joined_at}.rs`.
  `paracord-api/tests/common/mod.rs` and three `paracord-ws/tests/*` gained the
  new `AppConfig` fields. `paracord-server` config tests asserting
  `auto_port_forward = false` for new configs were rewritten for the new
  default.
- `client/scripts/generate-api-contracts.mjs` (formats),
  `client/src/api/contractValidators.ts` (exports).
- `client/dist/` was built once (`npm run build`) so the workspace and the
  desktop crate compile (`RustEmbed` / `generate_context!`); it is gitignored.

## 7. Commands and results

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | ok |
| `cargo clippy --workspace -- -D warnings` | ok |
| `cargo clippy -p paracord-{contracts,db,api,server,core,ws} --all-targets -- -D warnings` | ok |
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` | ok |
| `cargo test -p paracord-contracts` | 13 passed |
| `cargo test -p paracord-db --test first_run_setup` on PostgreSQL 16 (`docker run … -p 55432:5432 postgres:16`, `PARACORD_TEST_POSTGRES_URL=postgres://postgres:pc@127.0.0.1:55432/postgres`) | 7 passed |
| `cargo test -p paracord-db -p paracord-core -p paracord-server -p paracord-ws -p paracord-contracts` (SQLite) | 685 passed, 0 failed (16 binaries) |
| `cargo test -p paracord-api` subset (SQLite): `--lib`, `auth_key_credential_hardening`, `auth_session_hardening`, `contract_wire_shapes`, `first_run_route_stubs`, `index_hue_joined_at`, `instance_setup`, `message_recovery`, `prekey_publication`, `registration_invite_only`, `srv_api6_account_bot_authz`, `security_route_authz_regressions`, `rate_limit_regressions` | 242 passed, 0 failed |
| same on PostgreSQL: `contract_wire_shapes`, `first_run_route_stubs`, `index_hue_joined_at`, `postgres_route_smoke`, `prekey_publication` | 29 passed |
| `cargo test -p paracord-desktop host::` | 1 passed |
| `npm run contracts:check` | 55 verified |
| `npm run typecheck` | ok |
| `npm run test:unit` | 4669 passed, 1 failed: `CallSheet.test.tsx › a short drag springs back` (timing flake under full-suite load; passes alone, 6/6; untouched by S0) |
| `npm run lint` | 0 errors (232 warnings, none in S0 files) |
| `npm run test:tokens`, `npm run test:motion-lint` | fail on the base commit already (CordMark literal colors; two stale motion allowances from `a1853e93`'s loaders) — not S0 files |

The populated-database check: `first_run_setup.rs` builds a database at the
schema just before the migration (sqlx migrator minus `20261013000001`), fills
it with a legacy Argon2 account, a public-key account with a key, a federated
account, the tombstone and a settings row, then applies the real migrator, on
both engines. There is no populated fixture database in the repo and the
owner's databases are off limits, so the fixture is built in the test.

**Not run: the full `paracord-api` suite.** `/home` ran out of space
(100 %, the shared `Paracord-glass/target` is ~400 GB; every api test binary is
~1 GB) and the linker then died with SIGBUS on every attempt. I deleted
`target/debug/incremental` entries not touched in the last 10 minutes (build
cache only; ~100 GB freed, refilled by concurrent builds) and ran the subset
above with `CARGO_INCREMENTAL=0 -j 2`. M1 must run the whole suite once disk
allows.

## 8. Left for later packages

- S2: replace `routes/credential.rs` stubs (and their rows in
  `paracord-api/tests/first_run_route_stubs.rs`); set `credential_version: 2`
  in `get_invite` and in `auth/options`; `PasswordRequirements` with
  `enforced_by`.
- S4: key-source resolution, generation flipping `at_rest.enabled`, escrow.
- S5: reachability state behind `Reachability`; `INSTANCE_STATUS_UPDATE`.
- S6: `routes/host.rs` and `routes/host_status.rs`, auth guards, reading
  `AppConfig.host`, `redirect_listener`.
- S7: `client/src-tauri/src/host.rs`.
- S9: `faces` and the rest of `get_invite`; invite defaults 604800/25.
- S10: `client/src-tauri/src/trust_cmds.rs`; `probe_server` fields.
- S11: `take_pending_deep_links` (own `generate_handler!` line).
- S12: `link_previews` read/write and `UserSettingsResponse.link_previews`;
  gate on `AppConfig.link_previews_enabled`.
- Everyone who builds a route: add it to `routes/docs.rs`.
