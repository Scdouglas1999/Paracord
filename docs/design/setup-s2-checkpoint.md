# S2 checkpoint: server one-password routes

Package S2 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §3.3–§3.4, §3.7–§3.11, §3.13 (server side)
and the credential rows of §9.1. Branch `feat/setup`. Every S0 credential stub
(`routes/credential.rs`) is replaced; `rg not_built crates/paracord-api/src/routes/credential.rs`
is empty.

## 1. What the server does now

| Route | Behavior |
|---|---|
| `POST /auth/credential/params` | `{version:2,kdf,salt,epoch}` for a one-password account, `{version:1}` for a legacy one. Unknown identifiers, key-only (v0) accounts and unparsable rows get `version:2`, the default KDF, epoch 1 and a fake salt `HMAC-SHA256(HKDF-SHA256(jwt_secret, info="paracord/credential/fake-salt"), lower(trim(identifier)))`. Every request does the same work: one user lookup and one credential read (of id 0 when nobody matched). Identifier resolution is exactly `/auth/login`'s (username, `name#0001`, email). Auth bucket only (no guard record: nothing is verified). |
| `POST /auth/credential/register` | `/auth/register`'s rules in its order (guard, pending-setup 409, registration enabled, invite gate + slot reservation, username/email/display-name rules via the new shared `new_account_identity_error`), then credential checks, identity checks and the proof (purpose `register`, single-use nonce from `/auth/challenge`), then one generic `Unable to complete registration` for a taken email, username **or public key**. The row is inserted, then moved 1→2 with the identity and backup in one transaction; any failure deletes the account, releases the first-admin slot if it took it, and releases the invite slot. Auto-joins public servers like `register`; the client joins the invite's server with `POST /invites/{code}` as today. 201 `AuthResponse`. |
| `POST /auth/credential/login` | Auth guard keyed like `/auth/login`. Malformed key → 400 before any lookup. Unknown, key-only, wrong key → the same 401 body; unknown/key-only run a dummy Argon2 verify. Legacy account → 409 `credential_legacy` (params already says `version:1`). Email-verification and MFA gates are the shared `apply_login_gates`; the MFA ticket binds the stored hash, so `/auth/mfa/login` completes it unchanged (tested). Session issued under the account lock like every primary login. |
| `POST /auth/credential/upgrade` | Session. v2 → 409 `credential_upgraded`; v0 → 409 `credential_key_only`. Checks the legacy password (guard failure on a miss). An existing `public_key` must equal the offered identity (409 `identity_mismatch`); a proof (purpose `register`) is required either way. One transaction: lock `WHERE credential_version = 1 AND password_hash = <verified>`, `set_first_one_password`, set `public_key` if NULL, backup at epoch 1. Sessions kept. A lost race answers 409 `credential_upgraded` (or `credential_changed`). `{epoch:1}`. |
| `PUT /users/@me/credential` | Session (+MFA when on; TOTP or backup code). v1 → 409 `credential_legacy`. Verifies `current_auth_key`; one transaction conditional on version 2, the epoch and hash it read, the same `public_key`, and the caller's session still live: new hash/salt/kdf, epoch+1, backup re-wrapped (same identity, `recovery_confirmed` kept), every other session revoked, outstanding email-reset tokens deleted. `{epoch}`. |
| `POST /users/@me/credential/reset` | Session (from a key sign-in). Proof purpose `reset` verified against `users.public_key`; MFA when on; then the same conditional replacement as change. `{epoch}`. |
| `GET /users/@me/key-backup` | `KeyBackup`; 404 when the account has none. |
| `POST /users/@me/key-backup/recovery-confirmed` | 204; 404 without a backup. |
| `POST /setup/credential-claim` | The legacy claim's guard and token checks, then `new_account_identity_error`, instance/space names, hue 0-359, credential, identity, proof (purpose `register`). `paracord_core::instance_setup::claim_instance_one_password` creates the owner, moves it to v2 with identity and backup in one transaction, builds the first server from `initial_space_template` with its hue, and completes the claim; any failure rolls the whole claim back and the token survives. 201 `ClaimResponse`. |
| `POST /auth/reset-password` | Dispatches on the token's account: v2 takes `{token, credential, identity}` ("Start over": proof purpose `reset` by the **new** key; token spent, credential replaced, epoch+1, new `public_key`, signed and one-time prekeys deleted, backup replaced with `recovery_confirmed` false, every session revoked; `{epoch, message}`), and a v2 account sent `new_password` gets 409 `credential_upgraded`. v1 keeps today's behavior and refuses a credential body with 409 `credential_legacy`. v0 → 409 `credential_key_only`. |
| `GET /auth/options` | `+ credential_version: 2`, `+ min_password_length: 10`. |
| `GET /setup/password-requirements` | §3.4: `{min_length:10, max_length:128, requires_*:false, length_unit:"utf8_bytes", enforced_by:"client"}` (the `PasswordRequirements` contract). |
| `GET /invites/{code}` | `instance.credential_version: 2` (the one line S0 left at 1). |

**Legacy refusals (§3.10):** `POST /auth/login` → 409 `credential_upgraded` for
v2 (after a dummy verify and a guard failure; a v2 hash is never verified there)
and 401 for v0; `POST /auth/register` and `POST /setup/claim` → 410
`client_update_required` before anything else; `PUT /users/@me/password` → 409
`credential_upgraded` for v2. Refusals use a new `ApiError::Refused { status,
code, message }`, so the body is `{code, message, error, details}` with the
spec's lowercase codes and the spec's update text as `message`.

**Test-only legacy sign-up (for S3):** `PARACORD_TEST_ALLOW_LEGACY_SIGNUP=1`
re-enables `/auth/register` and `/setup/claim` only when the server is built
with `debug_assertions` (`routes::auth::legacy_signup_allowed`). A release
binary ignores it. Rust tests that exercise the legacy routes call
`common::allow_legacy_signup()`.

### Security properties and how they hold

- **No downgrade path.** `credential_version` writes are all conditional
  (`store_first_credential`, `replace_credential`, `start_over` in
  `paracord-core/src/credential.rs`, on top of S0's `paracord-db::credentials`).
  No route lowers it. The v2 hash is `Argon2id` over the **raw 32 key bytes**,
  so no route that verifies a typed password (`/auth/login`, `PUT /password`,
  `PUT /email`, `attach-public-key`) can ever be satisfied for a v2 account,
  even with the auth key sent as text (tested).
- **Proof separation.** Proofs sign `"<purpose>:<nonce>:<timestamp>:<origin>"`
  with a single-use server nonce (60 s, 5 s skew, the `/auth/challenge` store);
  a key sign-in signature (`"<nonce>:<timestamp>:<origin>"`) is not a proof,
  and a `register` proof is not a `reset` proof (tested both ways). Keys must
  be lowercase hex, canonical and not small-order (`is_weak`).
- **Constant shape.** Params: identical keys and work for every identifier.
  Login: one 401 body for unknown, key-only and wrong key, with a dummy
  verify. Register/claim: one generic 400 for any taken identifier.
- **Rate limits.** All `/auth/credential/*` sit in the 60/min auth bucket
  (path prefix). Login, register, upgrade, change, reset and claim use the
  DB-backed `auth_guard_*` (account hint: identifier, or user id for session
  routes); proof, key and MFA failures record guard failures.
- **Input checks (§3.4).** salt and auth key exactly 32 bytes unpadded b64url;
  KDF scrypt N 2^17..2^20, r ≥ 8, p ≥ 1 and N·r·p ≤ 2^23 (the client's ceiling); `wrap_alg` `aes256gcm-v2`; wrapped key
  exactly 60 bytes; salt and wrapped key stored re-encoded canonically.
- **Logs.** Nothing logs a key, hash, salt, wrapped key or token. Security
  events: `auth.register.credential`, `auth.login.credential`,
  `auth.credential.upgrade|change|reset`, `auth.password_reset.completed`
  (with `identity_replaced`), `instance.setup.claimed` (`auth_method`).

## 2. Files

S2's own: `crates/paracord-api/src/routes/credential.rs` (handlers),
`crates/paracord-core/src/credential.rs` (new: checks, proofs, hashing, fake
params, transactional writes, unit tests), `crates/paracord-core/src/instance_setup.rs`
(`claim_instance_one_password`; the legacy `claim_instance` delegates to the
same body), `crates/paracord-core/src/guild.rs` (`create_guild_from_template`,
`FRIENDS_TEXT_CHANNELS` with topics, `FRIENDS_VOICE_CHANNELS` Lounge/Gaming),
`routes/setup.rs` (requirements, legacy-claim refusal, `resolve_claim_email`
visibility), `routes/auth.rs` (refusals in `login`/`register`/`reset_password`,
`options`), `routes/users.rs` (`change_password` refusal),
`crates/paracord-api/tests/credential_routes.rs` (new).

Outside the S2 row (smallest additive changes):

- `routes/auth.rs` beyond the four handlers: `verify_credential_proof`,
  `legacy_signup_allowed`, `client_update_required`, `credential_upgraded`
  (new); `new_account_input_error` split into `new_account_identity_error` +
  the password rule (same order, same messages); `pub(crate)` on existing
  helpers the credential routes reuse (`apply_login_gates`, `LoginGate`,
  `mfa_required_response`, `issue_credential_auth_session`,
  `PrimaryLoginSnapshot`, `AuthSessionResponse`, `user_auth_json`,
  `release_signup_slot`, `invite_refusal_counts_against_guard`,
  `verify_totp_code`, `normalize_backup_code`, `sha256_hex`,
  `parse_username_with_discriminator`, `resolve_server_origin`). S4's
  L3286-3294 text hunk was left out of S2's commit.
- `crates/paracord-api/src/error.rs`: `ApiError::Refused`.
- `crates/paracord-api/src/routes/docs.rs`: credential routes contracted
  (params, upgrade, change, reset, key-backup, recovery-confirmed,
  password-requirements fully; register/login/credential-claim request bodies
  only, since `AuthResponse`/`ClaimResponse` have no contract);
  `/auth/credential/upgrade` marked bearer-auth.
- `crates/paracord-api/src/routes/invites.rs`: `credential_version: 2` (one line).
- `crates/paracord-core/src/lib.rs` (`pub mod credential;`),
  `crates/paracord-core/Cargo.toml` (`hkdf`, `hmac`, both already workspace
  deps), `crates/paracord-api/Cargo.toml` dev-deps `hkdf`, `aes-gcm`,
  `unicode-normalization` (workspace; no new crates in `Cargo.lock`).
- Tests of what S2 replaced: `tests/common/mod.rs` (`allow_legacy_signup`),
  one call each in the legacy-route tests (`auth_session_hardening`,
  `input_bounds_regressions`, `srv_api8_discovery_autojoin`, `instance_setup`,
  `storage_and_listing_limits`, `registration_invite_only`);
  `instance_setup::claim_reuses_the_registration_password_rules` now asserts the
  §3.4 requirements; the S2 rows of `first_run_route_stubs.rs` removed.
- `Cargo.lock`: S11's `0a040e0b` committed a malformed lock (a
  `"tauri-plugin-clipboard-manager"` line under `paracord-federation`'s
  version, an `os_pipe` entry split into `p256`), which cargo cannot parse.
  S2's commit carries the lock cargo regenerated for the committed manifests
  (`cargo metadata` in a checkout of exactly the staged tree, then
  `--locked` passes): that repair plus `unicode-normalization` under
  `paracord-api`. S4's uncommitted `openssl-src`/`openssl-sys` entries stay in
  the working tree only. The staged tree was type-checked on its own
  (`cargo check -p paracord-api --tests --locked` in a separate checkout).
- Already in other packages' commits (swept in while S2 was uncommitted, so
  those commits compile only together with S2's): the `change_password`
  refusal landed in S12's `b2a6ec89`, the S2 stub-row removals in S6's
  `9e49e728`, and `credential_version: 2` in `get_invite` in S9's `22a92637`.

## 3. Vectors

S1's `crates/paracord-api/tests/fixtures/credential_vectors.json` landed during
S2 and is checked byte for byte by `shared_vectors_match` through the server's
own code (NFKC bytes, salt hash, HKDF auth/wrap from each `master`, auth-key
decoding, the wrapped identity opened with AES-256-GCM and the v2 AAD, public
key from the private key, both proofs' messages and signatures and their
purpose separation, the full register body through the contract type and the
checks, and the KDF accept/refuse cases). Before it landed S2 produced its own
vector with `@noble/hashes` scrypt and Node's AES-GCM/Ed25519
(`s2_vector_matches_the_spec_definitions`, kept); S2 also recomputed S1's three
`master` values with that independent scrypt: all three match byte for byte.

**One mismatch found and fixed on the server side:** S1's `kdf_policy` refuses
`scrypt log_n 20, r 16, p 1` as too heavy (the client's `SCRYPT_MAX_WORK`:
N·r·p ≤ 2^23), but S0's `KdfParams::within_policy` only bounds `log_n`, so the
server would have stored a credential no client can sign in with.
`paracord_core::credential::check_kdf` now applies the same work ceiling
(`SCRYPT_MAX_WORK = 2^23`). `KdfParams::within_policy` in `paracord-contracts`
(S0's file) still lacks it; the orchestrator may want to move the ceiling
there so there is one definition.

## 4. Commands and results

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean for S2's files (diffs reported only in other packages' in-progress files: `paracord-core/src/events.rs`, `paracord-db/src/lib.rs`, `paracord-db/tests/sqlcipher_open.rs`, `paracord-server/src/at_rest_boot.rs`) |
| `cargo clippy -p paracord-core -p paracord-api --all-targets -- -D warnings` | ok |
| `cargo clippy --workspace -- -D warnings` | fails only in S5's in-progress `paracord-server/src/{reachability,portmap}.rs` (dead code, `match`→`matches!`) |
| `cargo test -p paracord-core` | 334 passed (6 new in `credential::tests`) |
| `cargo test -p paracord-api --test credential_routes` (SQLite) | 22 passed |
| same on PostgreSQL 16 (`docker run … -p 55432:5432 postgres:16`, `PARACORD_TEST_POSTGRES_URL=postgres://postgres:pc@127.0.0.1:55432/postgres`): `credential_routes`, `instance_setup`, `postgres_route_smoke`, `contract_wire_shapes` | 22 + 10 + 2 + 7 passed |
| `cargo test -p paracord-api --no-fail-fast --lib --test <every file except host_control>` (SQLite) | 842 passed, 0 failed (91 binaries; the last run had 1 failure in `shared_vectors_match`, fixed below and rerun green). `tests/host_control.rs` was excluded: S6's in-progress file did not compile at the time (`admin_token` missing) |
| live: release `paracord-server` on 127.0.0.1:18440, data `.live-env-s2` (live-env's env, plus `PARACORD_AUTO_PORT_FORWARD=false` so the new default never touches the router, and `PARACORD_AUTH_CHALLENGE_TOKEN` for the probe's deliberate failures), probe `scratchpad/s2/live-probe-s2.mjs` deriving with `@noble/hashes` scrypt and real AES-GCM/Ed25519 | **26/26 PASS**: options and requirements; v2 register; params real vs fake (same shape); v2 login; wrong key and unknown alike; key backup unwraps on a "new device"; recovery-confirmed; legacy login (password and auth key as text) 409, legacy register 410, legacy password change 409; change (epoch 2, this session kept, other revoked, old dead, new works, backup re-wrapped and still confirmed); key sign-in + reset-by-key (register-purpose proof 401, epoch 3, sessions revoked, third password works, params epoch 3); without the bypass, 7 wrong keys end in 429. Server log: 0 lines with key material. Data dir deleted afterwards |

`credential_routes` covers: both vector sets; the vector credential registering
and signing in and its backup coming back; params for v2/v1/key-only/unknown
(shape, stability, case-blindness, the HMAC definition); register storing
version 2, epoch 1, salt, KDF, key and backup, and the hash not verifying as
text; bad KDF/lengths/alg/uppercase key (400), plain-signature, wrong-purpose
and wrong-key proofs (401), nonce replay (401), taken name/key (one generic
400), invite gate; login success, one 401 body for wrong key and unknown,
malformed key 400, v1 → `credential_legacy`; the MFA ticket branch through
`/auth/mfa/login`; every downgrade attempt (legacy login with the auth key as
text or any password, legacy password change, legacy email reset, a second
upgrade) refused with the account untouched; legacy register/claim 410;
options and requirements; the v1 move (wrong password, success, sessions
kept, old path refused afterwards, identity mismatch, existing identity
accepted); **four concurrent moves on a 4-connection pool: exactly one wins and
the stored credential and backup belong to the same request**; change (wrong
key, success, other sessions revoked, old key dead, backup re-wrapped,
`recovery_confirmed` kept, v1 refused) and its MFA requirement; reset by key
(register-purpose and other-key proofs refused, success, sessions revoked);
Start over by email (new identity, prekeys/backup replaced, confirmation reset,
sessions revoked, token single use); the credential claim (wrong token 401,
hue 360 400, owner v2 + admin + backup, hue 150, channels
general/clips/plans with topics then Lounge/Gaming, token spent, owner signs
in).

## 5. Differences from the spec (and why)

1. **Purposes for the move and Start over.** The spec names two purposes. The
   v1 move and the claim use `register` (they bind a new or existing identity
   to a new credential); email Start over uses `reset`, signed by the **new**
   key. S3 must sign those the same way.
2. **Extra refusal codes** the spec leaves unnamed: `credential_key_only`
   (v0 on upgrade/change/reset/email reset), `identity_mismatch` (move with a
   different key than the account's), `credential_changed` (a concurrent write
   won; nothing changed). All 409.
3. **Register joins as `register` does**: invite gate + slot, public
   auto-join; the invite's own server is joined by the client's existing
   `POST /invites/{code}` (neither route joins it server-side today).
4. **Start over response** is `{epoch, message}` (the spec does not fix one).
5. **Email reset for v0 accounts** is now refused (409 `credential_key_only`)
   instead of silently giving a key-only account a password the sign-in path
   then refuses.

## 6. Open issues / for later packages

- **Release builds refuse legacy sign-up.** Everything that registers through
  `POST /auth/register` or `/setup/claim` against a release binary now gets
  410: `client/scripts/live-drive.mjs` / `live-probe.mjs` (S3 is updating
  them), the real-server Playwright specs and harnesses
  (`client/e2e/real-server*.spec.ts`, `real-server-harness.mjs`,
  `messaging-server-harness.mjs`, `release-real-ui-smoke.mjs`) and the
  `scripts/release_*_smoke.py` scripts. The plan's M1 line "live-drive all PASS
  with S2's server and the old client flows still green" cannot hold on a
  release binary until S3 lands; with a debug build and
  `PARACORD_TEST_ALLOW_LEGACY_SIGNUP=1` the old flows still work.
- **v2 accounts and the remaining typed-password routes.** `PUT
  /users/@me/email` and `POST /auth/attach-public-key` re-authenticate with a
  typed password, which never matches a v2 hash, so a v2 account gets 401 there
  (by design no identity swap outside the credential routes). Changing the
  email of a v2 account needs an auth-key variant later (not in the spec).
- **Enumeration notes.** Legacy `/auth/login` answering 409 for v2 accounts
  (spec-mandated) tells a prober the account exists; it costs a guard failure
  per try. The fake salt is per identifier, so someone who knows both an
  account's username and email can tell they belong together (two real
  identifiers share one salt; two fake ones do not).
- `first_run_route_stubs.rs` has no rows left (S6 removed theirs too); M1 can
  delete it.
- The legacy `InstanceSetupPage`/register pages read password requirements;
  they now show no composition rules (S13 retires them).
