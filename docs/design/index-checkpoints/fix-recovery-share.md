# Checkpoint: recovery phrase, share link, and a relaunch that came up locked

Branch `fix/recovery-share` on `457feada`, 2026-10-15. Three owner reports
from the hosted-server setup (the app runs `paracord-host` at
`https://127.0.0.1:8443`; the router answers no UPnP, NAT-PMP or PCP).

| # | Report | Commit |
|---|---|---|
| 3 | After an update and relaunch the app came up locked and disconnected | `ed93becd` |
| 1 | "Use your recovery phrase" failed with "Native fetch requires an absolute URL" | `a477a0f6` |
| 2 | The invite link used the home-network address | `cfd45e3f`, `23272c6f` |

## 3. Locked after the update

What the owner's data shows (read only; nothing in it was changed):

- From 07:51 to 10:40 on 2026-10-14 the installed app loaded its UI from
  `http://localhost:1492`. It was a test build (no `custom-protocol`, devUrl
  :1492, the stream-audit lab's old-dist port), so WebKit kept the account,
  the identity keystore, the saved server and the encrypted refresh token under
  that origin (`localstorage/http_localhost_1492`, IndexedDB and storage
  buckets created at 07:51). The 10:40 install is a release build, which is
  `tauri://localhost`: a different origin with an empty store (only
  `server-list` and `firstRun.launchSeen`, created at 10:40). From the app's
  point of view the update forgot the account and the server.
- Separately, the identity was never remembered in that run. The app started at
  07:51 with no Secret Service on the bus (KDE's `ksecretd` is only
  D-Bus-activatable as `org.kde.secretservicecompat`, not as
  `org.freedesktop.secrets`). `ksecretd` started at 08:21:31, when the hosted
  server stored its storage key in the keychain. The shell had decided "no
  keychain" once at launch and kept that for the whole run, so the 08:22:10
  sign-in wrote the refresh token to the encrypted-file fallback
  (`secure-store-fallback.key` is from 08:22:10) and could not remember the
  identity. The keychain holds no `paracord:identity:*` entry and nothing
  written after 2026-10-13.

Fix (`ed93becd`):

- The shell's keychain probe tells "has not answered yet" apart from "does
  not keep secrets". It uses a late answer as soon as it arrives, asks a
  missing keychain again once that answer is 30 s old, and keeps a working
  keychain for the run. `secure_store_ready` waits for the probe, at most
  three minutes.
- At launch, a keychain that is still starting is waited for (up to 45 s)
  before the password screen. If it is still starting when the app tries to
  remember, the remember finishes in the background once it answers, unless
  this computer has since turned on "Ask for my password".
- A test build writes one log line saying it keeps its data under its devUrl
  origin. Release builds don't have that line.

Tests: `rememberedUnlock.keychainStarting.test.ts` (4 of 5 fail on the old
code) and `commands::keychain_probe_tests` (late answer, keychain appears
later, prompt answer).

The test-build origin is a process problem. A test build must never be
installed as the owner's app. The owner's own data under `:1492` can't be read
by the release build. They get back in by signing in to
`https://127.0.0.1:8443` with their password, which the sign-in screen now
fills in (below), because the key backup is on their server.

## 1. Recovery phrase: "Native fetch requires an absolute URL"

The desktop page is served from the app bundle. With no server chosen (a
profile with none saved, which is the owner's state after the origin change,
and the Server field still empty), the API base is a bare `/api/v1`. "Use your
recovery phrase" went to `/recover` anyway. Its first request,
`/api/v1/auth/options`, reached the shell, which refused it with that internal
sentence, and the page showed raw error text. When that question failed, the
page also fell back to a device-only legacy recovery with no server behind it.

Fix (`a477a0f6`):

- `tauriAxiosAdapter` refuses a request that names no server before the shell
  sees it (`ERR_PARACORD_NO_SERVER`), with a sentence the person can act on.
- `/recover` with no server chosen shows "Choose your server first" and a
  button to sign-in. With a server, it asks again which recovery the server
  runs instead of guessing. If the server doesn't answer, the page says "couldn't
  reach the server". `credentialErrorMessage` never shows a request's raw
  message.
- On sign-in, "Use your recovery phrase" with an empty Server field and nothing
  saved asks for the address.
- On a computer that runs a server, the sign-in Server field starts on it
  (`host_info().home_url`). A late value never replaces what the person typed.

Tests: `AccountRecoverPage.noServer.test.tsx` (the real page, account flows and
adapter against a shell stub that refuses relative URLs as `lib.rs` does; all
4 fail on the old code) and `SignInStep.hostedServer.test.tsx`.

Screenshots (headless, desktop shell stubbed):
`/tmp/claude-1000/-home-scdouglas-Documents-Paracord/b3a0a140-c23e-4fa5-b47f-694ae9922a96/scratchpad/shots/recover-no-server.png`,
`sign-in-hosted.png`, `sign-in-forgot-empty.png` (same folder; temporary).

## 2. Share link uses the internal address

`share_address::derive()` used an outside address only for `open` and
`direct`, and the only source of one was the router. This router doesn't
answer, so the share address stayed `NoAnswer` and fell back to the LAN
address. A router that refused a mapping also had its reported address dropped.

Fix (`cfd45e3f`, plus `23272c6f` for the first-run Invite screen):

- A refusing router is still asked for its outside address (UPnP
  GetExternalIPAddress, NAT-PMP opcode 0), and the answer is kept.
- When the router gives no public address, the server sends one STUN Binding
  Request (RFC 8489, hand-written IPv4 codec in `paracord-server/src/stun.rs`,
  sent from the bind interface). It does this at most every 30 minutes and on
  Try again, and stores the result as `Reachability.observed_ip`.
- The share address leads with the public address. Its `reach` is
  `internet_unconfirmed` until the router opens the port or a connection from
  outside is seen. It carries a `note` (`port_not_forwarded`,
  `firewall_blocked`, `carrier_nat` for 100.64/10, `outer_router` for a
  private WAN address), plus `local_url`, `source` and `port`. `public_url`
  still wins over everything.
- The invite dialog, the first-run Invite screen and host Settings show the
  outside link and a plain note ("People outside your network may not reach
  this until port 8443 is forwarded on your router."). They keep the "On this
  network" link with its own Copy, and Settings points at `public_url` for a
  domain name.

Screenshots:
`output/design-reference/index-build/fix3-share/dlg-invite-unconfirmed@1440x900.png`,
`@390x844.png`, `output/design-reference/setup-build/fix3-share/reach-no_answer-stun.png`.

### Owner decision: STUN

There is no first-party source of the public address when the router doesn't
answer, and a first-run host has no peers to ask. STUN is on by default behind
`[network] external_address_stun_servers`, which defaults to
`["stun.cloudflare.com:3478", "stun.l.google.com:19302"]`, tried in order.
Setting it to `[]` turns it off. It is also set by
`PARACORD_EXTERNAL_ADDRESS_STUN_SERVERS` and documented in the config
template. The first server that answers sees this network's public address,
in one small UDP packet at most every 30 minutes, and nothing else is sent.
To make it opt-in, change the serde default to an empty list. Links then stay
on the LAN address until the router answers or `public_url` is set. A single
live check from this machine got a public, non-CGNAT IPv4 address from
Cloudflare.

## Gates

- `cargo fmt --all -- --check`: OK.
- `cargo clippy --workspace -- -D warnings` (placeholder sidecar staged): OK.
- `cargo test`: paracord-desktop (344), paracord-core, paracord-server,
  paracord-hostctl and paracord-contracts all pass.
- Client: `typecheck` OK; `vitest run` 504 files, 4953 tests pass; `eslint .`
  0 errors (56 warnings, existing); tokens, motion-lint and `contracts:check`
  pass. Playwright invite-dialog and host-settings specs pass (Bug 2 agent).

## Release build (not installed)

`npm run build && npm run host:stage -- --release && npx tauri build --no-bundle`:

- `paracord-desktop`:
  `/home/scdouglas/Documents/Paracord-glass/target/release/paracord-desktop`,
  sha256 `444b5ae88116f5393b136b4c75dd57e89936333b510f58bf30e73280b0c8f073`
- `paracord-host`:
  `client/src-tauri/binaries/paracord-host-x86_64-unknown-linux-gnu` (same as
  `target/host/paracord-host`), sha256
  `cc18c83e8b491af07b6c607b127693f60bff0678ce07d6c3cfe12250c5219bc9`

## Open

- STUN runs only while automatic port forwarding is on. With
  `auto_port_forward = false`, links stay on the LAN address unless
  `public_url` is set.
- A full-tunnel VPN can make STUN report the VPN's exit address. The router's
  answer, when there is one, always wins.
- The conversation's "Bring your people" card copies the link without the
  note; the full dialog opens on the second press.
- If the keychain has no Secret Service at all at login, the password screen
  appears at launch (it is not waited for). The next unlock re-checks the
  keychain and remembers.

## Follow-up: "Paracord doesn't know which server to use yet" after hosting setup

The installed build (desktop `444b5ae8…`) showed `NO_SERVER_CHOSEN_MESSAGE`.
The owner's `tauri://localhost` profile (read only) holds just
`paracord:server-list` (empty) and `paracord:v2:firstRun.launchSeen`. It has no
account, no keystore, no refresh token and no saved server. (In the log,
`hasToken` is always `[redacted]`, so it does not show that a token exists.)
The owner said "I went through the hosting setup", which identifies the page:
the first-run **Host** path on a computer whose server already has its owner.
`hostStore.runSetup` sees `escrow` in `completed_steps` and marks the Account
row done without running `createHostAccount`. That function is the only place
the host path saves the server URL. The flow then reached the recovery-phrase
step, and its Continue (`confirmRecoverySaved`) had no server to ask.

Fix (`e9101ab4`):

- Boot: with no home server saved, a computer that hosts one adopts its
  origin. The new `host_home_server` command reads `host.json` without the
  host lock. This happens before the first trust sync and before anything
  renders (`main.tsx` awaits it). The shell trusts its own server's origin by
  the certificate on disk, without a prompt (`host.rs` `OwnServer`). A saved
  server is never replaced.
- On a computer whose server has its owner, Host goes to sign-in on that
  server with the address filled in and a line saying so. A setup that made no
  account does not go on to an empty phrase step.
- Audit:
  - `/recover` and `/setup` with no server show the shared "Choose your
    server first" screen.
  - `/unlock` with no server keeps its offline answer (wrong password) and
    never shows the adapter text.
  - `/login` is behind `AuthRoute`, which sends a desktop with no server to
    `/connect`.
  - The first-run phrase error is now a sentence.
- Tests: `lib/host/adoptHostedServer.test.tsx` covers a hosting computer with
  no saved server reaching recovery with the hosted server, and that a saved
  server is never replaced. `FirstRunPage.ownServer.test.tsx` covers Host
  leading to sign-in on `https://127.0.0.1:8443`.

Gates: fmt, clippy `--workspace -D warnings` and paracord-desktop tests pass.
Client typecheck passes; vitest 506 files and 4958 tests pass; eslint has 0
errors; tokens and motion-lint pass.

Release build (not installed):

- `paracord-desktop` (`target/release`): sha256
  `fc6a0dd8ad220575e9bc7c09fcc77a93b50d996904123dc95e78bcfa55ae7b99`
- `paracord-host` (staged sidecar): sha256
  `81ee4f262e105c6f330f854e5c0ae51b3fdd8e3c9b6d7adcce5c44c1d77d9982`. Only its
  embedded web UI changed.
