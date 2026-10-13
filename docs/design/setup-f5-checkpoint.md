# Setup fix F5: final small fixes

Fix package F5 of the first-run setup program. Closes the open items of
[`setup-f4-checkpoint.md`](setup-f4-checkpoint.md) (3, 4, 2) and
[`setup-f1-checkpoint.md`](setup-f1-checkpoint.md) (composer notice).

## 1. After "Remove from this computer", the server leaves the app

`client/src/lib/host/afterRemove.ts` `leaveRemovedHost(hostUrl)` runs after
`host_remove` succeeds (`HostSettingsSection`, `hostUrl` read from `host_info`
before the removal):

- Saved entries on the host's `127.0.0.1` origin are removed (tokens, connection
  state) through the new `connectionManager.dropServer(id)` (disconnect plus
  forget the phase), so nothing is left as "unavailable".
- If the host was the home server (stored address), the home connection is
  dropped, the stored address becomes another saved server's (or is cleared) and
  the home session is signed out (`authStore.logout()`).
- No saved server left: first-run store reset and `navigate('/welcome')`.
  Otherwise the first remaining server becomes active and Settings closes.
- A session on some other server is left alone (`unchanged`).

Tests: `afterRemove.test.ts` (4 cases: only server, entry plus another server,
unrelated session, entry-only host); e2e "Remove that was the app's only
server" (stored address is the host, ends on `/welcome`, address cleared).

## 2. "What's protected" above Settings

`ProtectedSheet` takes the optional `zIndexClassName`; Settings › Privacy passes
`z-[160]` (the first run is unchanged). e2e asserts the sheet's own row is what
a point at its center reaches. Screenshot:
`output/design-reference/setup-build/f5/protected-sheet.png`.

## 3. "Port {port} is in use by another program."

`paracord-hostctl` (`host.rs`): `HostParts.port_free` (injectable; the system
one is `preflight::port_bindable`). While the service is not running or
starting and the port cannot be bound, `Host::start` refuses before asking the
service manager, and a start that times out re-checks; both fail with code
`port_in_use` and the spec's sentence. `HostInfo.port_problem` (new, serde
default) carries the same sentence for Settings. A running or starting service
is never blamed for its own port. Setup row 1 shows the failure detail, so setup
says it too. Settings: `serviceView` shows it as "Can't start" with that reason.

Tests (fake port probe, no service, no real socket): the taken port is named by
`start` and `info`, the service manager is never asked to start, it clears when
the port frees; a running server is not blamed. Client: `settingsView.test.ts`,
e2e "another program holds the port" (`fixtures/setup/tauriHost.ts` gained
`portProblem`). No contract change.

## 4. Composer notice while a server is identity-changed

`composerNoticeSuppressed(reason, identityHeld)` (`messagingReadiness.ts`,
`RECOVERY_WAIT_REASON`): `MessageInput` hides "Wait for this account's
authenticated message recovery before sending." (and the same text as a submit
error) while `useServerConnectionStore` holds that server at `identity-changed`.
Other refusals still show. Unit-tested; the identity strip says why.

## Gates

| Gate | Result |
|---|---|
| `host:stage -- --placeholder`, `cargo fmt --all -- --check` | ok |
| `cargo clippy -p paracord-hostctl -p paracord-desktop --all-targets -D warnings` | clean |
| `cargo test -p paracord-hostctl` | 61 + 5 + 1 + 2 pass |
| `cargo test -p paracord-desktop --lib` | 209 passed, 2 ignored |
| `npm test` (typecheck, unit, tokens, motion-lint) | 493 files, 4901 passed |
| `npm run lint` | 0 errors (249 warnings, none new in touched files) |
| `test:a11y:static`, `test:contrast` | pass |
| `setup-f4-host-settings` (5043/5045) | 23 passed (3 new) |
| `setup-s13` (5003/5005) | 34 passed |
| `index-identity-changed` (4963/4965) | 2 passed |

A stale `paracord-contracts` artifact in the shared target made one desktop
build report a missing `owner_public_key`; touching the contracts crate rebuilt
it. Source was fine.

## Deviations and open issues

- Signing out of the removed home server calls `authStore.logout()`, which
  makes its usual best-effort request to the now-gone server and resets the
  session stores; saved servers' tokens survive and reconnect.
- The composer suppression has no e2e (unit only).
- The removed-welcome screenshot caught the lazy chunk's splash; the e2e
  asserts the `/welcome` URL.
