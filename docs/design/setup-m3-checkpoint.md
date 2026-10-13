# M3 checkpoint: full local CI on feat/setup

Merge checkpoint M3 of [`setup-plan.md`](setup-plan.md), run on
`~/Documents/Paracord-setup` (`feat/setup`, everything through S13b
`c3559472`; S15 committed `54674d62` while this ran and touched only
`scripts/fresh-machine/**` and `client/e2e/fresh-machine/**`). Shared target
`CARGO_TARGET_DIR=~/Documents/Paracord-glass/target`; `host:stage
--placeholder` before every `--workspace` cargo command.

## 1. Gates

Final state, on the tree this checkpoint commits.

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | ok |
| `cargo clippy --workspace --all-targets -- -D warnings` | ok |
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` | ok |
| `cargo test --workspace --locked --no-fail-fast` (SQLite) | **2501 passed, 0 failed**, 6 ignored (full `paracord-api` suite included) |
| PostgreSQL 16 (`docker run postgres:16 -p 127.0.0.1:55432:5432`, `PARACORD_TEST_POSTGRES_URL`) | `paracord-db` smoke, query-plan smoke and the whole crate: pass; `paracord-api --test postgres_route_smoke`: pass; `paracord-api --tests -- --test-threads=4`: **861 passed, 0 failed**; `scripts/release_postgres_upgrade_from_tag_smoke.py v0.9.0`: OK (35 + 83 migrations) |
| `npm test` (typecheck, unit, tokens, motion-lint) | ok; **487 files, 4851 passed** |
| `npm run lint` | 0 errors (242 warnings). Mid-run S15's uncommitted `e2e/fresh-machine/lab.mjs` had 1 error; S15's commit fixed it |
| `test:a11y:static`, `test:contrast`, `contracts:check` | pass (55 verified) |
| `npm run test:e2e` (4941/4943) | 120 tests; after §2.2 every one passes; three are intermittent (below) |
| `npm run test:e2e:index` (4945/4947) | first run 262 passed, 13 failed (10 the retired screens of §2.2); after §2.2 `index-longtail-auth` 12 passed and the rest pass on rerun, except `index-cards.spec.ts:328` (environment, below) |
| `setup-harness.spec.ts` (5003/5005) | **21 passed** |
| `setup-s13.spec.ts` (5003/5005, WP `m3`) | **34 passed** |
| `PARACORD_E2E_REAL=1` suite (release binary, 18700/18702/18705, recovery app 4949) | first run 2 passed / 17 failed (§2.3); after the fix **19 passed**, incl. `setup-claim`, `setup-join`, `session-recovery`, `realtime-hold`, `real-server-restore`, voice check/join |
| Live: release server + `live-env --port 18730 --data .live-env-m3` | served bundle `index-0xVJlW6D.js` = `client/dist` |
| `live-drive.mjs` | **28/28 PASS** |
| `live-probe.mjs` (DM) / `PROBE_GROUP=1` | recipient can read it: true / true (`group_sender_key`). The one client console line `durable event storage failed, event: READY` is M1's known headless IndexedDB quirk |
| `rg not_built` | empty outside `docs/` |
| `cargo build --release --target x86_64-pc-windows-gnu --bin paracord-server --bin paracord-host` | ok, no warnings after §2.4 |
| `npm run host:stage -- --release` then `npx tauri build --no-bundle` | ok: 63.6 MiB real sidecar staged, `paracord-desktop` built (links `libvpx.so.12`); placeholder restored afterwards |

Intermittent, not code: `smoke.spec.ts:190` (lazy routes) and `:218`
(themes), `:429` (quick switcher, touch), `durable-delivery.spec.ts:714` failed
in one of two full runs each and passed on every rerun; `:190` fails about one
run in three right after a cold Vite start (the first lazy chunk compiles past
the 10 s wait). Index: `index-dock:260`, `index-phone:690`, `index-sheets:248`
failed once under `cargo test` load and passed on rerun. `index-cards:328`
needs `output/design-reference/index/ref/s0-plan-a-night.png`, an ignored
render of an ignored prototype that is in no checkout on this machine
(`node e2e/index-reference.mjs` makes it from `paracord-index.html`).

## 2. Fixes

### 2.1 Escrow always for the owner's current key (S13b "Still open")

After "Start over" the owner has a new identity, but a backup made before can
still be opened with the old phrase. Restoring it, row 3 derived the new
instance's escrow key from that old phrase while the server wrote the escrow
naming the owner's new `users.public_key`: a recovery copy no phrase could use
(the new phrase passes the client's owner-key check but cannot unwrap; the old
one fails the check).

- `StorageKeyEscrowRequest` gains a required `owner_public_key` (hex of the
  identity key the wrapping key was derived from). `store_escrow`
  (`routes/host_status.rs`, shared by `POST /host/storage-key/escrow` and
  `POST /admin/storage-key/escrow`) refuses a key that is not the owner's
  current one with **409 `escrow_owner_mismatch`** and writes nothing.
- An escrow on disk for this instance and this owner key is still write-once
  (409, now coded `escrow_exists`, message unchanged). One that names another
  owner key (made before "Start over") or another instance is stale and is
  **replaced** by a staged write and rename, so a failure keeps the old file;
  an unreadable one is never overwritten.
- hostctl treats a 409 as "already written" except `escrow_owner_mismatch`,
  which now fails row 3 with the server's reason (before, every 409 was
  swallowed). `Host::write_escrow`, `HostApi::write_escrow`, Tauri
  `host_write_escrow({ wrappingKey, ownerPublicKey })`, `hostStore.writeEscrow`
  and `commands.hostWriteEscrow` carry the key; the client derives it with
  `escrowRequest()` (`pages/firstRun/escrow.ts`) in all three flows (host row
  3, claim-mode escrow, restore row 3).
- `paracord-server escrow-key --json` prints the endpoint body for manual
  re-escrow; `docs/backup-recovery.md` and `docs/setup-spec.md` §4.7 / §9 say so.
- Tests: `host_control.rs only_the_owner_may_escrow_the_storage_key` now walks
  write → `escrow_exists` → owner starts over → old phrase's key refused
  (`escrow_owner_mismatch`, file byte-identical) → any other key refused →
  new key replaces the stale escrow, opens with the new key only, no staging
  file left → `escrow_exists` again. hostctl `host_tests` asserts a mismatch
  fails row 3 and records no `escrow` step. `escrow.test.ts` pins the body
  against the shared vector; the s13 e2e asserts `ownerPublicKey` /
  `owner_public_key` on both escrow calls.

What the owner sees on that rare restore: row 3 fails with "That recovery
phrase isn't the server owner's current one (the owner started over …)". The
server is restored and running; saving a recovery copy under the new phrase
is the `escrow-key --json` + admin endpoint step (no in-app screen for it yet).

### 2.2 Specs for screens the first run retired (S13)

`/connect` only redirects now, `/setup-server` is claim mode (Host › Name) and
`/invite/:code` is the web join; the specs still drove the old connect page,
five-step owner wizard and invite page.

- `e2e/auth-fit.spec.ts`: the setup-server and invite entries measure the new
  screens; the old wizard test is now "the first-owner claim fits at every
  step, and Enter walks it" (Name → Account at 940×500, Back keeps the name);
  the connect-page tests are removed (no screen).
- `e2e/index-longtail-auth.spec.ts`: the connect, owner-wizard, invite and
  connect-fit tests are removed with a note; those screens are first-run
  screens reviewed against the prototype in `setup-s13.spec.ts`, not Index
  entry pages.

### 2.3 Real-server suite on one password (follow-up "real-server e2e specs need v2")

Release builds answer the legacy `POST /auth/register` with 410. New
`e2e/fixtures/onePassword.ts` (on `scripts/lib/credential-node.mjs`, typed by
the new `scripts/lib/credential-node.d.mts`) registers through
`/auth/challenge` + `/auth/credential/register` and signs in through
`/auth/credential/params` + `/auth/credential/login`; `real-server.smoke`,
`realtime-hold`, `-restore`, `voice-check` and `voice-join` use it, and enter
the password on the unlock screen a page load now shows. The smoke test about
the old separate identity enrollment (`/setup?migrate`, `attach-public-key`)
is rewritten to the one-password equivalent (each sign-up its own identity,
a rejected password changes nothing, no `attach-public-key` ever sent). The
Inbox test reaches the Inbox in-app (a load would lock the identity mid-check);
the member-count test sets the server back to private after the join so
parallel specs' sign-ups can't auto-join it.

### 2.4 Small

- `paracord-core/src/backup.rs`: the Windows build warned `unused_mut` (the
  `mut` is only for the Unix mode); `cfg_attr(not(unix), allow(unused_mut))`.
  Pre-existing on main.
- The shared target's `host` profile held a `paracord-contracts` artifact
  older than this tree's `host.rs` (cargo did not rebuild it; release and
  Windows profiles did). Touching the file fixed it. If a `host:stage
  --release` reports a missing contract field, touch the contracts source.

## 3. Follow-up list (scratchpad `setup-followups.md`)

**Resolved**

- M1 full `paracord-api` suite (SQLite and PostgreSQL) — §1; "not run since S4" too.
- S12 live link-preview check — M1 ran it (4/4).
- S3 "Device crypto security" toggle — folded into the Privacy row; only the
  v1 account's status line still says the old words.
- S3/S13 sign-up records activity off (`withExplicitActivityOff` in
  `oneCredential.ts` and `firstRun/flows.ts`).
- Settings bundle `link_previews` (M1 `b51368fb`).
- S11 `take_pending_deep_links` handler line; new routes in `routes/docs.rs`.
- HEAD compiles (`credential_upgraded`), M1 fmt diffs, S4 clippy — all gates green.
- S7 `--log-file` in the service unit (hostctl tests assert it).
- S9 in-memory invite lockout — accepted at M1, documented in `docs/deployment.md`.
- `INSTANCE_STATUS_UPDATE` storage/backups (`set_storage`, `set_backups` wired).
- S14 `ifconfig.me` in `docs/port-forwarding.md` — gone.
- S13 "Your public address changed" (`previous_url` on the Invite screen).
- e2e mock `UserSettingsResponse` (`link_previews` in smoke and index fixtures).
- S13 trust_server/first-contact probe on the invite card; `/welcome/join/invite`,
  `watchClipboardInvite`, `copySecretToClipboard`, `FIRST_RUN_JOIN_PATH`.
- KDF policy in contracts; S1 escrow vector (`escrow_vector` test).
- M1 live-drive on a release build — 28/28 here, release binary.
- Real-server e2e specs on v2 — §2.3 (`release_*_smoke.py` not checked).
- S6/S7 desktop restore must not keep an init key — S13b `Host::restore_fresh`.
- `MessageInput.test.tsx` — unit suite green.
- "Ask for my password" per device (M1); `/auth/verify` never creates an account (M1).
- S13 not-built list (restore link/flow, claim-mode escrow + instance id,
  failed-update banner, `test:motion` port) — S13b.
- Web/headless claim escrow, `encryption.md` wording, escrow-key CLI,
  `paracord.example.toml` `auto_port_forward` — S13b.
- S13b open item "escrow after Start over" — §2.1.

**Still open**

- Release notes items ("Show what I'm playing" off by default; "artefact" phrase fix).
- Owner's router answers no UPnP/NAT-PMP/PCP: tell the owner.
- Email change and `attach-public-key` for v2 accounts (401 by design today).
- `live-drive` v1 seeding rewrites SQLite directly (needs at-rest off) — by design for the release build.
- CI-only, not runnable here: `storage-encryption-targets`, Windows MSVC
  `OPENSSL_SRC_PERL`, hostctl `live_service` on three OSes, the first macOS
  hostctl compile, macOS sidecar signing in a notarized release, `install.ps1`
  / `install-smoke-windows`.
- S15: `PARACORD_HOSTCTL_LIVE_HOST_BINARY` rows 1–2 (S15's).
- S11 real cold/warm deep link on a desktop display (S15's lab).
- S14 Dockerfile keeps `PARACORD_AT_REST_ENABLED=false` — intended (§4.2), documented.
- No in-app screen to save a recovery copy under the current phrase after a
  "Start over" or after the §2.1 refusal; today it is `escrow-key --json` +
  the admin endpoint.
- `CLAUDE.md` `host:stage` note — the orchestrator's, at the main merge.
- Info only: port 18200 (tally-dev), S9 strict parser, S3 proof purposes,
  `b2a6ec89` builds only with `cc2ea16b`, S13 claim-mode decisions, `.deb` size
  (16.5 → 43.3 MB).

## 4. Cleanup

Stopped and removed: both PostgreSQL containers (`--rm`), the live-env server
and `.live-env-m3`, `/tmp/paracord-live-m3`, every Vite, realtime stub,
real-server harness and Playwright browser of these runs. The copied release
binary lives only in the session scratchpad. The sidecar placeholder is back
in `client/src-tauri/binaries/`. Disk: 279 GB free at the start, 142 GB at
the end (the shared target grew by the workspace test binaries and the
Windows, `host` and desktop release builds). Nothing touched the owner's
installed app, a service manager or the router.
