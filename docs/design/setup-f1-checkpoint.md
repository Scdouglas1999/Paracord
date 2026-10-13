# F1 checkpoint: the host's own server is trusted by its certificate; identity changes on the first-run server

Fix package F1 of the first-run setup program, for bugs 4.1 and 4.2 of
[`setup-s15-checkpoint.md`](setup-s15-checkpoint.md) §4. Branch `setup-fix`.

## 1. Bug 4.1: the native trust dialog asked about the host's own server

**Cause.** Row 3 (and Sign in after a restore) talks to
`https://127.0.0.1:<port>` through `native_fetch`, whose origin must be in
`TRUSTED_SERVER_ORIGINS`. The only way in was `update_trusted_server_hosts`,
which asks the native "Trust new Paracord instance?" dialog for every origin
not approved before. Nothing approved the host's own origin, so the dialog
raced row 3 (8 s recheck wait) and the restore's sign-in probe.

**Fix (desktop shell).**

- `client/src-tauri/src/host.rs`: `own_server_in(app_local_data_dir)` /
  `own_server(app)` read, fresh on every call, `host.json` (enabled + port),
  the active config (`HostState::config_path`, so a restore's recovered
  generation is used), and the certificate file its `[tls] cert_path` names
  (`paracord_hostctl::control::first_certificate_der`, the same reader the
  control client pins with). Result: `OwnServer { origin:
  "https://127.0.0.1:<port>", fingerprint: Result<[u8; 32], reason> }`, or
  `None` when this computer does not host.
- `client/src-tauri/src/lib.rs` (trust region), `update_trusted_server_hosts`:
  for the listed origin that equals the host's own origin, and only that one,
  the dialog is skipped and the origin is decided by its certificate:
  `probe_own_server` GETs `/health` on a client of its own with an
  `IdentityObserver` and `own_server_verdict` compares the presented leaf with
  the fingerprint on disk. Same certificate + Paracord's `/health` → trusted;
  another certificate (something else holds the port) or not Paracord →
  refused, without asking; no answer → keeps what it had
  (`trust_after_probe`). A hosting computer whose certificate cannot be read
  refuses that origin with a logged reason and still never asks.
  Nothing is persisted (no approval, no pin file entry): each sync re-reads the
  certificate, so setup, a restore (new certificate by design) and launch
  supervision always use the current one.
- Unchanged: every other origin, loopback included (another port, `localhost`,
  `http://`), still goes through the dialog on first contact; the verifier's
  order (§7.2) is untouched; `probe_server` still refuses an untrusted loopback
  target.

**Fix (renderer).** `lib/trustedHosts.ts` `probeServerIdentity`: a probe the
shell refused for want of a check ("not in the trusted server list") asks
`recheckTrust()` once and probes again, as the desktop HTTP adapter does. That
is the restore's Sign in: the stored home URL is in the trust source, the
recheck sync trusts it by its certificate, and the probe succeeds instead of
"Can't reach 127.0.0.1".

## 2. Bug 4.2: a certificate change on the first-run server never showed identity-changed

**Cause.** The server joined (or hosted) through the first run is the home
server, `__local__`: no `serverListStore` entry, the home session's token.
`connectionManager` excluded it from the identity-change classification
(`conn.serverId !== LOCAL_SERVER_ID && …`), `setServerPhase` dropped every
phase for it, and the banner and sidebar only read listed servers. At launch
the home refresh is refused by the pin, the token is null and the guard
redirected to `/login`.

**Fix.**

- `lib/connectionManager.ts`
  - The realtime setup failure that is a pin mismatch (or for a host with a
    recorded change) now goes to `noteIdentityChanged` for the home server too.
  - `setServerPhase(__local__)` records `identity-changed` (and nothing else;
    any other phase clears it). `noteIdentityChanged` sets the phase before
    dropping the connection (so no recovery is scheduled), clears "the instance
    is restarting", and loads the shell's record (`loadIdentityChange`) for a
    page that missed the announcement.
  - `connectLocal` holds while the phase is `identity-changed` and the change
    is still recorded (`homeIdentityHeld`); once `accept_changed_identity`
    cleared it the hold ends and the home server connects. The reconcile in
    `connectAll` keeps the home phase; the auto-recovery timer ignores held
    servers.
- `components/ix/session/ServerSessionBanner.tsx`: the home server gets the
  same strip ("{address} has a new identity. It stays disconnected until you
  review it." + Review → `IdentityChangedSheet`; Trust → `retryServer`, which
  re-syncs trust and reconnects).
- `components/ConnectionStatusBar.tsx`: no "Connection lost, retrying
  automatically" while a server is held for an identity change (nothing retries
  it; the identity strip says what happened).
- Launch: `stores/authStore.ts` `initializeSession`, on a pin-mismatch refusal
  of the refresh, keeps the refresh token (as before) and loads the shell's
  record for the stored home URL before the guards look.
  `App.tsx` `ProtectedRoute` (one additive check after the keychain splash):
  no session + a recorded change for the home server →
  `components/ix/session/HomeIdentityChanged.tsx` (new): "{address} has a new
  identity / It stays disconnected until you review it." + Review → the sheet.
  Stay disconnected holds on that screen; Trust re-pins (`accept_changed_identity`),
  re-syncs trust (`resyncTrust`, new in `trustedHosts.ts`, ignores the recheck
  cooldown), runs session bootstrap again behind "Restoring session…" and
  connects.

Saved (listed) servers behave exactly as before.

## 3. Tests and gates

| Gate | Result |
|---|---|
| `npm run host:stage -- --placeholder` | done before cargo |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` | clean |
| `cargo test -p paracord-desktop --lib` | 209 passed, 2 ignored |
| `npm run typecheck` | clean |
| `npx vitest run` (whole suite) | 492 files, 4894 tests passed |
| eslint on touched files | 0 errors (3 pre-existing warnings in `ConnectionStatusBar.tsx` effects) |
| `test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast` | pass |
| `index-identity-changed.spec.ts` (Vite 4963 / RT 4965, WP `f1`) | 2 passed (existing + new) |

New tests:

- Rust `host::tests`: the hosted origin and the certificate on disk; a restore
  reads the recovered config's certificate; no host / removed host → `None`;
  a missing certificate names the reason.
- Rust `sticky_trust_tests`: `own_server_decision` (only the exact hosted
  origin; other loopback ports, `http://`, `localhost`, remote → the usual
  path; unreadable → refused); `own_server_verdict` table; over real TLS
  (rustls server with an rcgen certificate on loopback): the installed
  certificate verifies, another certificate on the port is refused, the right
  certificate on something that is not Paracord is refused, a closed port is no
  answer.
- `connectionManager.reconnect.test.ts`: the first-run (home) server's stream
  setup refused for a pin mismatch → `identity-changed`, nothing retried for
  120 s or on a reconcile, session untouched; a connected home server whose
  restart comes back with another certificate → `identity-changed`, the
  restart flag cleared, held on reconcile, and after the change is accepted
  `retryServer(__local__)` reconnects.
- `session.test.tsx`: the home server's identity strip and sheet.
- `HomeIdentityChanged.test.tsx`: the launch screen names the server, Stay
  disconnected holds with nothing asked; Trust re-pins, restores the session,
  connects, and the guard lets the app open.
- `authStore.test.ts`: a pin-mismatch refusal at bootstrap loads the record and
  keeps the credential; another failure does not look for one.
- `trustedHosts.identity.test.ts`: a refused probe re-checks once and probes
  again; any other refusal is not retried.
- e2e `index-identity-changed.spec.ts` new case: the scene's own server (the
  home server) drops its stream with a recorded change and refused setups:
  banner, no "Connection lost" strip, no setup retries, sheet with both word
  sets, Stay disconnected holds.

Screenshots (read): `output/design-reference/index-build/f1/`
`identity-changed-home-banner.png`, `identity-changed-home-sheet.png` (plus
the existing case's three shots re-rendered under `f1`).

## 4. Deviations and notes

1. Files outside a strict trust region, all additive: `App.tsx` (one guard
   check + import), `stores/authStore.ts` (the pin-mismatch branch),
   `components/ConnectionStatusBar.tsx` (the held condition), and the new
   `components/ix/session/HomeIdentityChanged.tsx`.
2. The host's own origin is decided per sync from disk instead of being
   registered by the host commands: launch supervision (`host_on_launch`) runs
   concurrently with the app's first trust sync, and reading at sync time has
   no race. The commands still own what is on disk.
3. Not live-checked against a real hosted install on this machine (a real user
   service is not allowed here). The S15 container lab is the place to re-run
   bugs 4.1 and 4.2 end to end.

## 5. Open

- While the home server is held, the conversation shows the messaging
  pipeline's "Wait for this account's authenticated message recovery before
  sending." notice (seen in the e2e shot). True, but the identity strip is the
  explanation; a later pass could let that notice defer to it.
- `connectionManager.reconnect.test.ts` "retries a server that is unreachable
  at launch…" failed once in five runs on a jitter boundary (1590 vs ≥1595);
  pre-existing, unrelated.
