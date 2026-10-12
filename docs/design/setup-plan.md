# First-run setup: build plan

How to build [`docs/setup-spec.md`](../setup-spec.md) in the worktree
`~/Documents/Paracord-setup`, branch `feat/setup`, based on `main` at
`a1853e93`. The spec is the contract; this file says who builds what, in which
order, behind which fences, and how each piece is proven.

> **Before any agent starts:** read `CLAUDE.md` and the spec sections your
> package names. Work only in `~/Documents/Paracord-setup`. Never touch the
> main checkout, other worktrees, the installed app
> (`~/.local/share/paracord-client`) or any running `paracord-server` (the LAN
> server at 192.168.1.28 included). Never run `systemctl --user enable` or
> `schtasks`/`launchctl` against the real session outside the container
> harness (§5.4). `/tmp` is RAM: keep build output in the worktree's `target/`
> and delete package scratch dirs when done. A linker SIGBUS on this box is a
> disk fault: retry.

---

## 1. Shape of the work

| Area | Verdict |
|---|---|
| Server: credential v2, key backup, claim v2, legacy refusals | **New** routes and db modules beside the old ones; legacy routes gain refusals only |
| Server: at-rest key sources, SQLCipher build, encrypt-storage, escrow | **Extended** (`build_at_rest_profile`, `at_rest.rs`, `paracord-db` build features) |
| Server: reachability | **Rebuilt** on top of `portmap.rs`; ipify removed |
| Server: host mode (`paracord-host` bin, desktop-host profile, `/host/*`, log file) | **New** |
| Desktop: service manager | **New crate** `crates/paracord-hostctl` + Tauri `host.rs` |
| Desktop: trust (words, WebPKI-first, identity-changed) | **Extended** `TofuPinningVerifier` and commands |
| Desktop: deep links, clipboard | **Completed** (queue + JS listener) / **new** plugin |
| Client: credential crypto, keystore v2 | **New** `lib/credential/` |
| Client: sign-up/in, unlock, change, recover, v1 move | **Rebuilt** on v2; legacy pages kept for older servers |
| Client: first run | **New** `pages/firstRun`, `components/firstRun`; `InstanceSetupPage` and `OnboardingWizard` **retired** |
| Installers, docs | **Extended** |

Contracts are fixed first (S0) so every later package compiles against real
types and route stubs.

---

## 2. Packages

Tiers: **Opus** for crypto, at-rest, the host service and the first-run UI
integration (owner's rule) and for anything security-critical in the verifier;
**Sonnet** for well-scoped work against a fixed contract. Size: S ≈ half a
session, M ≈ one, L ≈ a full session.

Every package:

- edits only its listed files plus its own new tests; never commits (the
  orchestrator commits per package, staging paths by name, never `git add -A`);
  replaces or deletes the tests of whatever it replaces (no skipped tests);
- writes `docs/design/setup-s<N>-checkpoint.md`: what changed, commands and
  results, screenshots, differences from the spec/prototype, what is left;
- passes the **Rust gate** when it touches Rust: `cargo fmt --all -- --check`,
  `cargo clippy --workspace -- -D warnings`, and when it touches
  `client/src-tauri`: `cargo clippy -p paracord-desktop --all-targets -- -D warnings`;
  `cargo test -p <each crate touched>`;
- passes the **client gate** when it touches `client/`: `npm run typecheck`,
  `npm run test:unit`, `npm run lint` (no new errors), `npm run test:tokens`,
  `npm run test:motion-lint`; UI packages also `npm run test:a11y:static` and
  `npm run test:contrast`; `npm run contracts:check` when contracts changed;
- uses only its own ports (§5.2), its own live data dir
  (`.live-env-s<N>`, deleted at the end) and never the defaults 18420/4173;
- for **live checks** (marked "live" below): `cd client && npm run build`,
  `cargo build --release --bin paracord-server`,
  `node scripts/live-env.mjs --port <P> --data .live-env-s<N>`, then
  `PARACORD_LIVE_PORT=<P> PARACORD_LIVE_SHOTS=/tmp/paracord-live-s<N> node client/scripts/live-drive.mjs`
  (all PASS) plus the package's own live probe, and reads the screenshots.

| WP | Goal | Files (may edit) | Depends | Model | Size | Wave |
|---|---|---|---|---|---|---|
| **S0** Contracts, schema, config, route stubs | All spec §9 types in `paracord-contracts` (`credential.rs`, `host.rs`, invite additions) and regenerated client types; migration `20261013000001_first_run_setup.sql` in **both** dirs (spec §9.3) with db modules `credentials.rs`, `key_backups.rs` and SQLite + PG tests; every §9.4 config field, template text and env override with the §8.1 defaults; route registrations in `paracord-api/src/lib.rs` for every §9.1 route pointing at handler files that return `501 {code:"not_built"}` (the branch never merges with a stub left: M1 checks); `ServerFeature` gains `oneCredential`, `hostStatus`; Tauri command names registered as stubs in a new `client/src-tauri/src/host.rs`/`trust_cmds.rs` that return `Err("not built")` | `crates/paracord-contracts/src/**`, `contracts/api-contracts.json`, `client/src/api/generated/**`, `crates/paracord-db/migrations/20261013000001_first_run_setup.sql`, `crates/paracord-db/migrations_pg/20261013000001_first_run_setup.sql`, `crates/paracord-db/src/{credentials,key_backups,lib}.rs`, `crates/paracord-db/tests/**` (new files), `crates/paracord-server/src/config.rs`, `crates/paracord-api/src/lib.rs` (routes), new `crates/paracord-api/src/routes/{credential,host,host_status}.rs` (stubs), `client/src/lib/serverFeatures.ts`, `client/src-tauri/src/{host.rs,trust_cmds.rs}` (stubs) + their `generate_handler!` lines | none | Opus | M | A |
| **S1** Credential crypto library | Spec §3.2, §3.5, §3.6, §3.14: `lib/credential/{kdf.worker.ts,derive.ts,wrap.ts,keystoreV2.ts,proofs.ts,vectors.json}`; scrypt in a worker (Vite worker import), HKDF/AES-GCM via Web Crypto, NFKC, parameter floor/ceiling, AAD format, v2 keystore read/write + per-account pin record (§3.13), common-password list (`lib/credential/common-passwords.txt`, 10k, lazy-loaded) and the meter `score()`; test vectors shared with S2 (`vectors.json` copied to `crates/paracord-api/tests/fixtures/credential_vectors.json` by S1) | `client/src/lib/credential/**` (new), `crates/paracord-api/tests/fixtures/credential_vectors.json` (new) | S0 | Opus | M | B |
| **S2** Server one-password routes | Spec §3.3–§3.4, §3.7–§3.11, §9.1 credential rows and `credential-claim`: params (fake salt, constant-shape), register v2 (proof verify, invite gate + join as `register`), login v2 (auth guard, dummy verify, MFA branch), upgrade (conditional version update), change, reset-by-key (fresh challenge purpose), key-backup GET + recovery-confirmed, claim v2 with `initial_space_hue` + `initial_space_template:"friends"` (template in core), email reset for v2, legacy refusals table §3.10, `auth/options` + `password-requirements` changes. Integration tests per route in `crates/paracord-api/tests/credential_routes.rs` incl. vectors, downgrade attempts (v2 → legacy login/password routes), concurrent upgrade race, PG run | `crates/paracord-api/src/routes/credential.rs`, `routes/setup.rs`, `routes/auth.rs` (legacy refusals in `login`, `register`, `reset_password`, `options` only), `routes/users.rs` (`change_password` refusal only), `crates/paracord-core/src/{credential.rs (new),instance_setup.rs,guild.rs (template fn only)}`, `crates/paracord-api/tests/credential_routes.rs` (new) | S0 | Opus | L | B |
| **S3** Client account flows on v2 | Spec §1.12 sign-in, §3.3, §3.5 (desktop remembered unlock, "Ask for my password" setting), §3.7 change in Settings › Account, §3.8 recover, §3.9 Start over, §3.11 v1 move screen (`/setup` rebuilt), §3.12 old-server legacy path + Settings line, §3.13 pins; `authStore`/`accountStore` wiring; retire the composer "Set up encryption" link; **update `client/scripts/live-drive.mjs` and `live-probe.mjs`** to register and enrol through v2 (API register with derived credential via a small Node port of `derive.ts`, no `/setup` page) and add steps: "sign in on a second browser context gets the identity from the backup", "password change keeps DMs readable", "v1 account moves to one password" (seeded by a v1 registration through a test-only server env `PARACORD_TEST_ALLOW_LEGACY_SIGNUP=1`, compiled only with `cfg(debug_assertions)`, owned by S2: S3 requests it in its checkpoint and S2 adds it) | `client/src/stores/{authStore,accountStore}.ts`, `client/src/api/auth.ts`, `client/src/lib/{account.ts,accountSession.ts,crypto/identityKeystore.ts,crypto/attachAccountIdentity.ts}`, `client/src/pages/{LoginPage,RegisterPage,AccountSetupPage,AccountUnlockPage,AccountRecoverPage}.tsx`, `client/src/components/user/UserSettings.tsx` (account, identity and "Device crypto security" sections only), `client/src/components/message/MessageInput.tsx` (line 1613 link removal only), `client/src/App.tsx` (crypto redirect logic L115-216 only), `client/scripts/{live-drive,live-probe}.mjs`, `client/scripts/lib/credential-node.mjs` (new) | S1, S2 | Opus | L | C |
| **S4** At-rest automatic key | Spec §4: `libsqlite3-sys` SQLCipher feature (verify Linux, `x86_64-pc-windows-gnu` cross build, and the macOS CI build), key sources with exit 78, keychain via `keyring` with platform features + roundtrip self-test, `systemd-creds` reader, file perms check, generation at `init`/first run, `StorageStatus` (live `PRAGMA cipher_version`), escrow write (host + admin routes' core functions) and manifest `key_escrow`, `restore-backup --escrow-key-stdin`, `encrypt-storage` CLI with journal + verification, MFA refusal text; tests: plaintext → encrypted migration round trip with row counts and file reads, interrupted migration resume, wrong key exit 78, escrow unwrap with the S1 vector key | `Cargo.toml` (workspace deps), `crates/paracord-db/Cargo.toml`, `crates/paracord-db/src/lib.rs` (SQLCipher open only), `crates/paracord-util/src/at_rest.rs`, `crates/paracord-server/src/{at_rest_boot.rs (new),encrypt_storage.rs (new),cli.rs}`, `crates/paracord-server/src/main.rs` (`build_at_rest_profile` L1858-1924 and its call at L291; `restore-backup`/`encrypt-storage` dispatch only), `crates/paracord-core/src/backup.rs`, `crates/paracord-api/src/routes/auth.rs` (L3286-3294 text only), `crates/paracord-server/Cargo.toml` (keyring), `crates/paracord-server/tests/at_rest_*.rs` (new) | S0 | Opus | L | B |
| **S5** Reachability | Spec §5: `paracord_core::reachability` state + gateway `INSTANCE_STATUS_UPDATE`, classification (private/CGNAT/direct), NAT-PMP external address, retry loop (60 s), renewal failure handling, `confirmed_at` from the TLS accept path, Windows `firewall_blocked` check, share address from state, delete ipify (`main.rs` 183-189 and `with_fallback_ip`), router-reported IP in TLS SANs; tests with fake `Router` impls for each state and the classification table; live: run live-env with `PARACORD_AUTO_PORT_FORWARD=true` on this LAN and record what this router reports (read-only; the mapping is released on exit) | `crates/paracord-server/src/{portmap.rs,reachability.rs (new),tls.rs (SAN input only)}`, `crates/paracord-server/src/main.rs` (L183-189, L421-465, L1120-1200, `share_address_for` L3616-3660 only), `crates/paracord-core/src/{reachability.rs (new),share_address.rs,router_access.rs}`, `crates/paracord-ws/src/**` (dispatch of the new event only), `crates/paracord-api/src/routes/invites.rs` (`share_address` L239-245 only) | S0 | Sonnet | M | B |
| **S6** Server host mode | Spec §2.1 (bin target), §2.5, §2.7, §2.8 logs, §8.5, §9.1 `/host/*` + `/admin/host-status` + `/admin/reachability/retry` + `/admin/backups` + `/admin/storage-key/escrow` handlers (calling S4/S5 core functions; until those land, S6 tests use their S0 types with fixed values), `init --profile desktop-host --root --port`, `[server] redirect_listener=false`, `--log-file` with daily rotation (7), host token file per start, loopback + token guard, `spawn_auto_backup` reading the DB override; tests: token guard (non-loopback, bad token), profile config golden file, log redaction | `crates/paracord-server/Cargo.toml` (`[[bin]] paracord-host`, `src/bin/paracord-host.rs`), `crates/paracord-server/src/{host_mode.rs (new),logging.rs (new),cli.rs (init profile args only)}`, `crates/paracord-server/src/main.rs` (logging init L248-260, `init` dispatch L3944-3960, redirect listener L1319-1355, `spawn_auto_backup` L4022-4089 only), `crates/paracord-api/src/routes/{host.rs,host_status.rs}`, `crates/paracord-api/src/routes/admin.rs` (new handlers appended), `crates/paracord-server/tests/host_mode.rs` (new) | S0 | Sonnet | M | B |
| **S7** Desktop host service | Spec §2.2–§2.6, §2.8–§2.10, §9.5 host commands: `crates/paracord-hostctl` (systemd user unit, per-user Scheduled Task XML, LaunchAgent plist; install/start/stop/enable/disable/remove/status; binary install with temp+rename and `.previous`; preflight checks incl. keychain probe and existing-server probe; update procedure) + Tauri `host.rs` commands and `host://progress` events + `hostStore.ts`; unit tests render unit/XML/plist golden files; `hostctl` integration test that installs a uniquely named service (`paracord-host-test-<rand>`) and removes it, **only** inside the S15 container or CI runners (guarded by `PARACORD_HOSTCTL_LIVE=1`) | `crates/paracord-hostctl/**` (new crate, added to workspace members), `Cargo.toml` (members line only), `client/src-tauri/Cargo.toml` (dep on hostctl), `client/src-tauri/src/host.rs`, `client/src-tauri/src/lib.rs` (`generate_handler!` host lines only), `client/src/stores/hostStore.ts` (new), `client/src/lib/host/**` (new) | S6 | Opus | L | C |
| **S8** Sidecar bundling, release, CI service smoke | Spec §2.1: `externalBin`, `stage-host-sidecar.mjs`, `npm run host:stage`, missing-sidecar error, Inno Setup adds the sidecar, release workflow builds `paracord-host` per desktop target before `tauri build` (all three OS jobs), CI jobs `hostctl-smoke-{linux,macos,windows}` running the S7 live integration test on GitHub runners (systemd user session on ubuntu via `loginctl enable-linger runner` + `XDG_RUNTIME_DIR`; `gui/$UID` on macOS; user task on Windows); measure and record the bundle size delta per OS in the checkpoint | `client/src-tauri/tauri.conf.json`, `client/src-tauri/binaries/.gitignore` (new), `client/scripts/stage-host-sidecar.mjs` (new), `client/package.json` (scripts only), `installer/paracord-client.iss`, `.github/workflows/release.yml`, `.github/workflows/ci.yml` (new jobs only) | S6, S7 | Sonnet | M | D |
| **S9** Invite preview, defaults, limits | Spec §6.1–§6.3: preview fields (faces, online count, hue, instance block), invite bucket + miss lockout, contract defaults 604800/25, `InviteModal.tsx` defaults, `lib/inviteLinks.ts` parser (moved from `ServerConnectPage.tsx:42-64` + `portableLinks.ts`), `useAddServer.ts` uses it; tests: preview shape, privacy (no names/ids), rate limits, parser table; live: preview over the live instance | `crates/paracord-api/src/routes/invites.rs` (`get_invite` L292-344 only), `crates/paracord-api/src/lib.rs` (`rate_limit_middleware` bucket only), `crates/paracord-db/src/invites.rs` (faces query), `client/src/lib/{inviteLinks.ts (new),portableLinks.ts}`, `client/src/pages/ServerConnectPage.tsx` (parser import only), `client/src/components/ix/dock/useAddServer.ts`, `client/src/components/guild/InviteModal.tsx` (defaults only), tests | S0 | Sonnet | M | B |
| **S10** Server identity and trust | Spec §7: verifier order with `webpki-roots`, `PIN_MISMATCHES` + `trust://identity-changed`, `probe_server` returns `{fingerprint, ca_verified}`, `trust_server`, `accept_changed_identity`, `trustWords.ts` (+ vectors), `trustedHosts.ts` (`isPinMismatch`, no swallowed errors), `IdentityChangedSheet`, `ServerUnavailable` phase `identity-changed`, connection manager phase plumbing; Rust unit tests for each verifier branch with generated certs (rcgen) and a webpki-valid chain fixture | `client/src-tauri/src/lib.rs` (L371-1007 trust region only), `client/src-tauri/src/trust_cmds.rs`, `client/src-tauri/Cargo.toml` (`webpki-roots`), `client/src/lib/{trustWords.ts (new),trustedHosts.ts}`, `client/src/components/firstRun/IdentityChangedSheet.tsx` (new), `client/src/components/ix/sidebar/ServerUnavailable.tsx`, `client/src/stores/serverConnectionStore.ts` (phase union only), `client/src/lib/connectionManager.ts` (pin-mismatch classification only) | S0 | Opus | M | B |
| **S11** Deep links and clipboard | Spec §6.4–§6.5: Rust pending queue + `take_pending_deep_links`, JS `lib/deepLinks.ts` installed in `main.tsx`, routing to the join step or the Add server Join tab, `tauri-plugin-clipboard-manager` (Rust + JS + capability), `lib/clipboardInvite.ts` (read-on-focus rules), phrase copy auto-clear helper; tests: cold-start queue, running events, unknown link toast, parser reuse | `client/src-tauri/src/lib.rs` (L1675-1709, L1850-1903 only), `client/src-tauri/Cargo.toml` (plugin), `client/src-tauri/capabilities/default.json`, `client/package.json` (deps only), `client/src/main.tsx` (install line only), `client/src/lib/{deepLinks.ts,clipboardInvite.ts}` (new), `client/src/lib/clipboard.ts` | S9 (parser) | Sonnet | S | B (after S9's parser lands; S9 lands the parser first) |
| **S12** Privacy defaults and settings | Spec §1.10 sheet data hooks, §8.2–§8.5: `user_settings.link_previews` read/write (Any-pool booleans), opengraph gating by server config + author setting, client embed hiding, activity default `=== true` + explicit false at sign-up, Settings › Privacy section (Link previews, Show what I'm playing, Ask for my password — the switch UI only; S3 owns its behavior), "What's protected" entry in Settings; `ProtectedSheet` component (shared with first run); tests incl. opengraph not spawned when off | `crates/paracord-api/src/opengraph.rs` (gate only), `crates/paracord-api/src/routes/channels/messages.rs` (L1045-1053 only), `crates/paracord-api/src/routes/users.rs` (settings PATCH field only), `crates/paracord-db/src/users.rs` (settings read/write only), `client/src/components/user/PrivacySection.tsx` (new; mounted from `UserSettings.tsx` with one line in the activity section L1952-2045, which this package owns), `client/src/hooks/useActivityPresence.ts`, `client/src/components/firstRun/ProtectedSheet.tsx` (new), message embed renderer (hide-link-embeds check only) | S0 | Sonnet | M | B |
| **S13a** First-run review harness | Reference renders of the prototype at exact 1280×800 (stage element, `transform:none`) for every state in §5.3 → `output/design-reference/setup/ref/*.png`; `client/e2e/setup-review.config.ts` parameterized by `PARACORD_E2E_SETUP_{SPEC,PORT,RT_PORT,WP}`; a mocked first-run scene (stub Tauri `invoke` for host commands with scripted progress incl. router refused/no answer/shared address, scripted invite previews incl. old server and identity changed); `setup-compare.mjs` side-by-side + mean pixel difference | `client/e2e/setup-*.{ts,mjs}` (new), `client/e2e/fixtures/setup/**` (new), `output/design-reference/setup/ref/**` (new) | S0 | Sonnet | M | B |
| **S13** First-run UI | Spec §1 entire, §2.6 JS side (rows from `hostStore`), §2.11 claim mode (replaces `InstanceSetupPage`), §6.6 web join, §1.14 routes; retire `OnboardingWizard` and `/connect`'s first-run role; preview components from real ix parts; done transition into `AppShell`; every state in §5.3 matched against the S13a references at 1280×800 and checked at 1040×680, 900×700 (single column) and 390×844 (web); real-server e2e `real-server.setup-claim.spec.ts` and `real-server.setup-join.spec.ts` (web flows) | `client/src/pages/firstRun/**`, `client/src/components/firstRun/**` (except S10's and S12's sheets, which it composes), `client/src/stores/firstRunStore.ts`, `client/src/App.tsx` (route table L478-557 only), `client/src/pages/{InstanceSetupPage,ServerConnectPage}.tsx` (retire/redirect), `client/src/components/onboarding/**` (delete), `client/src/pages/InvitePage.tsx`, `client/e2e/real-server.setup-*.spec.ts` (new), `docs/index-spec.md` (§6.14 and §8.1 pointers only) | S13a, S1; integrates S3, S7, S9, S10, S11, S12 as they land | Opus | L | C → D |
| **S14** Installers and docs | Spec §4.2 installer sources (`install.sh` root+systemd → `systemd-creds` with TPM2 when present; non-root → `file`; macOS → `keychain`; `install.ps1` → `keychain` under SYSTEM / `file` non-admin), escrow reminder, `encrypt-storage` offer on upgrade, `auto_port_forward` default yes; Docker README note; docs: `encryption.md` (key hierarchy v2, server-learns table, phrase, at-rest sources), `port-forwarding.md` (states and copy), `getting-started.md` (host from the app), `deployment.md`, `backup-recovery.md` (escrow restore), CI `install-smoke` updates | `scripts/install.sh`, `scripts/install.ps1`, `docker-entrypoint.sh` (comment only), `docs/{encryption,port-forwarding,getting-started,deployment,backup-recovery}.md`, `.github/workflows/ci.yml` (`install-smoke*` jobs only) | S4, S5 | Sonnet | M | D |
| **S15** Fresh-machine gate | §5.4 below: container harness and the end-to-end run; files only under `scripts/fresh-machine/**` and `client/e2e/fresh-machine/**` | those (new) | M3 | Opus | L | E |
| **M1** | Merge wave B; orchestrator: no `not_built` stubs left for B's routes (`rg not_built`), full Rust + client gates, `live-drive` all PASS with S2's server and the old client flows still green | — | B | Opus | S | after B |
| **M2** | Merge wave C (S3, S7, S13 partial) | — | C | Opus | S | after C |
| **M3** | Merge wave D; full CI locally (`cargo test --workspace`, PG job via `docker run postgres:16 -p 55432`, `npm test`, `test:e2e`, `test:e2e:index`, `PARACORD_E2E_REAL=1` suite), `rg not_built` empty | — | D | Opus | S | after D |

### 2.1 Package-specific checks

- **S0:** `cargo test -p paracord-db` on SQLite and on PostgreSQL
  (`docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=pc postgres:16`,
  `PARACORD_TEST_POSTGRES_URL=postgres://postgres:pc@127.0.0.1:55432/postgres`, the variable the CI `postgres` job uses);
  migration applies to a copy of a populated fixture DB (not the owner's).
  `npm run contracts:check`.
- **S1:** vectors pass in Vitest; a jsdom-free timing test logs scrypt time;
  the worker is terminated after use (heap snapshot not required, assert
  `terminate` called).
- **S2:** live: `live-env --port 18440`; probe script creating a v2 account by
  API, signing in, change, reset-by-key, legacy-route refusals; the PG run of
  `credential_routes`.
- **S3:** live (18450): updated `live-drive` all PASS including the three new
  steps; `real-server.session-recovery` and `identity-setup` e2e updated and
  green.
- **S4:** builds `--target x86_64-pc-windows-gnu` (cross, `CLAUDE.md` LAN
  notes) and runs `cargo test -p paracord-server at_rest`; live (18460):
  `live-env` gains `--at-rest` (key via `env` source) and `live-drive` passes on
  an encrypted instance; `encrypt-storage` run on a copy of a populated
  `.live-env-s4` from a plaintext run.
- **S5:** live (18470): run once on this LAN with auto forwarding and attach the
  logged state; no other router changes.
- **S6:** live (18480): `paracord-host` started with the desktop-host profile in
  a scratch root under the worktree (keychain source replaced by `env` via
  `PARACORD_AT_REST_KEY_SOURCE=env` for this check only), `/host/*` exercised
  with and without the token.
- **S7:** golden files; live only in the S15 container (no real session).
- **S9:** live (18490) preview + lockout.
- **S10:** a manual run of the desktop debug build against `live-env` with TLS
  on and a regenerated cert to see the sheet; screenshots.
- **S12:** live (18500): message with a link from a user with previews off has
  no embed; on, has one.
- **S13:** `setup-compare.mjs s13` side-by-sides **read** with the Read tool
  for every §5.3 state; mean pixel difference recorded; motion checked with
  `npm run test:motion`.

### 2.2 Waves

```
A   S0
B   S1  S2  S4  S5  S6  S9 → S11  S10  S12  S13a           (parallel; S11 after S9's parser)
M1
C   S3  S7  S13 (mocked host/credential first, real as M1 lands)
M2
D   S8  S14  S13 (integration with S7/S3/S11, web flows, real-server e2e)
M3
E   S15 fresh-machine gate → fixes routed back to owners → re-run
```

Critical path: S0 → S2 → S3 → S13 integration → M3 → S15. S4 is the longest
single package (SQLCipher on three OS targets); start it first in wave B.

### 2.3 Shared files and their single owners

| File | Owner(s) and region |
|---|---|
| `crates/paracord-server/src/main.rs` | S4 (L291, L1858-1924, CLI dispatch for its subcommands), S5 (L183-189, L421-465, L1120-1200, L3616-3660), S6 (L248-260, L1319-1355, L3944-3960, L4022-4089). Each moves its logic into its own module and leaves a call in `main.rs` |
| `crates/paracord-server/src/config.rs` | S0 only (all fields/defaults/template); later packages request changes through the orchestrator |
| `crates/paracord-api/src/lib.rs` | S0 (route table), S9 (rate-limit bucket) |
| `crates/paracord-api/src/routes/auth.rs` | S2 (legacy refusals, options), S4 (L3286-3294 text) |
| `client/src-tauri/src/lib.rs` | S10 (L371-1007), S11 (L1675-1709, L1850-1903), S7 and S0 (`generate_handler!` lines) |
| `client/src/App.tsx` | S3 (L115-216), S13 (L478-557) |
| `client/src/components/user/UserSettings.tsx` | S3 (account, identity, device security sections), S12 (activity section L1952-2045 + mounting `PrivacySection`) |
| `client/package.json` | S8 (scripts), S11 (deps) |
| `Cargo.toml` (workspace) | S4 (deps), S7 (members) |
| `.github/workflows/ci.yml` | S8 (new jobs), S14 (`install-smoke*`) |

---

## 3. Server work in one place

All new SQL lives in S0's migration. Booleans and timestamps follow
`CLAUDE.md`'s Any-pool rules (bind `bool`; read `CAST(… AS INTEGER)` +
`bool_from_any_row`; TEXT timestamps via `datetime_to_db_text`). No other
package adds a migration; if one is needed, it goes through S0's owner (the
orchestrator) as a second dated file in both directories.

---

## 4. Client work in one place

New code layout per spec §9.6. Every new UI uses Index tokens; first-run
literal values from the prototype become tokens in `styles/globals.css` under a
`--fr-*` group (owned by S13; S13a may read but not add).

---

## 5. Verification

### 5.1 References

- The prototype and its screenshots in `output/design-reference/setup/`.
- S13a renders `ref/*.png` at exact 1280×800.

### 5.2 Ports

| Package | Vite / realtime stub | Real server e2e (`PARACORD_E2E_PORT`) | Live env (`--port`, +1 voice) |
|---|---|---|---|
| S0 | — | — | — |
| S2 | — | 18200 | 18440 |
| S3 | 4943 / 4945 | 18210 | 18450 |
| S4 | — | 18220 | 18460 |
| S5 | — | — | 18470 |
| S6 | — | 18240 | 18480 |
| S9 | 4953 / 4955 | 18260 | 18490 |
| S10 | 4963 / 4965 | — | 18510 |
| S11 | 4973 / 4975 | — | — |
| S12 | 4983 / 4985 | 18280 | 18500 |
| S13a | 4993 / 4995 | — | — |
| S13 | 5003 / 5005 (+ 5013 / 5015 for a second viewport run) | 18290 | 18520 |
| M1–M3 | 5023 / 5025 | 18300 | 18530 |
| S15 | inside containers (§5.4) | — | — |

None collide with existing ones (index 4513–4925, real-server 18150–18173,
live 18420).

### 5.3 States the first run must match

`launch-450ms`, `launch-1150ms`, `welcome`, `welcome-clipboard`, `host-name`
(empty, typed + hue 150), `host-name-blocked` (each preflight reason, one shot
each), `account` (empty, weak, strong, email shown), `host-setup-running`,
`host-setup-done`, `host-setup-refused`, `host-setup-no-answer`,
`host-setup-shared`, `host-setup-fail`, `privacy-sheet` (host, join),
`router-sheet`, `shared-sheet`, `phrase-blurred`, `phrase-revealed`,
`host-invite` (internet, lan), `done-host`, `join-invite` (empty, clipboard,
checking, card, ca-verified, invalid, unreachable, old server),
`identity-changed`, `join-account`, `join-setup-done`, `join-phrase`,
`done-join`, `sign-in` (empty, probed, MFA, legacy move), `claim-mode-setup`
(web, at-rest on and off).

### 5.4 Final gate: fresh-machine simulation (S15)

Goal: from nothing, a person hosts a server from the app, a friend joins from
a second app via invite, they exchange an encrypted DM, and everything survives
an app relaunch and a sign-out/sign-in of the host's computer session.

**Harness (`scripts/fresh-machine/`):**
- Images built from `archlinux:base` (same toolchain as this box, so binaries
  built here run unchanged): `pc-desktop` (systemd as PID 1, a user `sam`
  with lingering off, `dbus`, `gnome-keyring`, `webkit2gtk-4.1`,
  `webkit2gtk-4.1` WebDriver (`WebKitWebDriver`), `tauri-driver` installed
  from crates.io in a build stage, `xorg-server-xvfb`, `pipewire`,
  `pipewire-pulse`, `wireplumber`) and `pc-router` (`miniupnpd` with UPnP IGD
  and NAT-PMP/PCP, `nftables` masquerade between `wan` and `lan`). Run with
  `docker run --privileged --cgroupns=host` (systemd); everything under
  `scripts/fresh-machine/`, no host state touched.
- Networks: `pc-lan` (192.168.50.0/24, router .1, host computer .28) and
  `pc-wan` (203.0.113.0/24, router .1 as the "public" address, friend .77).
- Each desktop container: a systemd user session for `sam` started with
  `machinectl shell`-equivalent (`systemctl start user@1000`) and
  `XDG_RUNTIME_DIR`, gnome-keyring unlocked with a fixed test password, Xvfb on
  `:99`, `GDK_BACKEND=x11`, `LIBGL_ALWAYS_SOFTWARE=1`,
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`, PipeWire with a null sink
  (`pactl load-module module-null-sink`) and a null source. Clean
  `~/.local/share` per run.
- Binaries: the release desktop build (`paracord-desktop` + sidecar staged by
  S8) and nothing else; the harness copies them in.
- Driver: `client/e2e/fresh-machine/run.mjs` using WebdriverIO against
  `tauri-driver` in each container (ports 4444 host-side mapped 14444/14445).

**Scenario (one run, both router modes):**
1. *Host* (`pc-host`, on `pc-lan`): first launch → launch sequence → Host a
   server → name "Friday Night Crew", hue 150 → account Sam/sam/password →
   Setup: rows 1–5 all ok; row 4 says "opened the way" with 203.0.113.1;
   assert the service unit is active (`systemctl --user is-active
   paracord-host`), the DB header is not `SQLite format 3` (encrypted), the
   keychain holds `host-storage-key:<id>`, the escrow file exists, one backup
   exists → phrase (record the words) → invite link equals
   `https://203.0.113.1:8443/invite/<code>` → Open.
2. *Friend* (`pc-friend`, on `pc-wan`): put the link on the clipboard → launch
   → Welcome moves to Join with the banner → Use it → card shows "Friday Night
   Crew", 1 online, and the same four words the host sees in Settings ›
   Paracord on this computer → Continue → account → Setup ok → phrase → Open.
3. Host: `confirmed_at` set ("A friend connected from outside").
4. Friend sends a DM to Sam; Sam reads it; Sam replies; friend reads it.
   Assert via the host's admin DB read (in the container) that the stored body
   is ciphertext.
5. **Relaunch:** kill both desktop apps; relaunch; both reach the DM without a
   password prompt (remembered unlock), history decrypts, new messages flow.
   The host's server stayed up while the app was closed (health checked during
   the gap).
6. **Session restart:** stop `user@1000` on the host container and start it
   again (simulates signing out and in): the service starts, reads the key from
   the keychain (unlocked again by the harness), friend reconnects.
7. **Second device sign-in:** a third container signs in as the friend with
   username + password only and reads the DM history it is entitled to (new
   device: new messages after enrolment; the identity came from the backup).
8. **Router refuses** (second pass with `miniupnpd` deny rules): row 4 warns,
   "Show me how" sheet has `192.168.50.1`, port 8443 and `192.168.50.28`; the
   invite is the LAN link with the amber note; a friend container on `pc-lan`
   joins; after enabling the rule on the router, within 70 s the host's
   Settings shows "opened the way" and the invite updates.
9. **Carrier-grade NAT** (third pass, router WAN 100.64.0.2): row 4 shows the
   shared-address copy; no "reach you" claim anywhere.
10. **Identity change**: regenerate the host's certificate (stop service,
    delete `data/certs`, start) → the friend sees the identity-changed sheet
    with old and new words; "Stay disconnected" keeps it disconnected.

Output: `/tmp/paracord-fresh/<run>/` screenshots per step, `results.json`,
container logs; exit non-zero on any failure. Runtime budget ≤ 20 min.

What it cannot cover (stated in the checkpoint): Windows Scheduled Task and
macOS LaunchAgent behavior (covered by S8's CI smoke jobs and the existing
Windows cross-build), real consumer routers (S5's one LAN observation), GPU
paths.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| SQLCipher with vendored OpenSSL fails on one target (Windows GNU cross, macOS x86_64) or slows CI a lot | S4 starts first in wave B and proves all targets before anything depends on it; if one target cannot build, stop and ask (no shipping without SQLCipher there) |
| Bundling the server grows each desktop package (estimate +30–50 MB) | S8 records the real delta; strip + LTO for `paracord-host`; it is one-time disk, not memory |
| Linux keychain absent or locked (minimal WMs, headless) | Preflight refuses with plain copy (§2.3); exit 78 + UI message when locked later; no file fallback by design |
| macOS keychain prompts after an update changes the binary's signature | Stable path + consistent signing identity; S8 checks an update on the CI macOS runner; documented if Apple still prompts once |
| User-level service does not run before login (Linux lingering off; Windows logon trigger) | Spec says "starts when you sign in to this computer"; the owner's decision "starts with the computer" is met at sign-in, not at boot (keychain constraint) |
| E2EE against a malicious operator now depends on password strength (offline guessing of `auth_key`/backup) | scrypt 128 MiB, 10-char minimum, common-password block, passphrase guidance; documented in encryption.md (spec §10) |
| v1 → v2 move confuses people with two passwords | The move screen names each password; defaults to the encryption password; accounts stay v1 and working until moved |
| A brand-new device can be shown a fake legacy screen by a malicious server | Distinct wording, one-time screen, pins on known devices (spec §3.13) |
| Public IP changes break invite links (no DDNS without a third party) | Live link updates and a plain notice (spec §5.6) |
| Phones opening the https invite get a self-signed certificate warning | Out of scope until mobile apps; the QR and link still work after the warning; copy unchanged |
| Windows Defender/SmartScreen flags the unsigned sidecar | Same signing story as the desktop exe; S8 notes the release signing status |
| Windows firewall needs one UAC prompt | Declining is honest (`firewall_blocked`) and recoverable with **Allow** |
| Router mapping behavior varies widely | State machine depends only on protocol answers; S5 records one real router; S15 covers allow/refuse/CGNAT with miniupnpd |
| Parallel packages collide in `main.rs`, `lib.rs`, `UserSettings.tsx` | Region fences (§2.3); logic moved into new modules; the orchestrator merges in wave order |
| Docker/systemd-in-container flakiness in S15 | Arch images match the host toolchain; `--privileged --cgroupns=host`; the harness retries container boot once and fails loudly after |

---

## 7. Owner questions

Kept to what the spec could not decide; each has the default the build uses
unless the owner says otherwise.

1. **Remembered unlock on desktop.** After sign-in, the desktop app keeps the
   identity private key in the OS keychain so a relaunch needs no password
   (like the session token today); "Ask for my password when Paracord opens" is
   off by default. The stricter alternative asks for the password on every
   launch. **Default: remembered unlock, setting off.**
2. **Existing users' "Show what I'm playing".** The new default is off; users
   who never touched the switch will see it off after the update (those who
   turned it on keep it). The alternative keeps today's behavior for existing
   accounts and applies off only to new ones. **Default: off for everyone who
   never chose, with a release-note line.**
