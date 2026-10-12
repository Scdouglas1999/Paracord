# M1 checkpoint: wave B merged and verified

Merge checkpoint M1 of [`setup-plan.md`](setup-plan.md). Worktree
`~/Documents/Paracord-setup-m1`, branch `setup-m1`, cut from `feat/setup` at
`a87e2f17` (S0–S12, S13a, S2's and S3's work; S13 was still uncommitted then).
The orchestrator merges `setup-m1` into `feat/setup`. S13's commits that landed
on `feat/setup` meanwhile (`699d60a1`..`c628a23c`) are **not** in this branch;
nothing here touches S13's files (below).

## 1. Gates

All on the branch head after the fixes in §2.

| Gate | Result |
|---|---|
| `rg not_built` | empty outside docs. The last stub file, `paracord-api/tests/first_run_route_stubs.rs`, had no rows left and is deleted. No Tauri `"not built"` stub remains |
| `cargo fmt --all -- --check` | ok (after formatting `paracord-core/src/events.rs`, the only diff) |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | ok |
| `cargo clippy --locked -p paracord-desktop --all-targets -- -D warnings` | ok |
| `cargo test --locked --workspace --no-fail-fast` (SQLite) | **2487 passed, 0 failed**, 6 ignored, 137 test binaries — includes the full `paracord-api` suite S0 and S4 could not run |
| `cargo test -p paracord-db -p paracord-api` on PostgreSQL 16 (`docker run … -p 55432:5432 postgres:16`, `PARACORD_TEST_POSTGRES_URL=postgres://postgres:pc@127.0.0.1:55432/postgres`) | first run 1080 passed, **2 failed** (S6's backup tests, §2.8); after the fix those binaries pass on PostgreSQL (`host_backups` 2, `host_control` 15, `backup_status_event` 1) |
| `Cargo.lock` | `--locked` builds and tests pass, so the committed lock matches the manifests; no stray lock hunks in `feat/setup`'s working tree |
| `npm run typecheck` | ok |
| `npm run test:unit` | 481 files, **4858 passed** |
| `npm run lint` | 0 errors (238 warnings, unchanged) |
| `test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast` | pass |
| `npm run contracts:check` | 55 verified |
| `node client/src/lib/credential/vectors.reference.mjs --check` | both copies match |

### Live (release build, `127.0.0.1:18600`, data `.live-env-m1`)

`npm run build`, `cargo build --release --bin paracord-server` (embedded bundle
`index-DksNU-lo.js` checked against `client/dist`), the binary copied out of the
shared target so no other worktree's build could replace it mid-run, then
`PARACORD_LIVE_ENV_BIN=… node scripts/live-env.mjs --port 18600 --data .live-env-m1`.

| Check | Result |
|---|---|
| `PARACORD_LIVE_PORT=18600 PARACORD_LIVE_DATA=.live-env-m1 node client/scripts/live-drive.mjs` | **28/28 PASS** (one password sign-in for three accounts, prekeys, reload unlock, friends, server + invite, channel live, DM decrypts and stored as ciphertext, group sender keys incl. stale-membership refusal and removal rotation, edit/reaction/delete, password change keeps DMs, second browser gets the identity from the backup, v1 → one password move, no unexpected errors). The release-build 410 of S2's era is gone: S3's live-drive seeds v1 through the database |
| `live-probe.mjs` (DM) | recipient can read it: true |
| `PROBE_GROUP=1 live-probe.mjs` | stored as `group_sender_key` v3; recipient can read it: true |
| **S12's deferred check** (scratch probe: two accounts, one server, `https://example.com/` posted by each) | previews off stored; on by default; the "on" author's message got an embed (`"title":"Example Domain"`); the "off" author's message has `embeds: []` after a 20 s wait. **4/4 PASS** |
| Recovery refusal (new, §2.6b) | `/auth/verify` with `existing_account_only` and an unknown key → `404 {code:"no_account_for_key", message:"No account on this server uses that recovery phrase."}` |

The probes print one console line from the client (`[gateway] … durable event
storage failed, event: READY`, then a reconnect from the checkpoint); the server
log has no error. It is a headless IndexedDB quirk of the probe pages and
live-drive's own "no unexpected errors" step stays green; noted, not chased.

### E2E (ports 4931–4937, 18610–18614)

| Suite | Result |
|---|---|
| `identity-setup` via `e2e/setup-review.config.ts` (4931/4933) | 6 passed |
| `setup-harness` (S13a scene, 4931/4933) | 21 passed |
| Index suite, `e2e/index-review.config.ts` (4935/4937), all `index-*.spec.ts` | first run 270 passed, 5 failed. Two were load flakes (pass on rerun: `index-card` s4, `index-dock` s1). Three fixed (§2.9): `index-connection` (fixture predates S3), `index-continuity` (race made consistent by the branch), `index-cards` pixel test (the gitignored reference PNG was missing in the fresh worktree; copied from `~/Documents/Paracord-index/output`, read only). After: `index-cards` 29, `index-connection` 8, `index-continuity` 2×3 runs, `index-identity-changed` 1 — all pass |
| `real-server.session-recovery` (`PARACORD_E2E_REAL=1`, `PARACORD_E2E_PORT=18610`, `PARACORD_E2E_MEDIA_PORT=18611`, recovery 18612/18614, app 4931, the copied release binary) | 1 passed |

The S10 screenshot `identity-changed-sidebar.png` from this run no longer carries
the "invalid UserSettingsResponse" toast.

## 2. Fixes and follow-ups resolved

1. **KDF policy in one place.** `paracord-contracts::credential` gains
   `SCRYPT_MAX_WORK = 1 << 23` and `KdfParams::work()`; `within_policy()` now
   also bounds N·r·p. `paracord_core::credential::check_kdf` is just
   `within_policy()` (its private ceiling is gone). The client keeps its mirror
   in `kdfCore.ts`; new `kdfCore.test.ts` pins 2^17/8/1, 2^20 and 2^23 and reads
   the constants out of `crates/paracord-contracts/src/credential.rs`, so a
   change on either side fails the test. Contract test covers the new edges
   (17/64/1 ok, 17/64/2, 20/16/1, huge p refused).
2. **Backups reach the hub.** `host_status::publish_backups(state)` calls
   `reachability::hub().set_backups(..)`; it runs at startup (`main.rs`, right
   after the status broadcaster is spawned; storage is already published by
   `at_rest_boot::publish_status`), after every backup (success or failure, in
   `run_backup`) and after `PATCH /admin/backups`. New
   `tests/backup_status_event.rs` (own binary, the hub is process-wide) sees an
   `INSTANCE_STATUS_UPDATE` on the bus at startup, for each switch change and
   after a backup (with `last_backup_at`).
3. **`link_previews` in the settings bundle.** `UserSettingsExport.link_previews:
   Option<bool>` (`serde(default, skip_serializing_if = "Option::is_none")`, so
   bundles made before it re-serialize byte for byte and their signatures still
   verify); export writes it, import applies it with `set_link_previews`. Test
   `identity::tests::settings_round_trip_carries_link_previews`.
4. **Escrow vector.** `vectors.reference.mjs` writes `escrow[]` (identity =
   `wrap[0]`'s key, instance `7c1f0b6e-…`, `escrow_key_hex` 03976eb9…, the
   `wrapping_key` b64url the client sends, and a storage key sealed under a fixed
   IV) plus `labels.escrow_salt` / `escrow_aad_prefix`; it refuses to write if
   the key differs from the value `paracord-util` pins. Both copies regenerated.
   Client test (Web Crypto HKDF + AES-GCM) in `vectors.test.ts`; server test
   `tests/escrow_vector.rs` (`derive_escrow_key`, `open_escrow`, other instance
   refused). **S13:** `pages/firstRun/escrow.test.ts` can read
   `vectors.json`'s `escrow[0]` instead of its own constants.
5. **e2e fixtures after S12.** `e2e/fixtures/index/routes.ts` and
   `e2e/fixtures/smokeApp.ts` settings answers gain `link_previews` and
   `link_previews_available`.
6. **Owner decisions.**
   - **(a) "Ask for my password when Paracord opens" is per device.** New
     `client/src/lib/askForPassword.ts`: the choice lives in this device's
     storage (`paracord:ask-for-password:v1`, `true`/`false`), a tiny store for
     the switch, fail-closed (storage unreadable → ask). `applyRememberPolicy`
     reads the device first; a device that never chose adopts the account's old
     `crypto_auth_enabled` once (and saves it), and with no settings readable
     it asks and saves nothing. `applyAskForPassword` writes only the device
     (no `updateSettings`). `ProtectedRoute` (S3's region of `App.tsx`) now
     calls `adoptAccountAskForPassword` when settings arrive: it migrates an
     unchosen device and otherwise ignores the account, so another computer's
     switch no longer reaches this one. Settings › Privacy shows the device's
     value ("…when it opens on this computer"). **Server field kept:**
     `crypto_auth_enabled` predates S0 (the legacy device-key gate and the
     identity bundle use it, and accounts on older servers still have that
     switch), so it was not removed; one-password devices no longer write it.
     Tests: `askForPassword.test.ts` (7).
   - **(b) Recovery never creates an account.** `POST /auth/verify` takes
     `existing_account_only` (default false); with it, an unknown key answers
     `404 no_account_for_key` "No account on this server uses that recovery
     phrase." before any sign-up rule runs. The v2 recover flow
     (`recoverWithPhrase`) always sends it and turns the code into
     `CredentialError('no_account', …)` (new code in `credential/errors.ts`).
     **Legacy behavior kept on purpose** where it is still needed: key sign-in
     without the flag still registers an unknown key — the legacy pages on
     older servers, and the desktop's key sign-in to other servers
     (`connectionManager`), which is how an identity gets an account on a
     server it joins. Tests: `credential_routes::recovery_with_an_unknown_phrase_makes_no_account`,
     `oneCredential.test.ts` "refuses a phrase no account on the server uses"
     (the fake server now auto-registers like the real one unless told not to).
7. **fmt / lock.** `events.rs` formatted; the lock is consistent (`--locked`).
8. **PostgreSQL run of S6's backup tests** (design issue, fixed minimally). The
   two `host_control.rs` tests that need a database *file* built a SQLite app in
   a binary whose other apps were PostgreSQL; `paracord_db`'s active engine is
   process-wide, so the SQLite file got the PostgreSQL migrations. They moved,
   unchanged, to their own binary `tests/host_backups.rs`, which always uses a
   SQLite file.
9. **E2E specs.** `index-connection.spec.ts`: Lantern (an older server in the
   fixture) answered `/auth/credential/params` with 401, which S3's sign-in
   dialog rightly treats as a refusal; it now answers the bare 404 of a missing
   route, as an older server does. `index-continuity.spec.ts`: the test emitted
   `MESSAGE_UPDATE` before the history was on screen (flaky on the base too,
   2/3; always failing on the branch); it now waits for the row first, like
   `index-longtail-dialogs` does. 3/3 green.

## 3. Files touched

S13's files were not touched (`pages/firstRun/**`, `components/firstRun/**`,
`firstRunStore`, the `App.tsx` route table, `InvitePage`, `InstanceSetupPage`,
`ServerConnectPage`, `onboarding/**`). `App.tsx` changes only the "Ask for my
password" effect in `ProtectedRoute` (S3's L115-216 region; S13's committed
hunks are at L4-30 and L533+, so the merge should be clean).

Rust: `paracord-contracts/src/credential.rs`, `paracord-core/src/{credential,identity,events}.rs`,
`paracord-api/src/routes/{auth,host_status}.rs`, `paracord-server/src/main.rs`
(one call), `paracord-api/tests/{credential_routes,host_control}.rs`, new
`paracord-api/tests/{backup_status_event,escrow_vector,host_backups}.rs`,
`paracord-api/tests/fixtures/credential_vectors.json`, deleted
`paracord-api/tests/first_run_route_stubs.rs`.
Client: `App.tsx`, `api/auth.ts`, `components/user/{UserSettings,PrivacySection}.tsx`,
`lib/{oneCredential,oneCredential.test,rememberedUnlock}.ts`, new
`lib/askForPassword{,.test}.ts`, `lib/credential/{errors,kdfCore,vectors.reference.mjs,vectors.json,vectors.test.ts}`,
new `lib/credential/kdfCore.test.ts`, `e2e/fixtures/{index/routes,smokeApp}.ts`,
`e2e/index-{connection,continuity}.spec.ts`.

## 4. Left for later

- **M2 / S13:** merge `setup-m1` with S13's commits; rerun `test:unit`,
  `identity-setup`, `setup-harness` and the S13 specs on the merged tree.
  S13's escrow test may switch to the shared vector (§2.4). Any first-run
  recover/phrase entry must expect `no_account` from `recoverWithPhrase`.
- **Owner copy question:** the Privacy row still reads "Ask for my password
  when Paracord opens"; only its confirmation says "on this computer". If the
  label itself should say so, it is one string in `PrivacySection.tsx`.
- **S9 decision (in-memory invite miss lockout):** acceptable for M1 — every
  server this program ships is one process; the counter resetting on restart
  only shortens a lockout. **S14:** say so in `docs/deployment.md` for anyone
  running replicas behind one address.
- **S14:** `docs/port-forwarding.md` `ifconfig.me` lines; Dockerfile
  `ENV PARACORD_AT_REST_ENABLED=false`.
- **S2 open item still open:** email change and `attach-public-key` for v2
  accounts (401 by design today; the client says so).
- **M3 / S15:** the CI `storage-encryption-targets` job and the hostctl live
  smoke have not run yet; desktop cold/warm deep links untested on a display.
- The PostgreSQL run covered `paracord-db` and `paracord-api` only (as asked);
  `paracord-ws`/`paracord-core` PG-specific tests were not rerun.

## 5. Cleanup

`.live-env-m1` deleted; the copied binary removed; the PostgreSQL container
stopped; the temporary base worktree used to check the continuity flake
(`~/Documents/Paracord-m1-base`) removed; no paracord, Vite, realtime-stub or
Playwright process of this run left. The owner's installed server (pid under
`~/.local/share/paracord`) was never touched; no router was asked anything
(every instance bound to loopback). The `setup-m1` worktree stays for the merge.
