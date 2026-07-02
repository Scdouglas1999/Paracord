# Docker Setup

## Quick Start

```bash
# Build and start all services
docker compose up -d --build

# View logs
docker compose logs -f paracord
```

The server will be available at `http://localhost:8090`.

## Environment Variables

All configuration can be overridden via environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `PARACORD_BIND_ADDRESS` | `0.0.0.0:8090` | Server listen address |
| `PARACORD_SERVER_NAME` | `localhost` | Server hostname |
| `PARACORD_PUBLIC_URL` | (auto-detected) | Public URL for CORS and invite links |
| `PARACORD_DATABASE_URL` | `sqlite:///data/paracord.db?mode=rwc` | SQLite database path |
| `PARACORD_DATABASE_MAX_CONNECTIONS` | `20` | Max database connections |
| `PARACORD_JWT_SECRET` | (auto-generated) | JWT signing secret (set a strong value in production) |
| `PARACORD_REGISTRATION_ENABLED` | `true` | Allow new user registrations |
| `PARACORD_STORAGE_PATH` | `/data/uploads` | File upload storage path |
| `PARACORD_MEDIA_STORAGE_PATH` | `/data/files` | Media file storage path |
| `PARACORD_BACKUP_DIR` | `/data/backups` | Backup storage directory |
| `PARACORD_TLS_ENABLED` | `false` | Disable built-in TLS for the container HTTP quick start; terminate TLS at a reverse proxy in production |
| `PARACORD_LIVEKIT_URL` | `ws://livekit:7880` | Internal LiveKit WebSocket URL |
| `PARACORD_LIVEKIT_HTTP_URL` | `http://livekit:7880` | Internal LiveKit HTTP URL |
| `PARACORD_LIVEKIT_PUBLIC_URL` | (derived from server) | Public LiveKit URL for clients |
| `PARACORD_LIVEKIT_API_KEY` | `paracordlocal` in compose | Local LiveKit API key; must match the LiveKit service |
| `PARACORD_LIVEKIT_API_SECRET` | `localcompose_livekit_secret_0123456789abcdef` in compose | Local LiveKit API secret; must match the LiveKit service |

## Volume Mounts

| Volume | Container Path | Description |
|---|---|---|
| `paracord-data` | `/data` | Config file, database, uploads, media, backups |

## LiveKit (Voice/Video)

The `docker-compose.yml` includes an optional LiveKit service for voice and video chat.
It pins `livekit/livekit-server:v1.9.11`, matching the bundled LiveKit version
used by release packaging. Change the tag intentionally when validating a
newer LiveKit release.

### Ports

| Port | Protocol | Service |
|---|---|---|
| 7880 | TCP | LiveKit signaling (WebSocket + HTTP API) |
| 7881 | TCP | LiveKit TURN/TLS |
| 7882 | UDP | LiveKit WebRTC media |

### Production LiveKit Configuration

The Compose defaults are local-only credentials chosen to satisfy server startup validation. For production, set your own strong credentials:

```yaml
environment:
  - PARACORD_LIVEKIT_API_KEY=your-strong-api-key
  - PARACORD_LIVEKIT_API_SECRET=your-strong-64-char-secret
  - PARACORD_LIVEKIT_PUBLIC_URL=wss://chat.example.com/livekit
```

And update the LiveKit service:

```yaml
livekit:
  environment:
    - "LIVEKIT_KEYS=your-strong-api-key: your-strong-64-char-secret"
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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /gateway {
        proxy_pass http://localhost:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
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
