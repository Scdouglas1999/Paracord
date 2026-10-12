# S10 checkpoint: server identity and trust

Package S10 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §7 (and the §9.5 trust commands). Branch
`feat/setup`.

## 1. What changed

### Desktop shell (`client/src-tauri`)

**Verifier order** (`TofuPinningVerifier`, `lib.rs` trust region). The pure
decision is `decide_server_cert`; the verifier wraps it:

1. loopback → accept (unchanged; the leaf is still observed for a caller that
   asked);
2. the chain validates against `webpki-roots` for the server name
   (`rustls::client::WebPkiServerVerifier`) → accept, record the host in
   `PUBLIC_CHAIN_HOSTS` (no pin);
3. pinned and equal → accept;
4. pinned and different → refuse with `PIN_MISMATCH_MESSAGE`, record
   `{ pinned, presented }` in `PIN_MISMATCHES`, emit
   `trust://identity-changed { host, pinned_fp, presented_fp }` once per host and
   presented certificate per run (`ANNOUNCED_MISMATCHES`);
5. not pinned → record observed (unchanged).

The verifier takes its root store as an argument (`public_root_store()` in
production, a test CA in unit tests) and an optional `IdentityObserver` that
receives `{ fingerprint, ca_verified }` for each accepted handshake.

**`update_trusted_server_hosts`** returns `Result<(), String>`: a list over 100
servers or a TLS client that cannot be built is an error the renderer reports
(it used to return silently). A host whose chain is public is never pinned and
never asks the native dialog again; a saved server whose pin disappeared is
re-approved through the native dialog after the probe (it used to be before),
because a public-chain server has no pin to lose and must not ask.

**`probe_server`** answers the `/health` object plus `fingerprint` (hex, `null`
over plain HTTP) and `ca_verified`, from a client of its own
(`observe_server`) so the handshake is never skipped by a pooled connection. A
server not trusted yet may be probed only over HTTPS and off this machine
(`is_first_contact_target`): the invite card's first contact. Loopback stays
behind the native dialog.

**Commands** (`trust_cmds.rs`, replacing S0's stubs):

| Command | Does |
|---|---|
| `trust_server({ url, fingerprint })` | HTTPS only. Under the trust lock, a fresh handshake to `/health`; refuses unless the body is Paracord's and the presented leaf equals `fingerprint` ("This server's identity changed while you were looking at it."). Pins it (unless public chain or loopback), approves the origin (so the native dialog does not ask again), commits it trusted; every persist failure rolls back. |
| `accept_changed_identity({ host, presentedFp })` | Re-pins only to the recorded mismatch's `presented`; persists (rolls back on failure); clears the mismatch, the run's public-chain mark and any observed leaf. Refusals: no change recorded, or "changed again while you were looking at it". |
| `pending_identity_change({ host })` | **New, not in §9.5.** The recorded change for a host, or `null`. A webview that reloads misses the once-per-run event; the sheet reads the record instead. |

`ensure_native_fetch_target_is_trusted` (outside the L371-1007 region, additive)
answers `TLS certificate pin mismatch for <host>` instead of "not in the trusted
server list" for a host with a recorded change, and `map_reqwest_error` (same)
surfaces the verifier's refusal from deep in reqwest's error chain. Both are what
the renderer's `isPinMismatch` reads.

`Cargo.toml`: `webpki-roots = "1"` (already in the graph via reqwest), dev-dep
`rcgen` (workspace). `setup` calls `trust_cmds::remember_app` beside
`load_pinned_certs`; `generate_handler!` gains `pending_identity_change`.

### Renderer (`client/src`)

- `lib/trustWords.ts` (new): §7.1 exactly; `trustWords(fpHex)`,
  `formatTrustWords`, `trustWordsText`. `fp` is the 32 raw bytes of the
  fingerprint. `lib/trustWords.vectors.json`: five vectors computed with Python
  `hashlib`, independently of the TS code.
- `lib/trustedHosts.ts`: no swallowed errors (a failed sync is logged with
  `console.error` and rethrown; `trustSettled()` still settles); the
  identity-change listener is registered before the first `update_trusted_server_hosts`
  call so no announcement is missed; `isPinMismatch(err)` (string, Error,
  AxiosError, one `cause` deep); `useIdentityChangeStore` (by pin host);
  `identityChangeFor`, `loadIdentityChange` (store, then the shell record),
  `pinHostFromUrl`, `probeServerIdentity`, `trustServer`, `acceptChangedIdentity`.
  S13's invite card and sign-in trust row call `probeServerIdentity` +
  `trustWords` + `trustServer`.
- `stores/serverConnectionStore.ts`: phase `identity-changed`.
- `lib/connectionManager.ts`: a connect failure or a realtime-stream setup
  failure that is a pin mismatch (or for a host with a recorded change) goes to
  `noteIdentityChanged`: the connection is dropped, no retry timer, phase
  `identity-changed`, and the app-wide "instance is restarting" flag is cleared
  (the restart is over: the server answered, with another certificate). A later
  `connectServer` does not flash "Connecting…" while the change is unaccepted.
- `components/firstRun/IdentityChangedSheet.tsx` (+ `identityChangedSheet.css`):
  the §7.4 sheet in the §6.12 dialog style (`ix-dialog*`, `alertdialog`):
  title "{server} has a new identity", the spec body with both word sets in
  bold, **Stay disconnected** (cream, default focus: first in DOM, drawn
  rightmost with `row-reverse`) and **Trust the new identity** (`WideControl`
  danger). Under 480px the two stack full width. Props:
  `{ open, serverName, serverUrl, onClose, onTrusted }`; refusals show in the
  dialog's error line.
- `components/ix/sidebar/ServerUnavailable.tsx`: state `identity-changed`:
  "Identity changed. {name} stays disconnected until you review it." + **Review**
  (opens the sheet; trusting reconnects through `gateway.retryServer`).
- `components/ix/session/ServerSessionBanner.tsx` (**outside the plan's file
  list, additive**): a strip "{name} has a new identity. It stays disconnected
  until you review it." with Review, beside the signed-out strip. Found in the
  live run: when the certificate changes while the app is connected, the
  server's places stay in the stores, so `ServerUnavailable` never draws and the
  only thing on screen was "The instance is restarting. You'll reconnect
  automatically.", which was false.

## 2. Commands and results

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean for `client/src-tauri` (other packages' files have pending diffs) |
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` | clean |
| `cargo clippy --workspace -- -D warnings` | clean |
| `cargo test -p paracord-desktop --lib` | 194 passed (15 new in `trust_cmds::tests`: each verifier branch with rcgen certificates, a CA-signed chain, a chain for the wrong name, the CA→self-signed downgrade, announce-once, accept/trust checks, probe answer, first-contact targets, the fetch gate's message) |
| `npm run typecheck` | clean |
| `npm run test:unit` | 472 files, 4795 tests passed |
| `npm run lint` | 0 errors; no warnings in S10 files |
| `npm run test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast` | pass |
| `index-identity-changed.spec.ts` (new, Vite 4963 / RT 4965) | pass |

New and changed tests: `lib/trustWords.test.ts`, `lib/trustedHosts.identity.test.ts`,
`components/firstRun/IdentityChangedSheet.test.tsx`, an identity-changed case in
`ServerUnavailable.test.tsx`, `session.test.tsx` and
`connectionManager.reconnect.test.ts` (a mismatching server is `identity-changed`,
not retried, credential untouched); `trustedHosts.test.ts`,
`trustedHosts.recheck.test.ts` and the reconnect test mock
`@tauri-apps/api/event` now that the sync listens first.

### Live check (desktop debug build, TLS, regenerated certificate)

A Paracord server with TLS on `172.17.0.1:18510` (docker bridge, not the LAN;
data in `.live-env-s10`, deleted), the desktop debug build under Xvfb `:210`
with `GDK_GL=disable GDK_BACKEND=x11`, its own HOME/XDG dirs and its own D-Bus
session (no access to the owner's keyring), no audio server. Driven with
xdotool:

1. Join by address → native "Trust new Paracord instance?" → pinned
   `da0ea5cc…` (equal to `openssl x509 -fingerprint`), signed in, Lantern shown.
2. Server stopped, certificate deleted, restarted (`c9c95a6a…`); app relaunched:
   sidebar "Identity changed" + banner; Review shows **purity · undo · crouch ·
   bread** → **march · sail · immune · report** (both match Python's words for
   the two real fingerprints); Trust → pin file now `c9c95a6a…`, reconnected.
3. Certificate regenerated while connected (`5e98…`, then `ceb92b5d…`): while
   the server was down the phase was `retrying` (connection refused is not a
   mismatch); once it answered, `identity-changed`, the restart banner replaced
   by the identity strip; Enter on the sheet = Stay disconnected, held for 40 s
   with no reconnect; Trust → re-pinned and reconnected.

## 3. Screenshots (read)

`output/design-reference/index-build/s10/`:
`identity-changed-sidebar.png`, `identity-changed-sheet.png`,
`identity-changed-sheet@390x844.png` (e2e, 1280×800 and phone);
`live-launch-sidebar.png`, `live-launch-banner.png`, `live-launch-sheet.png`,
`live-after-trust.png`, `live-in-session-banner.png`,
`live-in-session-sheet.png`, `live-in-session-after-trust.png` (desktop build).
The e2e shots carry an unrelated "invalid UserSettingsResponse" toast from the
mocked scene against S12's contract change.

## 4. Differences from the spec

1. `pending_identity_change(host)` is an extra command (§9.5 does not list it):
   the event is once per run and a reloaded webview would otherwise have nothing
   to show in the sheet.
2. "Once per host per run" is once per host **and presented certificate**: a
   host that moves on to a third certificate is announced again, so the sheet
   never offers to trust a fingerprint the shell would refuse. Accepting a change
   resets the host's announcements.
3. A host whose chain was public earlier in the run and now presents a chain no
   public authority signed is treated as an identity change (its last public leaf
   as "pinned"), not as a first use. Without this, a CA host (which has no pin)
   could be silently TOFU-accepted mid-session with a self-signed certificate.
   Across a restart the mark is gone (in memory only), so such a host goes
   through the native dialog like a lost pin.
4. A public chain wins over a stale pin, as §7.2 orders it; the pin is left in
   place.
5. The identity-changed banner (§1 above), not in the spec.

## 5. Left for others / open

- S13 wires the invite card and sign-in trust row to `probeServerIdentity`,
  `trustWords` and `trustServer`, and composes `IdentityChangedSheet` where a
  first-run probe hits a pin mismatch (`isPinMismatch`). `trust_server` and the
  first-contact `probe_server` path are unit-tested and share `observe_server`
  with the live-checked path, but no UI calls them yet.
- The host's own words (`HostStatus.tls.fingerprint_sha256` → `trustWords`) are
  S13's (and Admin › Settings for headless admins).
- `ServerConnectPage` still calls `probe_server` and reads only `service`/`name`;
  the new fields are ignored there until S13 retires it.
