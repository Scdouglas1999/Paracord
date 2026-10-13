# S15 checkpoint: the fresh-machine gate

Package S15 of [`setup-plan.md`](setup-plan.md) §5.4. Branch `feat/setup` at
`c3559472` (the binaries under test were built from a `git archive` snapshot
of that commit, so M3's uncommitted work in the tree is not in them).

**Result: 76 of 84 checks pass; 3 of 8 scenarios pass outright (S3, S6, S8).
All 8 failing checks are product bugs, listed in §4 with repros. None is in
the harness.** Run time 502 s.

Nothing on this machine was touched: no service, keychain, router, display or
audio device of the owner's. Every container, network and volume is labeled
`paracord-fresh=1` and was removed at the end (0 containers, 0 `pcfm-*`
networks left; the containers had no volumes).

## 1. The harness

| Piece | Where |
|---|---|
| "Computer" image: `archlinux:latest`, systemd as PID 1, user `sam` (uid 1000, lingering off), logind, gnome-keyring, WebKitGTK 4.1 + `WebKitWebDriver`, Xvfb `:99`, PipeWire + pipewire-pulse with null sink/source only (ALSA/BlueZ/V4L2 monitors off), xdotool, sqlcipher | `scripts/fresh-machine/desktop/{Dockerfile,units/*}` |
| In-container helper (sign in/out, driver, screenshots, X input, keychain, DB checks) | `scripts/fresh-machine/desktop/pc.sh` (→ `/usr/local/bin/pc`) |
| Router image: NAT between a lan and a wan network, miniupnpd 2.3.9 (UPnP IGD + NAT-PMP + PCP) built with its **nftables** backend, modes `allow` / `deny` / `deny-noupnp` / `off` | `scripts/fresh-machine/router/{Dockerfile,router-start.sh,router-ctl.sh,lab-patch.py}` |
| Build of what gets installed: `npm run build`, `npm run host:stage -- --release`, `npx tauri build --no-bundle`, copy `paracord-desktop` + `paracord-host` + `tauri-driver` | `scripts/fresh-machine/build.sh <out> [<source>]` |
| Lab (networks, containers, router modes, teardown) | `client/e2e/fresh-machine/lab.mjs` |
| W3C WebDriver client (no new dependency) and page helpers | `client/e2e/fresh-machine/{wd.mjs,ui.mjs}` |
| The scenarios, `results.json`, logs | `client/e2e/fresh-machine/run.mjs` |

Run it:

```
git archive HEAD | tar -x -C <snap>; ln -s "$PWD/client/node_modules" <snap>/client/node_modules
CARGO_TARGET_DIR=… scripts/fresh-machine/build.sh <bin> <snap>
node client/e2e/fresh-machine/run.mjs --bin <bin> [--shots <dir>] [--out <dir>] [--keep]
```

Output: numbered screenshots, `results.json` (every check with its detail),
each computer's journal and server log, the routers' logs. Exit non-zero on
any failed check. Stops before starting if `/home` has under 40 GB free.

### Topology

`pcfm-lan` 192.168.50.0/24 (router .1, host .28, second host .29) and
`pcfm-wan` 203.0.113.0/24 (router .1 = the public address, friends .77/.78/.79);
CGNAT pass: `pcfm-cgn-lan` 192.168.60.0/24 and `pcfm-cgn-wan` 100.64.0.0/24
(router wan 100.64.0.2). Docker's own gateway sits on .254 so the router can
be .1; lan computers route through the router. The friend cannot reach
192.168.50.28 directly (Docker isolates bridges; checked in S2), only
203.0.113.1:8443 through the router's mapping.

### Faithfulness decisions

- **Driver: the real desktop app through `tauri-driver` → `WebKitWebDriver`**
  (Tauri's own WebDriver path; `TAURI_WEBVIEW_AUTOMATION` is honored by the
  release build). Clicks and typing go through WebKit's input pipeline in the
  real webview; the shell (keychain, systemd, clipboard plugin, deep links,
  single instance, the TLS verifier) is the real one. Every friend is a
  **desktop app**, not the web client. Native windows (the GTK file chooser,
  Tauri's trust dialog) are driven with **xdotool** on the container's Xvfb
  and captured with ImageMagick `import`. Arch ships `WebKitWebDriver` only
  in `webkitgtk-6.0`; it drives the 4.1 app because both are WebKitGTK
  2.54.1.
- **Sign-in/sign-out of the computer** is a PAM `login` session registered
  with logind (`pc-session.service`), which is what starts and stops
  `user@1000` (lingering off, `KillUserProcesses=yes`). The app and
  `tauri-driver` run inside that session, so signing out kills them like a
  real logout. Commands the harness runs as sam use `setpriv` (no PAM), so
  looking never signs anyone in.
- **Keychain unlock at sign-in** (what `pam_gnome_keyring` does) is
  `pc-keyring.service`: `gnome-keyring-daemon --unlock` with a fixed test
  password, ordered before `default.target`, which `paracord-host.service`
  starts after.
- **Installed like the package:** binaries in `/opt/paracord`, plus the
  desktop entry the .deb/.rpm installs (`MimeType=x-scheme-handler/paracord`,
  `Exec=… %u`), so a `paracord://` link can start a never-run app.
- **The router patch** (`lab-patch.py`): miniupnpd 2.3.9 blanks
  `GetExternalIPAddress` for a reserved wan address when
  `ext_allow_private_ipv4` is set (inverted flag test upstream), and the lab's
  addresses are TEST-NET-3 and 100.64/10. Real routers report theirs; with
  the patch the lab's does too, so the **UPnP IGD** path is what maps the
  port (`method: upnp`), not PCP. Arch's `miniupnpd` (libiptc) is not used:
  it needs the legacy `ip_tables` modules, and the harness never loads
  kernel modules.
- Containers are **not privileged** (no host `/dev/snd`, `/dev/dri`):
  `SYS_ADMIN` + private cgroup namespace, the cgroup2 mount remounted rw
  inside the container's own subtree for systemd.
- The native **"Trust new Paracord instance?"** dialog is accepted by a
  watcher as the person at that computer would (it is their own server), and
  every appearance is recorded and screenshotted (`dialog-*.png`) because it
  is a bug (§4.1).

## 2. Scenarios

Screenshots: `/tmp/claude-1000/-home-scdouglas-Documents-Paracord/b3a0a140-c23e-4fa5-b47f-694ae9922a96/scratchpad/s15-shots/`
(67 numbered + 3 dialog captures, all read). Order of the run: 1, 2, 3, 4,
7, 8, 5, 6 (7 needs the first host; 8 replaces it; 5 needs its mapping gone).

| # | Scenario | Result |
|---|---|---|
| 1 | Fresh host: launch → split welcome → Host → "Friday Night Crew", Green → account (one password) → rows 1–5 → phrase → invite | **Fail on one check** (§4.1). Rows 1–5 ok in 3 s ("Your router opened the way. Friends can reach you at 203.0.113.1."); `paracord-host.service` enabled and active as a systemd **user** unit; DB header not `SQLite format 3` and `sqlite3` refuses it; keychain item `Paracord / host-storage-key:<instance_id>`; `storage-key.escrow` present; first backup present, backups on; mapping made over **UPnP IGD** (router holds TCP+UDP 8443 → .28); 24-word phrase; invite `https://203.0.113.1:8443/invite/<code>`; Open lands in `general`. The native trust dialog for `https://127.0.0.1:8443` appeared during row 3 |
| 2 | Friend outside joins (paste and `paracord://`), trust words, account, encrypted DM; server stores it unreadable | **Fail on one check** (§4.6, xdg-open). Card: "Friday Night Crew", "1 online · 1 member", trust words equal the words computed in the harness from the host's `cert.pem` (independent implementation of §7.1 against the server's BIP39 list). Join rows ok. DM via member list → Sam → Message, "Delivered"; the stored row is base64 ciphertext with an E2EE header (read through SQLCipher with the key from sam's keychain via the HKDF subkey); the plaintext is in no DB/WAL file; the file is unreadable without the key. Sam reads it, replies, Alex reads the reply; host `confirmed_at` set (friend from outside). **Deep links:** cold (`gio open paracord://…` on a computer that never ran Paracord) starts the app and lands on Join with the invite checked (shot 021); a new friend (Riley) joins from it; warm (`gio open` while running) reaches the running app through single-instance and opens Join with the link, still one process (shot 028). `xdg-open`'s generic path fails (§4.6) |
| 3 | Relaunch host app; sign out/in of the host session | **Pass.** Service stays up with the app closed (friend reaches it); relaunch asks no password and lands on the DM, history decrypts, a message sent while closed arrives. Sign-out stops the service and releases the router mapping; sign-in starts it on its own, it reads its key from the keychain, the mapping returns, the friend reconnects and gets new messages |
| 4 | Second device for the friend: identity from the key backup, reads the DM | **Fail on one check** (§4.5). Sign-in shows the same trust words; no phrase screen; the device says the identity was restored and offers fresh keys; older history shows "Encrypted message" (per-device sessions, by design). After "Publish new keys for this device", **Sam's next message does not reach the new device**; after the new device sends one, Sam's reply does |
| 7 | Certificate change: identity-changed, disconnected until Trust | **Fail** (§4.2). The shell records the mismatch (`pending_identity_change` has the old and new fingerprints) and nothing is sent (stays disconnected), but the running app shows "Reconnecting to the instance… The instance is restarting." forever, and after a relaunch it shows the old `/login` page ("Could not reach …" on submit). No identity-changed sheet, no Trust |
| 8 | Restore on a fresh host computer from a backup + recovery phrase | **Pass.** Backup made in the app (Admin › Backups › Create backup) after the DMs; the old computer removed; a new one at the same address; Host › "Restore from a backup instead" → the GTK file chooser (xdotool) → the 24 words → rows 0–5 ok → Sign in → "Friday Night Crew", channels and members back; new instance id; service running, storage encrypted, key in the new keychain; all 7 message rows back, the DM rows still ciphertext; friends reach it through the router. (Old DMs need new device keys on the new computer, as in S4.) The restored server has a new certificate, so the friend's app hits §4.2 again |
| 5 | Router refuses, refused state + steps, keeps retrying, flips to open | **Fail on two checks** (§4.3, §4.4). With UPnP off in the router and NAT-PMP/PCP refusing: row 4 warns with the §5.4 copy, Show me how names port 8443 and 192.168.50.29, Try again asks again and warns again, the invite is the home-network link with the amber note, nothing says "Friends can reach you". Router turned to allow: **the invite switched to `https://203.0.113.1:8443/…` live after 59 s**, state open, the friend reaches it. Failures: the sheet says "usually 192.168.0.1 or 192.168.1.1" instead of 192.168.50.1; and a router that answers UPnP but refuses the mapping is reported **open** |
| 6 | CGNAT (router wan 100.64.0.2) | **Pass.** Row 4 warns with the shared-address copy; "What can I do?" sheet; `shared_address` with `external_ip` 100.64.0.2; invite is the home-network link; no "reach you" claim anywhere |

## 3. What could not be covered

Windows Scheduled Task and macOS LaunchAgent (S8's CI smoke jobs), real
consumer routers (S5's one LAN observation), GPU paths (software GL only),
voice/video (null devices only, no call placed). Settings › "Paracord on this
computer" (§2.9) does not exist (§4.7), so the plan's "opened the way" and "A
friend connected from outside" checks in Settings were made against
`host_status` from the app instead, and the flip to open against the live
invite screen. A LAN friend joining while refused (plan step 8) was not run.

## 4. Product bugs (repro on this branch; not fixed here)

Severity: **H** high, **M** medium, **L** low. Owners are the packages whose
files the fix lands in.

### 4.1 (H, S13/S7) The host's own server triggers the native trust dialog in setup row 3
Repro: fresh desktop host → Host → name → account → Continue. During row 3
("Creating your encryption keys") Tauri's native **"Trust new Paracord
instance? Paracord wants to trust https://127.0.0.1:8443 …"** appears
(`dialog-pcfm-host-1.png`). If it is not answered within ~8 s, row 3 fails
with **"Native fetch target is not in the trusted server list"**; in the
first exploratory run nobody answered and the row failed after 59 s; Try
again then succeeded once the dialog was accepted. It also appears on the
restore path, and if the person is slower than the sign-in probe, Sign in
after a restore says "Can't reach 127.0.0.1" until the address is typed again.
Cause: `createHostAccount` (`pages/firstRun/flows.ts`) sets the loopback URL
as the stored server and calls the API through `native_fetch`, whose origin
must be in `TRUSTED_SERVER_ORIGINS`; the only way in is
`update_trusted_server_hosts`, which asks `request_native_server_trust_confirmation`
for any origin not approved before. Nothing approves the host's own loopback
origin. Fix direction: approve `https://127.0.0.1:<port>` in Rust when the
host is set up (hostctl knows the port), so no dialog and no race.

### 4.2 (H, S10/connection manager) A certificate change on the joined server never shows identity-changed
Repro: S1 + S2, then on the host `systemctl --user stop paracord-host; rm -rf
…/host/data/certs; systemctl --user start paracord-host`. The friend's
running app shows "Reconnecting to the instance… The instance is restarting.
You'll reconnect automatically." indefinitely (shot 039); the gateway logs
`SSE setup failed` every 30 s; `pending_identity_change("203.0.113.1")`
returns the old and new fingerprints, so the shell knows. After a relaunch
the app shows the old `/login` page (shot 040) and submitting says "Could not
reach https://203.0.113.1:8443". No sheet, no **Trust the new identity**,
no way back short of re-adding the server. Cause: the server a person joins
through the first run is the `__local__` server, and
`lib/connectionManager.ts` explicitly skips it:
`if (conn.serverId !== LOCAL_SERVER_ID && (isPinMismatch(err) || identityChangeFor(conn.serverUrl)))`
(SSE setup, ~L1750); `ServerUnavailable`/`ServerSessionBanner` only render
phases of servers in `serverListStore`. The safe half holds (nothing is sent:
3 → 3 rows), the visible half and the Trust path are missing. Same on a
restored host (new certificate by design, S13b deviation 5).

### 4.3 (H, S5 portmap) A UPnP router that refuses the mapping is reported "open"
Repro: router in `deny` mode (miniupnpd answers `AddPortMapping` with UPnP
error **718 ConflictInMappingEntry** for a permission denial) and a router
that reports its external address. `paracord-server` logs `reachability
state=Open method="upnp"` and "router opened the ports: friends outside this
network can reach this server"; row 4 / `host_status` say open, the invite is
the public link, and the friend **cannot** connect (no mapping on the
router). Cause: `crates/paracord-server/src/portmap.rs` `add_upnp_mapping`:
`Err(igd_next::AddPortError::PortInUse) => Ok(false)` ("on a restart or a
renewal that is our own entry"). 718 also means another device holds the
port or the router's rules deny it; miniupnpd replaces a same-client mapping
instead of answering 718. Violates spec §5.4 "Never: Friends can reach you
without open". Fix direction: treat 718 as refused unless
`GetSpecificPortMappingEntry` shows the entry points at this computer.
Related (L): when `GetExternalIPAddress` fails after mappings were made, the
reason says "the router opened the ports but would not say its public
address" even when they were refused, and UPnP mappings made before that
failure are not removed before falling back to PCP.

### 4.4 (M, S5) "Let friends in" sheet does not name the router's address on a refusal
Repro: router `deny-noupnp` (UPnP off, PCP refuses). The sheet says "Open your
router's page (usually 192.168.0.1 or 192.168.1.1)" (shot 054) although the
gateway answered from 192.168.50.1. `host_status.reachability.gateway_ip` is
`null` in every failure state; it is only filled from a successful mapping.
Fix: record the default gateway (or the address that answered) on refusal
and no-answer too.

### 4.5 (M, S3 / DM sessions) A contact's next message after "Publish new keys" does not reach the new device
Repro: S4. On the second device press "Publish new keys for this device"
(copy: "your contacts pick them up on their next message"). Sam sends
`spruce-otter…`: it arrives on the old device (shot 039 shows it there) and
never on the new one (`after-sam-next`). Only after the new device sends a
message does Sam's reply reach it. Either the sender should refresh the
recipient's device keys when they change, or the copy should say the new
device has to send first. Also (L): that panel says "Your recovery phrase
restored the identity" after a username + password sign-in (it came from the
key backup).

### 4.6 (M, S11 / platform) `paracord://` links fail under `xdg-open`'s generic path
Repro: a desktop session without GNOME/KDE/XFCE detection (i3, sway, a bare
WM) → `xdg-open paracord://invite/…` → "xdg-open: no method available".
The deep-link plugin's runtime registration writes
`~/.local/share/applications/paracord-desktop-handler.desktop` with
`Exec="/opt/paracord/paracord-desktop" %u`; `xdg-open`'s generic handler does
`command -v` on the first word **with the quotes**. `gio open` (GNOME's path)
handles it, cold and warm (both pass). Fix direction: write the handler
without quotes when the path has no spaces, or point users of packaged
builds at the package's desktop entry.

### 4.7 (M, unowned) Settings › "Paracord on this computer" (spec §2.9) is not built
No component renders it: status, Start/Stop, autostart switch, reachability
copy ("opened the way", "A friend connected from outside …"), the host's own
trust words, Back up now, Show logs, Remove. `hostStore` has the actions
(S7) but no package row owned the panel. The owner currently cannot read
their server's words to a friend, see reachability after setup, or remove
the host from the UI.

### 4.8 (L, client) Unauthenticated `POST /download/ticket` loop
Repro: restore on a fresh computer; between setup and sign-in the app sends
`POST /api/v1/download/ticket` about 3–4 times a second, every one 401 (host
server log, `pcfm-host.server.log`). `lib/downloadTicket.ts`
`ensureDownloadTicket` runs while a stored server URL exists without a session.

### 4.9 (L, environment) gnome-keyring-daemon abort
Once, in an earlier run, `gnome-keyring-daemon` aborted
(`gkd_secret_service_get_pkcs11_session: assertion 'client' failed`) when the
harness ended the app abruptly; the next service start then found a locked,
D-Bus-activated keyring and exited "keychain is locked … prompt dismissed"
(exit 78 path, correct behavior). The harness now restarts its unlock unit on
failure and records any crash in `results.json` (`findings`; none in the
final run). Worth knowing: on a real desktop a keyring crash leaves the
hosted server down until the next sign-in.

Minor visual notes from the screenshots: the member profile card's action
buttons are cut off at the bottom of an 800 px window (shot 017); the
shared-address sheet's list has an empty marker column (shot 064).

## 5. Gates

| Gate | Result |
|---|---|
| `npx eslint e2e/fresh-machine` | clean |
| `node --check` on the `.mjs` files | ok |
| shellcheck v0.9.0 on the four shell scripts | clean |
| Full gate run (final) | 76/84 checks, 502 s; the 8 failures are §4.1–4.6 |

No product code, shared config or dependency was changed. Files: only
`scripts/fresh-machine/**`, `client/e2e/fresh-machine/**` and this file.

## 6. Cleanup

All `pcfm-*` containers and networks removed (verified empty), and the
`paracord-fresh/desktop` and `paracord-fresh/router` images deleted (the next
run rebuilds them, a few minutes of Arch downloads). The build snapshot and
binaries were in the scratchpad (RAM), not the repository.
