# Docker Setup

## Quick Start

```bash
# Zero config — no .env, no secrets to enter:
docker compose up -d --build

# View logs
docker compose logs -f paracord
```

The server will be available over plain **HTTP** at `http://localhost:8090`.

There is nothing to fill in. On first run the server generates a strong random
`jwt_secret` (and self-signed media/TLS certs) and persists them to
`/data/paracord.toml` on the `paracord-data` volume, then reuses the same file —
and the same secret — on every restart. Native QUIC/WebTransport voice is the
default media path and needs no extra services. LiveKit is an opt-in fallback
(see [LiveKit](#livekit-voicevideo) below).

> `.env` is entirely optional and only holds overrides (see `.env.example`). It
> is git-ignored; only `.env.example` is tracked. Do not commit secrets.

## TLS & Voice

By default the container serves **plain HTTP on port 8090** — `PARACORD_TLS_ENABLED=false`
in both the Dockerfile and `docker-compose.yml`. There is no built-in HTTPS on
8443 inside Docker.

Browsers only grant microphone, camera, and screen-share access in a **secure
context (HTTPS)**. That means the plain-HTTP Docker deployment **cannot** do
browser voice/screen-share until you put TLS in front of it. Two options:

- **Reverse proxy (recommended):** terminate TLS at Caddy or nginx and proxy to
  `http://localhost:8090` (and `http://localhost:7880` for LiveKit). See the
  [Reverse Proxy (nginx)](#reverse-proxy-nginx) section below.
- **Built-in TLS:** set `PARACORD_TLS_ENABLED=true` and mount certificates into
  the container.

The native desktop client is unaffected and works over plain HTTP.

## Environment Variables

All configuration can be overridden via environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `PARACORD_BIND_ADDRESS` | `0.0.0.0:8090` | Server listen address |
| `PARACORD_SERVER_NAME` | `localhost` | Server hostname |
| `PARACORD_PUBLIC_URL` | (auto-detected) | Public URL for CORS and invite links |
| `PARACORD_DATABASE_URL` | `sqlite:///data/paracord.db?mode=rwc` | SQLite database path |
| `PARACORD_DATABASE_MAX_CONNECTIONS` | `20` | Max database connections |
| `PARACORD_JWT_SECRET` | auto-generated | Not set in Docker. The server generates and persists a random secret to `/data/paracord.toml` on first run and reuses it thereafter |
| `PARACORD_VOICE_NATIVE_MEDIA` | `true` | Native QUIC/WebTransport voice (the default media path); no LiveKit required |
| `PARACORD_REGISTRATION_ENABLED` | `true` | Allow new user registrations |
| `PARACORD_STORAGE_PATH` | `/data/uploads` | File upload storage path |
| `PARACORD_MEDIA_STORAGE_PATH` | `/data/files` | Media file storage path |
| `PARACORD_BACKUP_DIR` | `/data/backups` | Backup storage directory |
| `PARACORD_TLS_ENABLED` | `false` | Disable built-in TLS for the container HTTP quick start; terminate TLS at a reverse proxy in production |
| `PARACORD_LIVEKIT_URL` | `ws://livekit:7880` | Internal LiveKit WebSocket URL (inert unless the `livekit` profile is active and native media is off) |
| `PARACORD_LIVEKIT_HTTP_URL` | `http://livekit:7880` | Internal LiveKit HTTP URL |
| `PARACORD_LIVEKIT_PUBLIC_URL` | (derived from server) | Public LiveKit URL for clients |
| `PARACORD_LIVEKIT_API_KEY` | `paracordlocal` in compose | LiveKit API key id (not a secret); must match the LiveKit service |
| `PARACORD_LIVEKIT_API_SECRET` | local dev default | Shared LiveKit secret; defaults to a local dev value and is read by both the paracord and livekit services. Override in `.env` before exposing LiveKit to a network. `openssl rand -hex 32` |

## Volume Mounts

| Volume | Container Path | Description |
|---|---|---|
| `paracord-data` | `/data` | Config file, database, uploads, media, backups |

## Ports

| Port | Protocol | Service |
|---|---|---|
| 8090 | TCP | HTTP API + WebSocket gateway |
| 8443 | UDP | Native QUIC / WebTransport voice media (raw QUIC desktop + browser WebTransport) |

Forward the UDP 8443 port at your router/firewall in addition to the TCP port so
native voice works across NAT. The native desktop client speaks raw QUIC and
needs no TLS; browser voice requires TLS terminated in front of the container
(see [TLS & Voice](#tls--voice)).

## LiveKit (Voice/Video)

LiveKit is an **opt-in fallback** and is **not started by default** — native
QUIC/WebTransport media is the default voice path. The `livekit` service lives in
a Compose profile, so a plain `docker compose up` starts only `paracord`.

To run the LiveKit fallback:

```bash
# Start paracord + livekit together
docker compose --profile livekit up -d

# Route voice through LiveKit instead of native media by setting
# PARACORD_VOICE_NATIVE_MEDIA=false on the paracord service.
```

It pins `livekit/livekit-server:v1.9.11`, matching the bundled LiveKit version
used by release packaging. Change the tag intentionally when validating a newer
LiveKit release.

### LiveKit ports

| Port | Protocol | Service |
|---|---|---|
| 7880 | TCP | LiveKit signaling (WebSocket + HTTP API) |
| 7881 | TCP | LiveKit TURN/TLS |
| 7882 | UDP | LiveKit WebRTC media |

### Production LiveKit Configuration

Both the paracord and livekit services read `PARACORD_LIVEKIT_API_SECRET`, which
defaults to a local dev value so the fallback works with zero configuration. Set
a strong random value in `.env` before exposing LiveKit to a network:

```dotenv
# .env
PARACORD_LIVEKIT_API_SECRET=<openssl rand -hex 32>
```

To customize the key id or expose a public LiveKit URL, override in
`docker-compose.yml`:

```yaml
environment:
  - PARACORD_LIVEKIT_API_KEY=your-strong-api-key
  - PARACORD_LIVEKIT_PUBLIC_URL=wss://chat.example.com/livekit
```

If you change the key id, update it on the LiveKit service too (the secret still
comes from the shared variable):

```yaml
livekit:
  environment:
    - "LIVEKIT_KEYS=your-strong-api-key: ${PARACORD_LIVEKIT_API_SECRET:-paracord-local-dev-livekit-secret}"
```

## Building Only the Server Image

```bash
docker build -t paracord .
docker run -p 8090:8090 -v paracord-data:/data paracord
```

## Reverse Proxy (nginx)

When running behind a reverse proxy, disable TLS in Paracord and terminate TLS at the proxy:

The provided Dockerfile and `docker-compose.yml` already set `PARACORD_TLS_ENABLED=false` for this topology.

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Overwrite any client-supplied chain at the public edge. Paracord also
        # walks XFF from the trusted right edge, but this is useful defense in depth.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /gateway {
        proxy_pass http://localhost:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /livekit {
        proxy_pass http://localhost:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Data Backup

Backups can be created via the admin dashboard or API:

```bash
# Create a backup
curl -X POST http://localhost:8090/api/v1/admin/backup \
  -H "Authorization: Bearer <admin-token>"

# List backups
curl http://localhost:8090/api/v1/admin/backups \
  -H "Authorization: Bearer <admin-token>"
```

Backup files are stored in the `/data/backups` volume.
