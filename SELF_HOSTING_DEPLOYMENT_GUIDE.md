# Paracord Self-Hosting Deployment Guide

This guide is the operator-facing reference for production deployments of Paracord.
It covers Docker Compose, systemd, reverse proxy/TLS, PostgreSQL, backups, monitoring, and optional S3-compatible object storage.

## 1. Production Baseline

1. Use PostgreSQL for sustained multi-user production workloads.
2. Keep Paracord behind a reverse proxy (nginx or caddy) with TLS.
3. Run Paracord as a non-root user.
4. Keep `PARACORD_JWT_SECRET`, federation signing key, and at-rest keys outside source control.
5. Back up both database and media volumes.

## 2. Docker Compose (Paracord + PostgreSQL + LiveKit)

```yaml
services:
  paracord:
    image: ghcr.io/YOUR_ORG/paracord:latest
    restart: unless-stopped
    environment:
      PARACORD_BIND_ADDRESS: 0.0.0.0:8090
      PARACORD_PUBLIC_URL: https://chat.example.com
      PARACORD_TLS_ENABLED: "false"
      PARACORD_DATABASE_ENGINE: postgres
      PARACORD_DATABASE_URL: postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord
      PARACORD_DATABASE_MAX_CONNECTIONS: 50
      PARACORD_COOKIE_SECURE: "true"
      PARACORD_TRUST_PROXY: "true"
      PARACORD_TRUSTED_PROXY_IPS: 172.18.0.0/16
      PARACORD_STORAGE_PATH: /data/uploads
      PARACORD_MEDIA_STORAGE_PATH: /data/files
      PARACORD_BACKUP_DIR: /data/backups
      PARACORD_LIVEKIT_URL: ws://livekit:7880
      PARACORD_LIVEKIT_HTTP_URL: http://livekit:7880
      PARACORD_LIVEKIT_PUBLIC_URL: wss://chat.example.com/livekit
      PARACORD_LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      PARACORD_LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
    volumes:
      - paracord-data:/data
    depends_on:
      - postgres
      - livekit
    ports:
      - "127.0.0.1:8090:8090"

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: paracord
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: paracord
    volumes:
      - postgres-data:/var/lib/postgresql/data

  livekit:
    image: livekit/livekit-server:latest
    restart: unless-stopped
    command: --config /etc/livekit.yaml
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
    ports:
      - "127.0.0.1:7880:7880"

volumes:
  paracord-data:
  postgres-data:
```

The example disables Paracord's built-in TLS because TLS is terminated at the reverse proxy. If you do not use a reverse proxy, configure the `[tls]` section directly and expose the HTTPS port instead.

## 3. systemd Service (Binary Deployment)

Create `/etc/systemd/system/paracord.service`:

```ini
[Unit]
Description=Paracord Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paracord
Group=paracord
WorkingDirectory=/opt/paracord
EnvironmentFile=/etc/paracord/paracord.env
ExecStart=/opt/paracord/paracord-server --config /etc/paracord/paracord.toml
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Activate:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now paracord
sudo systemctl status paracord
```

## 4. Reverse Proxy and TLS

### nginx example

```nginx
server {
    listen 80;
    server_name chat.example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### caddy example

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

### Let’s Encrypt

Use certbot (nginx) or built-in caddy automation.
If using Paracord ACME settings directly, configure the `[tls.acme]` section in `paracord.toml`.

## 5. PostgreSQL Setup and SQLite Migration Path

### New production deployment

Use:

```toml
[database]
engine = "postgres"
url = "postgresql://paracord:STRONG_PASSWORD@localhost:5432/paracord?sslmode=prefer"
max_connections = 50
statement_timeout_secs = 30
idle_in_transaction_timeout_secs = 60
work_mem_mb = 16
maintenance_work_mem_mb = 64
```

### Existing SQLite instance

Paracord does not include an automatic in-place SQLite->PostgreSQL data migrator.
Recommended path:

1. Put server in maintenance mode.
2. Export SQLite data with custom SQL scripts for your schema.
3. Import into PostgreSQL.
4. Switch `database.engine` + `database.url`.
5. Start Paracord and verify migrations/health.
6. Keep the old SQLite file as rollback backup until cutover is validated.

## 6. Backups (Database + Media)

Use both:

1. Database backups (`pg_dump` for PostgreSQL or SQLite file snapshot).
2. Media backups (`/data/uploads`, `/data/files`, `/data/backups`).

Suggested schedule:

1. Hourly logical DB backup retained 48h.
2. Daily full backup retained 30d.
3. Weekly backup retained 12w.

Validate restores regularly on a staging node.

## 7. Monitoring and Health

Expose these endpoints to internal monitoring:

1. `GET /health` for liveness/readiness.
2. `GET /metrics` for Prometheus scraping.

Alerting baseline:

1. `/health` non-200 for >2 minutes.
2. Error rate spikes (5xx).
3. Backup job failures.
4. Disk utilization >80% on DB/media volumes.

## 8. Optional Object Storage Configuration

Paracord stores uploads on the local filesystem by default. S3-compatible object
storage is optional and only used when `storage_type = "s3"` and the server is
built with the `s3` feature.

Set in `paracord.toml`:

```toml
[storage]
storage_type = "s3"

[s3]
bucket = "paracord-uploads"
region = "us-east-1"
endpoint_url = "https://s3.example.com" # optional custom S3-compatible endpoint
force_path_style = true                  # optional (MinIO/R2/etc.)
access_key_id = "..."
secret_access_key = "..."
# Optional. Defaults to false so Paracord does not read ambient AWS
# env/profile/SSO/instance-role credentials unless you explicitly opt in.
use_aws_credential_chain = false
prefix = "paracord/"
presign_expiry_seconds = 3600
```

For private buckets, keep presigned URLs enabled and enforce bucket-private ACLs.
Use explicit `access_key_id` and `secret_access_key` for most S3-compatible
providers. Set `use_aws_credential_chain = true` only for deployments that
intentionally rely on AWS-managed credentials.

## 9. Security Checklist

1. Set `PARACORD_COOKIE_SECURE=true`.
2. Set `PARACORD_TRUST_PROXY=true` only behind a trusted reverse proxy.
3. Restrict `PARACORD_TRUSTED_PROXY_IPS` to exact proxy CIDRs.
4. Rotate JWT/federation/secrets periodically.
5. Enable malware scanning for uploads (`PARACORD_MALWARE_SCAN_BIN`) in untrusted communities.
