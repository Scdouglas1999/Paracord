# F2 checkpoint: reachability honesty, deep-link handler, ticket loop

Fixes S15 §4 bugs 3, 4, 6 and 8 (repros in `setup-s15-checkpoint.md`, port
mapping design in `setup-s5-checkpoint.md`).

## Bug 3 (High): a refused UPnP mapping was reported "open"

`portmap.rs` `add_upnp_mapping` treated `AddPortError::PortInUse` (UPnP 718
ConflictInMappingEntry) as "our own entry". It now asks the router's mapping
table and only accepts the conflict when the entry for that outside port and
protocol is enabled, points at this computer's address and the same inside
port. Otherwise the result is a `Refused` failure with the reason in plain
words (another device at `ip:port`; no entry shown, so the router's rules deny
it; or the table could not be read). Every other UPnP error was already a
refusal and never triggers a lookup.

- igd-next 0.17 has no `GetSpecificPortMappingEntry`, so the lookup walks
  `GetGenericPortMappingEntry` by index (up to 512 rows) until the port turns
  up or the table ends. A router that hides its table (606) gives a refusal,
  never a guess.
- No "try the next external port": clients derive the app URL and the media
  port from the single configured number, and the NAT-PMP path already refuses
  a remapped port for that reason. One deterministic path: refuse with the
  reason.
- The UPnP calls sit behind a small private trait (`UpnpControl`, implemented
  by the real gateway) so the logic is tested with a scripted router.

Tests (`portmap::tests`): own entry accepted; another device refused and named;
same address but other inside port refused; disabled entry refused; no entry
refused; unreadable table refused; other UPnP errors refuse without a lookup;
permanent-lease retry still works.

## Bug 4 (Medium): the sheet did not name the router

`MapFailure` gained `gateway_ip` (`via_gateway()`); `establish` carries the
first answering router's address into the combined failure and
`reachability::apply_failure` writes it to `gateway_ip` (it was set to `None`).
UPnP failures after discovery name the control URL host; NAT-PMP/PCP failures
name the gateway only when it sent a result code (a silent default gateway is
not claimed). The existing `Reachability.gateway_ip` contract field and the
`RouterSheet` `gatewayIp` prop already existed, so no contract or generated
type changed (`contracts:check` not needed). The generic "usually 192.168.0.1
or 192.168.1.1" line remains only when no router answered.

Tests: `a_refusal_still_names_the_router_that_answered` (reachability),
`establish_carries_the_answering_routers_address_through`,
`a_failure_remembers_which_router_answered` (portmap), and
`RouterSheet.test.tsx` for both copies.

Not changed (S15 §4.3 "Related", Low): the "opened the ports but would not say
its public address" wording after a failed `GetExternalIPAddress`, and removing
UPnP mappings before falling back to PCP.

## Bug 6 (Medium): `xdg-open paracord://` failed without GNOME/KDE/XFCE

Cause: `tauri-plugin-deep-link`'s `register` writes `Exec="/path/app" %u`, and
`xdg-open`'s generic handler runs `command -v` on the first word with the quotes.
Fix: new `client/src-tauri/src/deep_link_desktop.rs` writes the handler entry
itself (same file name the plugin used, so an old quoted entry is overwritten,
only rewritten when it differs), quoting an argument only when the Desktop Entry
spec requires it (ordinary paths are bare; reserved characters get the spec's
double-layer escaping; `%` becomes `%%`), then runs `update-desktop-database`
and `xdg-mime default` as the plugin did. The AppImage path is used when
present. Windows still uses the plugin's `register_all`.

Shared-file touch (smallest additive change): `client/src-tauri/src/lib.rs`
gets `mod deep_link_desktop;` and the Linux branch of the deep-link
registration call swapped (outside F1's trust region).

Test: `deep_link_desktop::tests` generate the entry and parse its `Exec=` line
with a reader that follows the spec in both layers (key-file escapes, then
argument quoting, then field codes), for plain, spaced, quoted, `$`/backtick,
backslash and `%` paths, and assert the first word of an ordinary path has no
quote.

## Bug 8 (Low): `POST /download/ticket` 401 loop before sign-in

Cause: avatars on the sign-in screen call `subscribeDownloadTicket`, which
mints; the 401 hit the catch, which re-armed the key retry, and the next
`ensureDownloadTicket` reset that retry's backoff (`cancelServerKeyRetry`), so
it ran every ~250 ms plus the round trip.
Fix in `client/src/lib/downloadTicket.ts`: `ensureDownloadTicket` returns
without asking when there is no bearer token (the active remote server's token,
else the home access token), and a 401 records the token it was refused for and
stops retrying until the token changes (or the cache is cleared). Other
failures still retry. `AppProviders` restarts the lifecycle when the active
server's own token arrives or rotates (new `activeServerToken` dependency).

Tests: `downloadTicket.session.test.ts` (no request without a session; one
request and silence for 60 s after a 401; a new token asks again; non-401
failures still retry).

## Gates

See the report with this commit for results: `cargo fmt` on touched files,
`cargo clippy -p paracord-server -p paracord-desktop --all-targets -D warnings`,
`cargo test -p paracord-server`, `cargo test -p paracord-desktop`, client
typecheck, vitest, eslint on touched files (repo-wide lint has 244 existing
warnings, 0 errors).
