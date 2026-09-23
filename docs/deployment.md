# Deployment (Production Notes)

This page covers the handful of things that differ between a quick local server
and an internet-facing production deployment. It deliberately does **not** repeat
the full runbook — for complete nginx/caddy/systemd examples, PostgreSQL tuning,
monitoring, and S3 storage see the
[Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md), the
[Docker setup reference](docker-setup.md), and the baseline
[deployment profiles](deployment-profiles.md).

> **No secrets to hand-generate.** Paracord generates and persists its JWT signing
> secret (and self-signed certificates) on first run. You do not create a JWT
> secret manually, and the default native QUIC media engine needs no LiveKit
> credentials at all. LiveKit is optional; enable it only if you specifically need
> a WebRTC SFU (see [Getting Started](getting-started.md#native-media-vs-livekit)).

## 0. Fastest path: the install script

For a dedicated Linux host, [`scripts/install.sh`](../scripts/install.sh) does
the whole base install in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.sh | sudo sh
```

It installs the latest release to `/opt/paracord`, creates a `paracord` system
user, writes a hardened `paracord.service` systemd unit (`Restart=always`,
`ProtectSystem=strict` with the install dir writable, no ambient privileges),
generates `config/paracord.toml` via `paracord-server init`, and starts the
service. Re-running it is the upgrade path: `config/` and `data/` are preserved
and the previous binary lands in `backups/`. All paths inside the generated
config are pinned to the install directory, so nothing depends on the process
working directory.

On Windows, [`scripts/install.ps1`](../scripts/install.ps1) is the equivalent
one-command path from *any* PowerShell window —
`irm https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.ps1 | iex` —
it elevates itself, installs under `%ProgramFiles%\Paracord`, registers an
auto-start scheduled task running as `SYSTEM` with crash restarts, and opens the
inbound firewall for the configured app (TCP) and voice (UDP) ports.

Both installers finish by opening the one-time setup link in a browser
(`PARACORD_NO_BROWSER=1` only prints it). On a fresh install they ask one
question first: may Paracord ask the router to let friends outside the home
network connect? The answer is written to `[network] auto_port_forward` and
defaults to no. Without a terminal to ask on (CI, a pipe with no TTY) the answer
is no unless `--allow-internet` (`-AllowInternet` on Windows) or
`PARACORD_ALLOW_INTERNET=1` says otherwise; see
[port-forwarding.md](port-forwarding.md). On a server you expose deliberately
behind a reverse proxy or a cloud firewall, leave it off.

New servers are invite-only: `[auth] registration_mode = "invite_only"`. Only
someone holding a live invite to one of the server's servers can create an
account. Set it to `"open"`, or use **Admin → Settings**, to let anyone who can
reach the server sign up. A config written before this setting existed has no
`registration_mode` and stays open.

That gives you a working self-signed-HTTPS server on `8443`. The rest of this
page is about turning that into an internet-facing production deployment: a
real domain, proxy-terminated TLS, `public_url`, and optionally PostgreSQL.

> **Integrity.** Every release publishes `SHA256SUMS.txt` covering all its
> files, and the installers check the archive against it and refuse one that
> does not match. To check a download yourself, see
> [Check a download](../README.md#check-a-download). For an offline install,
> download and check the archive, then install with
> `PARACORD_LOCAL_ARCHIVE=<file>` (a sibling `<file>.sha256` is verified when
> present).

## A domain name and automatic certificates

This is the setup to aim for once other people use your server. With a domain
name and a certificate from Let's Encrypt, browsers connect without any warning,
and invite links carry a name instead of an address.

1. **Get a domain name and point it at the server.** Buy one, or use a free
   dynamic-DNS name, and create an `A` record pointing at your home or server's
   public IP address. Dynamic-DNS services can keep that record up to date when
   your address changes.
2. **Let the internet reach the server on port 80 and your HTTPS port.** Let's
   Encrypt checks you own the name by fetching a file over plain HTTP on port 80.
   Paracord answers that check on its plain-HTTP port (the one in `[server]
   bind_address`, 8090 by default), so on the router forward outside TCP port 80
   to that port on this computer, and your HTTPS port (8443 by default) to the
   same port ([port-forwarding.md](port-forwarding.md) shows how).
3. **Install certbot** (the Let's Encrypt client), for example
   `sudo apt install certbot` on Debian or Ubuntu.
4. **Turn on automatic certificates** in `config/paracord.toml`:

   ```toml
   [server]
   public_url = "https://chat.example.com:8443"

   [tls.acme]
   enabled = true
   email = "you@example.com"
   domains = ["chat.example.com"]
   ```

   Restart the server. A few seconds after it starts listening, Paracord runs
   certbot, answers its check, and swaps the new certificate in without a
   restart. Until then it uses a temporary certificate of its own. If the
   request fails (for example because the DNS record hasn't reached everyone
   yet), it tries again after 1, 2, 4... minutes, and the server log says what
   went wrong each time. After that it renews on its own schedule
   (`renew_interval_seconds`, every 12 hours by default).

If you would rather run a reverse proxy such as Caddy or nginx on the standard
ports, the next section covers that instead. Either way, the self-made
certificate and its browser warning are only for trying Paracord out.

## 1. TLS: terminate at a reverse proxy

For a production deployment behind a domain name, terminate TLS at a reverse proxy
(Caddy, nginx, or Traefik) and keep Paracord on a private upstream. Disable
Paracord's built-in TLS in that setup so the proxy owns HTTPS:

```bash
PARACORD_TLS_ENABLED=false
```

Point the proxy at the Paracord HTTP port (`8090` by default). The proxy must
forward WebSocket upgrades and the standard proxy headers (`Host`,
`X-Forwarded-For`, `X-Forwarded-Proto`). See the
[Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md#4-reverse-proxy-and-tls)
for ready-to-use nginx and Caddy configs.

When the app runs behind a proxy, also set:

```bash
PARACORD_COOKIE_SECURE=true
PARACORD_TRUST_PROXY=true
PARACORD_TRUSTED_PROXY_IPS=<exact proxy IPs or CIDRs>
```

Restrict `PARACORD_TRUSTED_PROXY_IPS` to your actual proxy addresses only — never
leave it open. At the public edge, overwrite `X-Forwarded-For` with the socket
client address instead of preserving an incoming client-supplied value. Paracord
walks multi-proxy chains from the trusted right edge, so internal trusted proxies
may still append their immediate peer when a deliberate proxy chain is used.

> If you prefer **not** to run a reverse proxy, keep Paracord's built-in TLS
> enabled (the default for the binary): it auto-generates a self-signed
> certificate and serves HTTPS on `8443`. For a trusted (non-self-signed)
> certificate, configure ACME/Let's Encrypt under `[tls.acme]` in `paracord.toml`.

## 2. Forward the native media UDP port

Reverse proxies terminate TCP/HTTPS, but Paracord's native voice/video runs over
**QUIC on UDP** and is **not** proxied through your HTTP reverse proxy. You must
forward the native media UDP port directly to the server host at the firewall:

- **Native media port:** `8443/udp` by default (the `[voice] port` value in
  `paracord.toml`). Raw QUIC desktop clients and browser WebTransport both use it.
- If your reverse proxy also serves HTTPS on `8443/tcp`, forwarding **`8443`
  over both TCP and UDP** covers everything with a single port number.

In Docker this is already mapped as `8443:8443/udp` in `docker-compose.yml`;
just make sure your host firewall allows inbound UDP on that port.

### If you run LiveKit instead of native media

LiveKit needs three UDP listeners of its own, and they are all distinct ports —
its TURN relay cannot share the RTC mux's port (LiveKit refuses to bind the same
address twice and exits at startup). With the defaults those are:

- **RTC mux:** `7882/udp` when native media is also enabled, otherwise your
  public signalling port.
- **TURN relay:** the port after the RTC mux (`7883/udp` by default). Override
  it with `[livekit] turn_udp_port` in `paracord.toml` if that port is taken.
- **TURN relay range:** the ten ports after TURN (`7884-7893/udp` by default).

Forward all three to the server host. Native media (the default) needs none of
them.

## 3. Set PUBLIC_URL

For any deployment reachable at a fixed hostname, set the canonical public origin
so invite links, verification/reset emails, and CORS all use the right URL:

```bash
PARACORD_PUBLIC_URL=https://chat.example.com
```

This is auto-detected for local/LAN use, but internet-facing deployments behind a
proxy should set it explicitly — verification and password-reset links are built
only from `PARACORD_PUBLIC_URL` (or headers from a trusted proxy), never from a
client-supplied `Host` header.

### Letting other Paracord servers' browser users connect to yours

Paracord's multi-server sidebar lets someone signed in on one server add a second
one. From the **desktop app** that always works: Tauri requests come from a fixed
origin that is always allowed. From a **browser**, the connect probe and every later
API call are cross-origin requests carrying credentials, and your server only answers
those for an origin on its allowlist. `PARACORD_PUBLIC_URL` is on it automatically;
add any other origin explicitly:

```bash
# Comma-separated. Scheme + host + port, no trailing slash.
PARACORD_CORS_ALLOWED_ORIGINS=https://friends.example.org,http://127.0.0.1:18240
```

The allowlist is closed by default on purpose. Reflecting whatever `Origin` arrives
and answering `Access-Control-Allow-Credentials: true` would let any website a
signed-in user visits drive their Paracord server with their session, so a
credentialed cross-origin request needs the operator to say the word. A browser user
refused this way is told which host refused them and which setting fixes it.

## 4. PostgreSQL (optional)

SQLite is the zero-config default and is fine for small communities. For sustained
multi-user production, larger message history, or external DB tooling, switch to
PostgreSQL:

```bash
PARACORD_DATABASE_ENGINE=postgres
PARACORD_DATABASE_URL=postgresql://paracord:PASSWORD@localhost:5432/paracord?sslmode=prefer
PARACORD_DATABASE_MAX_CONNECTIONS=50
```

Paracord runs its PostgreSQL migration track automatically on startup. Already
running on SQLite? The server ships a one-shot migrator:

```bash
paracord-server migrate-to-postgres \
  --source "sqlite://./data/paracord.db" \
  --target "postgresql://paracord:PASSWORD@localhost:5432/paracord"
```

Stop the server first (the SQLite file must be idle); the copy runs inside a single
transaction and verifies copied row counts. Tail repair and a new database
history epoch commit with the copy. Target schema migrations and seed rows run
first and remain applied even with `--dry-run`, which validates without copying
source rows. Full runbook:
[docs/sqlite-to-postgres-migration.md](sqlite-to-postgres-migration.md). Pool
sizing and tuning guidance lives in the
[README PostgreSQL section](../README.md#using-postgresql-instead-of-sqlite).

## 5. Backups

Back up both the database and the media, and validate restores on a staging node:

- **Database:** SQLite file snapshot, or `pg_dump`/`pg_restore` on PostgreSQL. The
  admin settings panel and API can trigger backups on either backend.
- **Media, config & keys:** Retain `data/uploads`, `data/files`, the original
  `paracord.toml` and deployment environment, the at-rest master key, and separate
  TLS/federation key files. The config contains the JWT secret, not TLS key bytes.

Use `paracord-server restore-backup` to prepare and verify a new SQLite directory
or isolated PostgreSQL database, then stop every old instance before activating
its generated configuration. The admin panel provides downloads and offline
instructions; it does not replace the running database. Follow the
[backup and recovery runbook](backup-recovery.md) for keys, media verification,
cutover and rollback.

See the
[Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md#6-backups-database--media)
for a suggested retention schedule.

## 6. Optional LiveKit

The native QUIC engine is the default and is recommended for self-hosted
deployments. LiveKit is opt-in and only worth it for legacy WebRTC interop or very
large SFU-scale rooms. To enable it under Docker Compose:

```bash
docker compose --profile livekit up -d
```

Then turn off native media on the `paracord` service so voice routes through
LiveKit:

```bash
PARACORD_VOICE_NATIVE_MEDIA=false
```

The Compose files ship a working local LiveKit key/secret pair for development;
override `PARACORD_LIVEKIT_API_SECRET` with a strong random value before exposing
LiveKit to a network. See [docs/docker-setup.md](docker-setup.md) and
`docker-compose.yml` for the full LiveKit wiring.

## 7. Voice troubleshooting: the connection check

<!-- Added for the guided voice connection check (improvement item 13). Keep
     this section self-contained so install-doc rewrites can move it whole. -->

Chat and calls do not travel the same way. Messages ride TCP through your reverse
proxy; native voice and video ride **QUIC on UDP**, straight to the server host.
That is why a server can be perfectly healthy for chat and completely unusable
for calls — and why "voice doesn't work" reports are rarely about voice.

Paracord ships a guided check so a user can find the answer themselves. It is
reached from **Settings → Voice & Video → Run connection check**, and it is
offered directly on a failed join (the voice lobby's error state, and the toast
shown when a DM call fails to start). It never joins a call and never changes an
active one; closing it returns the user to chat unchanged.

The check reports each cause separately:

| Step | What it proves |
|---|---|
| Secure connection | The page is on `https://` or `localhost`. Browsers block microphones and QUIC anywhere else. |
| Browser and codec support | WebTransport, Opus encoding, VP9 decoding, AudioWorklet. The desktop app is judged on its own native stack instead. |
| Microphone | Permission, that the selected input still exists, and that sound actually reaches it (a live level meter). |
| Speaker | A test tone on the selected output, confirmed by the person running the check. |
| Camera | Optional; only affects video calls. |
| Server call settings | What this server actually configured: native QUIC, LiveKit, or nothing. Read from `GET /api/v1/voice/transport-diagnostics`, which has no side effects. |
| Media certificate | Whether this client can pin the certificate the media port presents. The fingerprint is read live, because the server rotates that certificate. |
| Voice connection | A real WebTransport session to the media endpoint, with a bounded timeout and a reported round-trip time. |

A failing step names the cause in plain language and says what to do, for
example: *"Your server's UDP port 8443 is not reachable from this network. Ask
the operator to forward UDP 8443 to the server host…"*. **Export diagnostics**
writes a redacted JSON report — browser, OS, engine, step results, timings and
error codes, with no tokens, cookies, account ids or credential-bearing URLs —
that a user can send to you.

### What operators should check when the transport step fails

1. **Forward UDP.** The media port (`[voice] port`, default `8443/udp`) must reach
   the server host directly. A reverse proxy does not carry it. See §2 above.
2. **Forward it to the right host.** "Something answered but the QUIC handshake
   did not finish" usually means the UDP port is published to a different service
   than the one serving chat.
3. **The media certificate is the server's own, and it rotates.** The media
   port always presents a certificate the server generates for itself; an
   operator's CA-issued TLS material terminates the *TCP* HTTPS listener and is
   never presented on the QUIC port. **There is nothing for you to install,
   renew or point a reverse proxy at here** — putting nginx, Caddy or Cloudflare
   in front of Paracord changes nothing about it.

   Chromium accepts a pinned self-signed WebTransport certificate only when it
   is ECDSA P-256 **and valid for at most 14 days**, so Paracord issues one
   valid for 13 days and rotates it roughly every 7 while the server runs. The
   start-up log names the fingerprint and expiry, and each rotation logs the new
   one:

   ```
   Native QUIC media server listening on UDP port 8443 (unified: raw QUIC +
   WebTransport), certificate pin AbCdEfGhIjKl… valid until 2026-09-26T…
   Rotated the native media certificate: pin MnOpQrStUvWx… valid until …
   ```

   Rotation does not drop calls: QUIC authenticates once at handshake, so live
   sessions continue and only new joins use the new certificate. Clients read the
   fingerprint fresh on every join and before every reconnect, so no user action
   is needed. Do not pin this fingerprint anywhere outside Paracord — it is
   correct for days, not forever.

   Firefox and Safari cannot pin a self-signed WebTransport certificate at all,
   so their users must use a Chromium-based browser or the desktop app. The
   desktop app pins the raw fingerprint through its own verifier and is
   unaffected by the 14-day rule.
4. **The admin health view will not tell you this.** It reads local configuration
   and reports `Native media: On (UDP 8443)` as soon as the listener binds. That
   is not a reachability probe — see
   [Known limitations](known-limitations.md#server-health). The connection check,
   run from the user's own network, is.

## See also

- [Getting Started](getting-started.md) — first-run walkthrough.
- [Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md) — full
  operator runbook (nginx/caddy/systemd, monitoring, S3).
- [Docker setup](docker-setup.md) — complete container configuration reference.
- [Deployment profiles](deployment-profiles.md) — baseline dev / single-node /
  testbed values.
- [Known limitations](known-limitations.md) — current support boundaries.
