# S6 checkpoint: server host mode

Package S6 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §2.1, §2.5, §2.7, §2.8 (logs), §8.5 and the
`/host/*` rows of §9.1 (plus the `/admin` rows that share their handlers).
Branch `feat/setup`.

## 1. What exists

| Piece | Where |
|---|---|
| `paracord-host` binary | `crates/paracord-server/src/bin/paracord-host.rs` (`[[bin]]` in `Cargo.toml`, `test = false`) |
| desktop-host profile, control token | `crates/paracord-server/src/host_mode.rs` |
| log file, rotation, redaction | `crates/paracord-server/src/logging.rs` |
| `--log-file`, `init --profile/--root/--port` | `crates/paracord-server/src/cli.rs` |
| redirect-listener switch, token at start, TLS identity, scheduled backup | `crates/paracord-server/src/main.rs` |
| `/host/*` (guard + four handlers) | `crates/paracord-api/src/routes/host.rs` |
| `/admin/host-status`, `/admin/reachability/retry`, `/admin/storage-key/escrow`, `PATCH /admin/backups`; status collector, backup runner, escrow pre-checks, seams | `crates/paracord-api/src/routes/host_status.rs` |
| OpenAPI | `routes/docs.rs` (eight contracted operations; `/host/*` is not bearer-authenticated) |

### One program, two binaries

`src/bin/paracord-host.rs` is `#![cfg_attr(windows, windows_subsystem = "windows")]`
plus `include!("../main.rs")`. Including the file (not a `#[path] mod`, not a
library split) keeps every `crate::` path in the server's modules valid in both
binaries, so S4 and S5 can add modules without knowing the host binary exists;
`mod x;` inside the included file resolves to `src/x.rs`. Consequences:

- `main.rs` can no longer start with an inner attribute (`#![allow(...)]` is
  illegal inside `include!`). Its two clippy allows moved to
  `[lints.clippy]` in the server `Cargo.toml`.
- A `//!` doc comment at the top of `main.rs` would break the same way.
- `cargo check -p paracord-server` builds the server twice (two bins); the host
  bin has `test = false`, so tests run once.
- Build it with `cargo build --bin paracord-host`. `externalBin` staging is S8.

### The control channel (§2.5)

`[host] enabled` gates it. `HostControl` (an axum extractor, `routes/host.rs`)
accepts a request only if the TCP peer is loopback **and** no `X-Forwarded-For`,
`Forwarded` or `X-Real-IP` header is present **and** `Authorization: Host
<token>` equals the contents of `[host] control_token_file` (SHA-256 digests
compared byte by byte, constant time). Everything else is 401
`{code:"host_auth"}` without saying which condition failed. Other outcomes:
`[host]` disabled is 404 `host_disabled` (the routes do not exist on that
server); an unreadable token file is 503 `host_token_unavailable`; an empty file
admits nobody. `X-Forwarded-Proto` is deliberately not a proxy signal: the TLS
listener stamps it on every request.

The token file is read on every request. A restart replaces it (32 random
bytes, base64url, written temp-then-rename, 0600), which is what makes the old
token stop working. `host_mode::prepare_start` writes it before any listener
opens and refuses to start a host-mode server with no `instance_id` or
`control_token_file`. The token is registered with the log redactor.

### The profile (§2.7)

`paracord-host init --profile desktop-host --root R --port P` writes
`R/config/paracord.toml` (0600, `create_new`) with every value of the §2.7
table, absolute paths with forward slashes (a backslash would be an escape in
the template's quoted strings), directories 0700, and prints root, config path,
port and instance id. Order matters: the storage key is provisioned **first**,
and nothing is written if that fails, so a config that says `enabled = true`
never exists without a key. A second run on a root with a config is refused
("already initialized"). `-c` is ignored with a profile. `--root`/`--port`
without `--profile` is an error.

`PARACORD_AT_REST_KEY_SOURCE` is honored by `init` (the plan's live check needs
`env`); an invalid value is an error, not a fallback.

### Logs (§2.8)

`--log-file` is global (`paracord-host --log-file F init ...` works too).
Stdout keeps the compact format; the file gets the same lines through the
redactor. Rotation: at the first write on a new local day the live file is
renamed `<file>.<YYYY-MM-DD>` and a new one opened; seven rotated files are
kept; a stale live file from an earlier day is rotated when the process
starts. (The spec's layout sketch says `server.log.1 … .7`; dated suffixes were
chosen because the app and S7 only need "the live file" and "tail 200 lines",
and dates survive a skipped day. S7 can read `logs/server.log`.) Files are
0600. Redaction: values after `token`, `password`, `secret`, `claim`, `*key`
(`=`/`:` forms, JSON), the word after `Authorization:`, any literal registered
at runtime (the control token), and any bare 40+ character `[A-Za-z0-9_-]` run.
Windows: the GUI-subsystem binary has no stdout; std ignores the invalid handle.

### Redirect listener (§9.4)

`[server] redirect_listener = false` with TLS on means **no plain-HTTP
listener is bound at all**. That is not just policy: the profile serves HTTPS on
`bind_address`'s own port, which a plain listener would hold. With TLS off the
plain listener is the only listener and is always bound. In the TLS branch the
redirect server future is replaced by the shutdown future alone when absent, so
the shutdown work (port-map release, drain) still runs.

### Backups (§8.5)

`PATCH /admin/backups {enabled}` writes `server_settings.auto_backup_enabled`
(`"true"`/`"false"`), and `host_status::auto_backup_enabled` (DB value, else
`[backup] auto_backup_enabled`) is read **each tick** by `spawn_auto_backup`,
which now always runs its loop. A malformed saved value logs a warning and uses
the config. `host_status::run_backup` is the one place that creates an archive,
prunes to `max_backups` (a configured 0 keeps one: it never deletes the backup
it just made) and records `backup_last_at` / `backup_last_error` in
`server_settings` for `BackupStatus`. It is used by `POST /host/backup-now`
(media included: it is the backup before an update) and the scheduler.

### Status

`HostStatus` is built by `host_status::collect` for both `/host/status` and
`/admin/host-status`: version, `started_at`, `setup_required` (real),
`backups` (real), `tls` (real: SHA-256 of the first certificate in
`[tls] cert_path`, recomputed per request so a renewal shows; the server calls
`set_tls_identity(cert_path, self_signed)` once; **with TLS off the fingerprint
is the empty string**, the contract has no "off" value), `storage` and
`reachability` through the seams below.

## 2. Seams for S4 and S5

All in `routes/host_status.rs`, module `seams` (greppable: `SEAM(`). Replace the
body, keep the signature.

| Seam | Today | Owner |
|---|---|---|
| `seams::storage(state, escrowed)` | `enabled`/`files_encrypted` = a file cryptor is loaded; `sqlite_encrypted: false`, `key_source`/`protection: None`; `escrowed` is real (escrow file exists) | S4 |
| `seams::reachability(state)` | `{state: off, port: bind port}` and nothing else claimed | S5 |
| `seams::request_reachability_retry(state)` | 501 `not_built` (a retry that did nothing would be a silent no-op) | S5 |
| `seams::write_escrow(state, &[u8;32], path)` | 501 `not_built` | S4 |
| `host_mode::provision_storage_key(config)` | only `key_source = env` (proves the key is present and valid); every other source fails with "not built yet" | S4 |

The escrow routes already do everything around the write: owner check on the
admin route (the user who claimed the instance, `instance_setup.claimed_by_user_id`;
an instance that was migrated or bootstrapped has no owner and is refused),
`wrapping_key` must be base64url of 32 bytes (400), one call per instance (409
when `[host] escrow_file` exists; headless installs without `[host]` use
`storage-key.escrow` next to the data directory). The wrapping key is never
stored.

**Not committed by me, on purpose:** while this package was being built, S4
edited the working-tree copy of `host_mode.rs` to call
`crate::at_rest_boot::provision_configured_source` in place of the seam
function, and S5's `paracord_core::reachability` hub is in the tree. My commit
contains the seam versions so that HEAD compiles on its own. S4's commit should
take `host_mode.rs` as it is in the working tree; S5 should replace
`seams::reachability` / `request_reachability_retry` by reading
`paracord_core::reachability::hub()`. `INSTANCE_STATUS_UPDATE` dispatch on
change (§5.5) is S5's; `PATCH /admin/backups` does not send it.

Rows in tests that assert the seam answers (`host_control.rs`,
`the_escrow_write_and_the_retry_say_so_until_their_packages_land`) are the ones
S4 and S5 replace. `rg not_built` finds all of it.

## 3. Tests

| File | What |
|---|---|
| `crates/paracord-api/tests/host_control.rs` (16) | guard: disabled server, no/wrong/empty token, session token is not a host token, non-loopback v4/v6/no peer, proxy headers, `X-Forwarded-Proto` allowed, token replaced by a "restart", empty/missing token file; status shape and `escrowed`; `backup-now` archive + remembered; backup toggle (admin only, effective value); pruning never to zero; escrow validation and 409; owner-only admin escrow; admin status |
| `crates/paracord-api/src/routes/{host,host_status}.rs` (4 unit) | constant-time compare, scheme parsing, fingerprint vector, port parsing |
| `crates/paracord-api/src/routes/docs.rs` | existing OpenAPI tests cover the eight new contracted operations |
| `crates/paracord-server/src/logging.rs` (6 unit) | redaction table, ordinary lines untouched, registered secrets, 12-day rotation keeps 7 + live, stale file rotated on open, a claim link never reaches the file |
| `crates/paracord-server/src/host_mode.rs` (6 unit) | profile equals the §2.7 table, Windows paths, round trip of the written file, v4 UUID, token replaced/0600, host mode needs a token file |
| `crates/paracord-server/tests/host_mode.rs` (5) + `tests/golden/desktop-host.toml` | the **real binary**: init against the golden subset, mode bits, re-init refused with the first config untouched, no config when the key cannot be stored, `--root` without profile; a started host: 401 without/with wrong token, 200 with the file's token, TLS fingerprint, HTTPS only (no plain HTTP on the port), log written and free of the token, key and claim token |

`first_run_route_stubs.rs` lost the eight host/admin rows;
`tests/common/mod.rs` gained `TestAppOptions.host` (default none).

## 4. Commands and results

| Gate | Result |
|---|---|
| `cargo fmt` on every file I own | clean (`cargo fmt --all -- --check` still reports other packages' files) |
| `cargo clippy -p paracord-api -p paracord-server --all-targets -- -D warnings` | api and all my files clean; stops on S5's `reachability.rs` `netsh_rule_covers_port` unused and `portmap.rs:760` `matches!` (not mine) |
| `cargo check -p paracord-api -p paracord-server --bins --tests` on a clean checkout of HEAD + my staged files | clean (with a stub for `auth::credential_upgraded`, which HEAD's `users.rs` references and no commit defines yet: S2) |
| `cargo test -p paracord-api --test host_control` | 16 passed |
| `cargo test -p paracord-api --test first_run_route_stubs`, `--lib docs` | passed |
| `cargo test -p paracord-server --bin paracord-server -- logging host_mode` | 12 passed |
| `cargo test -p paracord-server --test host_mode` | 5 passed |
| Live, port 18480, scratch root `.live-env-s6/host` (deleted), `PARACORD_AT_REST_KEY_SOURCE=env`, `PARACORD_AUTO_PORT_FORWARD=false` | init, start with `--log-file`; no token 401 `host_auth`; token 200 with a real `HostStatus` (fingerprint, `setup_required: true`, backups on/14); `backup-now` 200 and the archive on disk; retry 501 `not_built` (seam); plain HTTP on the port refused; log file written, 26 lines, token not present |

The router was never asked for anything (`PARACORD_AUTO_PORT_FORWARD=false`
everywhere); no service was installed.

## 5. Notes for other packages

- **S7**: `paracord-host init ...` prints four human lines (root, config, port,
  instance id); read `instance_id` and the rest from the config file instead
  if parsing is awkward. The binary logs to `--log-file` only when given: the
  service unit must pass `--log-file <root>/logs/server.log`. The token path is
  `<root>/config/host-control.token`; send `Authorization: Host <token>` from
  the loopback address, and never through a proxy.
- **S8**: the binary is `target/<profile>/paracord-host`; build with
  `cargo build --release --bin paracord-host`.
- **S4**: `config::write_new_config(path, &Config)` (new, `create_new` + 0600)
  is available for a generated config; `host_mode::desktop_host_config` builds
  the profile as a `Config` value.
- **Everyone**: do not put `#![...]` or `//!` at the top of `main.rs`.

## 6. Deviations from the spec

1. `paracord-host` includes `main.rs` instead of "the same `main`" in a
   separate file; see above for why and what it forbids.
2. Rotated log names are `<file>.<date>`, not `.1 … .7`.
3. `TlsStatus` has no "off": empty fingerprint, `self_signed: false`.
4. `retry` and the escrow write answer 501 until S5/S4 land rather than
   pretending to succeed.
5. `[lints.clippy]` in the server `Cargo.toml` replaces the `#![allow]` in
   `main.rs`.
