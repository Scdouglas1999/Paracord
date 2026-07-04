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
leave it open.

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
all-or-nothing transaction and verifies every table's row count. Add `--dry-run`
to validate without writing. Full runbook:
[docs/sqlite-to-postgres-migration.md](sqlite-to-postgres-migration.md). Pool
sizing and tuning guidance lives in the
[README PostgreSQL section](../README.md#using-postgresql-instead-of-sqlite).

## 5. Backups

Back up both the database and the media, and validate restores on a staging node:

- **Database:** SQLite file snapshot, or `pg_dump`/`pg_restore` on PostgreSQL. The
  admin settings panel and API can trigger backups on either backend.
- **Media & config:** `data/uploads`, `data/files`, `data/backups`, and the
  `paracord.toml` config (which holds the generated JWT secret and cert material —
  keep it protected and backed up separately from database/file snapshots).

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

## See also

- [Getting Started](getting-started.md) — first-run walkthrough.
- [Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md) — full
  operator runbook (nginx/caddy/systemd, monitoring, S3).
- [Docker setup](docker-setup.md) — complete container configuration reference.
- [Deployment profiles](deployment-profiles.md) — baseline dev / single-node /
  testbed values.
- [Known limitations](known-limitations.md) — current support boundaries.
