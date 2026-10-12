# S5 checkpoint: reachability

Package S5 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §5. Branch `feat/setup`.

The server now holds one truthful `Reachability` value, written only from what
a router answered, kept fresh by a retry/renewal loop, announced to admins, and
read by the invite address. Nothing asks any outside service for this
network's address.

## 1. What was built

### `paracord_core::reachability` (new, `crates/paracord-core/src/reachability.rs`)

- `classify(IpAddr) -> Public | Shared | Unusable` is the spec §5.2 table:
  `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (CGNAT), `169.254/16`,
  IPv6 `fc00::/7` and `fe80::/10` (and IPv4-mapped IPv6) are `Shared`;
  unspecified, loopback, multicast, broadcast, `0/8` and `240/4` are `Unusable`;
  everything else (including the documentation ranges used in tests) is
  `Public`. Table test covers both edges of every range.
- `ReachabilityHub` (process-wide via `hub()`; instantiable for tests): one
  `tokio::sync::watch` of `HubState { reachability, storage?, backups? }`.
  `update(|r| ...)` wakes subscribers only on a real change. It also drops
  `confirmed_at` when the address changes or the state leaves `open`/`direct`,
  and remembers the previous external address across failures (for the "Your
  public address changed" line).
- `record_inbound_connection(peer)` sets `confirmed_at` only when state is
  `open`/`direct`, the peer is `Public`, and it is not this network's own
  external address; refreshed at most once a minute so a busy server does not
  broadcast on every accept.
- `request_retry()` / `retry_requested()`: "Try again" (a request made while
  nothing is waiting is kept for the next wait).
- `set_storage(StorageStatus)` / `set_backups(BackupStatus)` /
  `status_update() -> Option<InstanceStatusUpdate>`: the gateway payload exists
  only once all three parts are known (see section 5, integration points).
- `spawn_status_broadcaster(hub, bus)`: on each change dispatches
  `INSTANCE_STATUS_UPDATE` (global, no recipient list) on the event bus.

### Gateway delivery (admins only)

- `EVENT_INSTANCE_STATUS_UPDATE` in `paracord-models::gateway`.
- `events::requires_instance_admin` / `is_instance_admin`, and
  `can_receive_replayed_event` refuses the event to non-admins. The WS
  delivery loop (`paracord-ws/src/handler.rs`) and the SSE pump
  (`paracord-api/src/routes/realtime.rs`) check at delivery time, so a demoted
  admin stops receiving it and a new admin is covered (no recipient list is
  baked in). Test: `events::tests::instance_status_is_for_admins_only`.

### `paracord_core::share_address` (rewritten around state)

`share_address()` is now computed on every read from `ShareInputs` (recorded
once at startup: `public_url`, local origin, scheme, port) and the hub's current
state: `public_url` wins; loopback is `this_computer`; `open`/`direct` use the
external address; every other state uses the LAN address (`local_network`).
`ShareAddress` gains `previous_url` (serialized only when the address changed
while the server ran) so the Invite screen can say links made earlier stop
working. `set_share_address` is gone. `routes/invites.rs` needed no change.

### `crates/paracord-server/src/portmap.rs` (reworked)

- `Router::map` returns `Result<Mapping, MapFailure>`. `FailureKind::Refused`
  (a gateway answered and said no: UPnP fault, NAT-PMP/PCP result code, or an
  answer that left out its public address) vs `NoAnswer` (timeout, socket
  error, ICMP unreachable). `establish` reports `Refused` if any method was
  refused, `NoAnswer` only if all were silent.
- `Mapping.external_ip` is now mandatory and comes only from the router:
  UPnP `GetExternalIPAddress` (a failure is a refusal, no longer `.ok()`), PCP's
  response, and for NAT-PMP an explicit external-address request
  (`crab_nat::natpmp::external_address`; crab_nat 0.8 does expose it).
  `Mapping.granted` is the lease the router actually granted (renewal is half
  of that, not half of what was asked); `None` for a permanent UPnP entry.
- `with_fallback_ip`, `detect_public_ip_via_http`, `parse_detected_public_ip`
  and `spawn_renewal` are deleted. UPnP drops its cached gateway on any
  failure so a rebooted router is rediscovered.
- NAT-PMP gateway discovery reads the default route from `/proc/net/route` on
  Linux; elsewhere it keeps the previous `.1`-on-the-subnet assumption.
- `Outcome` stays as the banner's vocabulary and gains `Direct { ip }`.

### `crates/paracord-server/src/reachability.rs` (new): the state machine

`spawn(hub, settings, env, routers) -> Handle`.

- `direct` is checked first (the bind interface's own address is public).
- `asking -> open | shared_address | refused | no_answer`. `Unusable` external
  address (e.g. `0.0.0.0`) is `refused` with the reason.
- While `refused`/`no_answer`/`shared_address`/`firewall_blocked`: retry every
  `reachability_retry_seconds` (60). `asking` shows for the first attempt and
  for "Try again"; timer retries keep the last verdict so a closed router does
  not flicker every admin's screen once a minute.
- While `open`: renew against the same router at half the granted lease. A
  failed renewal leaves `open` (so the share address falls back to the LAN
  address, announced), then retries with every method. A changed external IP
  updates state and is remembered as a change.
- Windows host mode (`config.host.enabled`): `netsh advfirewall firewall show
  rule name="Paracord on this computer"` (exit status plus the port number as a
  token; labels are localized so nothing else is parsed). A missing rule
  overrides the state with `firewall_blocked` and is rechecked each retry so
  the **Allow** chip's fix is picked up. A check that cannot run is logged, not
  taken as a verdict.
- `Handle::release()` stops the loop and unmaps exactly the routers that may
  hold a mapping (tracked from the moment `map` was asked, so a request
  cancelled mid-flight is still cleaned up). `first_attempt()` waits for the
  first verdict.
- `ObservingAcceptor` wraps the TLS acceptor: a connection that completes its
  handshake is shown to the hub (`confirmed_at`). A scanner that opens a socket
  and leaves does not count.

### `main.rs` (S5 regions only)

The supervisor starts at the old portmap spot (the discovery budget still
overlaps migrations). The first verdict is awaited **before** TLS setup, so
`tls::ensure_certs` gets the router-reported public address for the
certificate's SANs (only when `open`/`direct`; `tls.rs` itself is unchanged).
The ipify call, its constants and `with_fallback_ip` are gone; LiveKit's
managed-start now receives no external IP (LiveKit is dormant). Shutdown calls
`Handle::release()`. `share_address_for` is deleted in favor of
`ShareInputs`. The status broadcaster is spawned right after the member index
is attached to the bus. A source-scan test
(`no_third_party_address_lookup_remains_in_the_server`) fails if any
third-party address-lookup host name returns to `crates/paracord-server/src`.

### Wiring S6's seams

`crates/paracord-api/src/routes/host_status.rs` (S6's file, small edit as asked
by the coordinator): `seams::reachability` returns `hub().current()` (port
filled from the bind address only when the hub never initialized, i.e. the API
test harness) and `seams::request_reachability_retry` calls
`hub().request_retry()`. When state is `off` the retry answers **409** rather
than 202 (nothing is asking a router; accepting would be a silent no-op).
`tests/host_control.rs`: the combined 501 row is split; the escrow row keeps
its `not_built` assertion (S4), the retry row now asserts the 409.

## 2. Files

Created: `crates/paracord-core/src/reachability.rs`,
`crates/paracord-server/src/reachability.rs`,
`crates/paracord-server/src/reachability/tests.rs`.

Edited (S5 regions): `crates/paracord-server/src/{portmap.rs,main.rs}`,
`crates/paracord-core/src/{share_address.rs,lib.rs (one `pub mod` line),events.rs}`,
`crates/paracord-models/src/gateway.rs` (one constant),
`crates/paracord-ws/src/handler.rs` (one admin gate),
`crates/paracord-api/src/routes/{host_status.rs,realtime.rs (the same gate on the SSE path)}`,
`crates/paracord-api/tests/host_control.rs`.

Outside the plan's file list, each as small and additive as possible:
`paracord-models/gateway.rs`, `paracord-core/events.rs`,
`paracord-api/routes/realtime.rs`, `paracord-api/routes/host_status.rs` and its
test. `tls.rs` and `router_access.rs` needed no change.

## 3. Gates

- `cargo test -p paracord-core --lib` reachability / share_address / events:
  29 pass. `cargo test -p paracord-server --bin paracord-server -- reachability:: portmap::`:
  30 pass (run 5 times, stable, 0.4 s each). The state tests use fake `Router`
  impls for: public (`open`), every private/CGNAT/link-local class
  (`shared_address`), `0.0.0.0` (`refused`), refusal vs silence, `direct`,
  `firewall_blocked` over both open and direct, retry on the interval, "Try
  again" with an hour-long interval, renewal that stays open without passing
  through `asking`, failed renewal then recovery (with the share address
  falling back to the LAN), a changed address on renewal, release unmapping
  only the router that holds the mapping, and release during an unfinished
  request.
- `cargo clippy -p paracord-core -p paracord-ws -p paracord-models -p
  paracord-server --all-targets -- -D warnings`: nothing from S5 files. The
  only remaining error is S4's `at_rest_boot.rs:1071` test
  (`field_reassign_with_default`), which is not mine.
- `cargo check -p paracord-server --bin paracord-server --target
  x86_64-pc-windows-gnu` finished without errors (covers `WindowsFirewall`).
- rustfmt applied to the files S5 owns outright. `main.rs` was not
  reformatted as a whole (other packages' hunks are in it); S5's hunks were
  formatted by hand to rustfmt style.

## 4. The live check (this LAN, 18470, read-only)

Ran a debug `paracord-server` bound to `0.0.0.0:18470` (TCP 18470, UDP
`PARACORD_VOICE_PORT=18471`, **not** 8443, so nothing could collide with the
LAN server's mapping), TLS off, `PARACORD_AUTO_PORT_FORWARD=true`,
retry 20 s, for 75 s in `.live-env-s5` (deleted afterwards).

What this router (192.168.1.1) reports: **nothing, on any protocol.** Before
and after the run, a raw NAT-PMP external-address request to 192.168.1.1:5351
got no reply, a PCP ANNOUNCE got no reply, and a UPnP SSDP M-SEARCH for an
Internet Gateway Device (from 192.168.1.20) got no reply. The server logged,
at start and on each retry (about every 24 s: 20 s wait plus the 4 s attempt):

```
WARN reachability state=NoAnswer external_ip="-" reason="UPnP: no UPnP router
 answered (No response within timeout); NAT-PMP/PCP: the router did not answer
 for TCP 18470 (PCP(UDP socket error: Connection refused (os error 111)))"
 next_retry_at="..."
Friends outside your network:  Not yet — your router needs one setting changed
```

That is the correct verdict for a router with UPnP, NAT-PMP and PCP all off:
`no_answer`, no external IP claimed, the retry loop firing, banner honest
about it. (The ICMP "connection refused" from the router's PCP port is
classified as no answer: it means nothing listens there.)

Mapping release: nothing was ever mapped, so there was nothing to release; the
router showed no UPnP/NAT-PMP/PCP service before or after, and the process
exited. The owner's installed server (pid under `~/.local/share/paracord`) and
the LAN server were not touched. The release path itself is covered by the
fake-router tests above, not by a real router.

Not observed live, and why: a router that actually answers (`open`, `refused`,
`shared_address`, the NAT-PMP external-address request and the PCP/NAT-PMP
protocol label). This router offers none of the three. S15's miniupnpd
containers are the real-protocol check for those; until then the NAT-PMP
external-address glue in `NatPmpRouter::map` (choosing `pcp` vs `nat-pmp`,
calling `natpmp::external_address`) has only been compiled, not exercised
against packets.

## 5. Integration points and open items

1. **`INSTANCE_STATUS_UPDATE` needs storage and backups.** The contract
   payload requires all three parts. S5 owns reachability only, so
   `status_update()` returns `None` (nothing is sent) until
   `hub().set_storage(..)` and `hub().set_backups(..)` have been called.
   **S4 must call `set_storage` (and again whenever it changes) and S6 must
   call `set_backups`** at startup and after each backup/toggle; the
   broadcaster then announces any change in any of the three. Sending guessed
   storage/backup values would have been a claim the server cannot back.
2. **`docs/port-forwarding.md` still tells people to open `ifconfig.me`**
   (lines 119, 141, 146). It is S14's file; the third-party mention should go
   there. (The server banner's own `ifconfig.me` line was reworded to "its
   status page shows it".)
3. **No ISP-change line in the UI yet.** The data exists
   (`ShareAddress.previous_url` on `GET /instance/share-address`); showing "Your
   public address changed. Links you shared before won't work; share this one."
   is the Invite screen's (S9/S13).
4. **`confirmed_at` observes the TLS path only**, as specified. A server with
   TLS off (HTTP only) never confirms; only the desktop-host profile (TLS on)
   is the target.
5. The 60 s retry floor in `main.rs` is `reachability_retry_seconds.max(5)`.
6. A mapped router that grants a shorter lease than asked is now renewed at
   half the granted lease (previously half of the asked lease), which is a
   behavior change for routers that cap leases.
7. Plain-HTTP and other-protocol `PARACORD_VOICE_PORT` mapping behavior is
   unchanged: two entries per attempt (TCP app port, UDP media port).
