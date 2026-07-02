<p align="center">
  <img src="docs/logo-banner.svg" alt="Paracord" width="800"/>
</p>

<p align="center">
  A self-hostable, open-source Discord alternative with federation, E2E encryption, and a bot platform.
</p>

<p align="center">
  <a href="../../releases/latest">Download</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="SELF_HOSTING_DEPLOYMENT_GUIDE.md">Deployment Guide</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#docker">Docker</a> &bull;
  <a href="#development">Development</a> &bull;
  <a href="docs/known-limitations.md">Known Limitations</a>
</p>

<p align="center">
  Current release candidate: <strong>v0.9.0</strong>
</p>

---

## The Why

On February 9th, 2026, Discord's CEO announced that they would be starting to roll out age verification in the coming month. This meant that all accounts would be labeled as "teen" and one would have to prove they were an adult through an AI powered face scan or uploading government issued ID. The privacy implications of this should be incredibly obvious, and at least my group of friends that regularly used Discord were 100% against giving Discord any of this information, and frankly, didn't feel they should have to. So Paracord was built as a privacy-first, self-hosted alternative in under a week, with full federation and decentralized operation now being built out in active phases. Many new features are coming to Paracord at breakneck speed, and it already includes many of Nitro's big features like high resolution streaming, just without the paywall :).

## Features

### Text Chat

Guilds, channels, and DMs with the full messaging experience — send, edit, delete, reply, pin, react with emoji, attach files via drag-and-drop, and see who's typing in real-time. Images embed inline with a lightbox viewer (zoom, pan, keyboard navigation), files show name and size, and messages group by author just like you'd expect. Full-text message search with author and date filters. Markdown toolbar with keyboard shortcuts (Ctrl+B, Ctrl+I, etc.) and right-click context menus for quick actions.

![Paracord text chat screenshot](docs/screenshots/text-chat-current.png)

### Threads

Start a thread from any message to branch a conversation without cluttering the main channel. Thread panel slides in from the side so you can follow both the channel and the thread at the same time.

### Polls

Create polls with 2-10 options, optional multi-select, and expiry timers. Votes update live and results render inline in the message feed.

### Forum Channels

Dedicated forum-style channels with tag support for organizing longer-form discussions. Think Discord's forum channels, but self-hosted.

### Voice Chat

WebRTC voice is available through LiveKit, with an optional native media transport under active validation. Mute, deafen, pick your mic and speakers, and toggle noise suppression, echo cancellation, and noise gate. Speaking indicators light up in real-time, and join/leave sounds play when people hop in and out of channels. Configurable keybinds for mute, deafen, and push-to-talk. Split-pane layout for viewing streams while staying in the voice channel.

### Live Streaming

Share your screen or a specific window using the same named quality presets enforced by the server. Native system-audio capture support varies by platform and is still part of the release validation pass; see [known limitations](docs/known-limitations.md) before treating it as production-ready. The stream viewer has quality selection, volume control, a fullscreen button, and an elapsed time counter.

| Preset | Resolution | FPS | Bitrate |
|--------|-----------|-----|---------|
| 720p 30 | 1280x720 | 30 | 2.5 Mbps |
| 1080p 60 | 1920x1080 | 60 | 6 Mbps |
| 1440p 60 | 2560x1440 | 60 | 10 Mbps |
| 4K 60 | 3840x2160 | 60 | 20 Mbps |

### Roles & Permissions

30 granular permission flags with role hierarchy, color-coded role names, and per-channel permission overwrites. Create roles, assign colors and permissions, drag to reorder priority, and assign them to members. Admins get full access; everyone else gets exactly what you give them.

### Friends & DMs

Add friends by username, accept or reject incoming requests, block users you don't want to hear from, and filter your friends list by online status. Open a DM with anyone — DMs use the same full-featured chat as guild channels. DMs support optional end-to-end encryption using X25519 key exchange and AES-GCM.

### Custom Emoji

Upload and manage custom emoji per guild. The emoji picker includes your server's custom emoji alongside standard Unicode emoji with category browsing and search.

### Scheduled Events

Create guild events with start/end times, descriptions, and an RSVP system so members can mark whether they're attending.

### Bots & Webhooks

A full bot platform with a developer dashboard, OAuth2 authorization flow, and bot user accounts. Create bot applications, manage tokens, and install bots to guilds. Webhooks let external services push messages into channels with secure token management.

### Server Discovery

Browse public guilds with categories and search. New guilds are private by default; server owners can explicitly list their guilds for discovery so new users can find communities without needing an invite link.

### Moderation

Ban and kick members (with reasons), browse a full audit log of every admin action — role changes, channel edits, kicks, bans, invite management — and manage active invites from the guild settings panel. The first registered user on a server is auto-promoted to admin.

### Server Admin

Admins can toggle registration, rename the server, set a description, cap guilds-per-user and members-per-guild, view server stats, manage all users and guilds, browse security event logs, configure data retention policies, manage backups, and trigger a remote update & restart — all from the settings panel.

### Security

Paracord takes security seriously. The server ships with:

- **Session-backed JWTs** with refresh token rotation and device tracking
- **Rate limiting** with per-IP, per-device, and per-account guards with exponential backoff
- **File upload security** — attachment ownership enforcement, content-type validation, malware scanning hooks
- **TLS** — auto-generated self-signed certs, ACME/Let's Encrypt support, HSTS
- **Security headers** — CSP, X-Content-Type-Options, X-Frame-Options, CORP, COOP
- **At-rest encryption** — AES-256-GCM file encryption, optional SQLCipher database encryption
- **E2E encrypted DMs** — X25519 key exchange + AES-GCM
- **Audit trail** — security events logged for all sensitive operations
- **Cryptographic identity** — Ed25519 keypair authentication with BIP39 recovery phrases

#### Production Hardening Checklist

For internet-facing deployments, use this baseline:

1. Terminate TLS at your edge (nginx/caddy/traefik) and keep upstream Paracord on a private network.
2. Set `public_url` to your canonical HTTPS origin and enable secure cookies with `PARACORD_COOKIE_SECURE=true`.
3. If using a reverse proxy, set `PARACORD_TRUST_PROXY=true` and restrict `PARACORD_TRUSTED_PROXY_IPS` to exact proxy IPs only.
4. Keep auth and global rate limits enabled (defaults: global `120/s`, auth `60/min`, bot `300/min`, bot writes `5/s`) and tune only upward after observing production traffic.
5. Configure malware scanning (`PARACORD_MALWARE_SCAN_BIN`) for file uploads in untrusted communities.
6. Treat federation as an explicit trust model: only add vetted peer servers and rotate signing keys on compromise.
7. Back up and protect encryption material (JWT secret, at-rest encryption key, federation signing key) separately from database/file backups.

Minimal reverse proxy headers (example): `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`.

### Federation

Server-to-server federation is in active development with the transport layer already in place. It is disabled by default for new installs and should only be enabled after configuring trusted peer servers and key rotation procedures:

- Ed25519 HTTP signature verification for all federated requests
- `.well-known/paracord/server` discovery protocol
- Server key exchange and trust management
- Cross-server event ingestion with body hashing and clock skew tolerance
- Namespace and membership sync primitives
- Federated media relay for voice

### Self-Hosted & Zero-Config

One binary, one SQLite database, zero external dependencies. Run the server and it auto-generates config, TLS certificates, and database on first start. The web UI is baked into the server binary — no separate web server, no Docker, no nginx.

### Desktop Client

Native app built with Tauri v2 for Windows and Linux. Auto-trusts self-signed server certificates so you don't have to click through browser warnings. Native system-audio capture for streams is platform-specific and still under release validation; macOS system audio capture is not yet supported. Configurable keybinds for mute, deafen, and push-to-talk. Official signed releases can use the built-in updater when updater artifacts are published. Activity detection broadcasts what you're running as rich presence.

### Multi-Server

Connect to multiple Paracord servers at once. A server rail in the sidebar lets you switch between connected servers, each with its own gateway connection and state. Your Ed25519 identity carries across servers — no need to create separate accounts.

### Appearance

Dark, light, and AMOLED black themes. Compact or cozy message density. Custom CSS support. The UI is a command palette shortcut away from anywhere (Ctrl+K).

### Coming Soon

- **Federation parity** — Full cross-server messaging, membership sync, and moderation in progress
- **Video calls** — Camera in voice channels (backend support exists, UI in progress)
- **macOS native audio capture** — Falls back to browser audio today; ScreenCaptureKit planned

## Download

Grab the latest release from the [Releases page](../../releases/latest).

### Server

| Platform | Download | What's Included |
|----------|----------|-----------------|
| Windows x64 | `paracord-server-windows-x64-*.zip` | Server + LiveKit bundled. Extract and run. |
| Linux x64 | `paracord-server-linux-x64-*.tar.gz` | Server + LiveKit bundled. Extract, chmod +x, run. |

### Desktop Client

| Platform | Download | Format |
|----------|----------|--------|
| Windows | `Paracord_*_x64-setup.exe` | Installer with Start Menu shortcut |
| Windows | `Paracord_*_x64_en-US.msi` | MSI for silent/enterprise deployment |
| Linux | `Paracord_*_amd64.deb` | Debian/Ubuntu package |

### Browser

No download needed — open `https://<server-ip>:8443` in any modern browser.

## Quick Start

### Hosting a Server

**Windows:**
1. Download and extract the server zip
2. Double-click `paracord-server.exe`
3. Config, database, and TLS certs are auto-created on first run
4. Share the URL printed in the console with friends

**Linux:**
```bash
tar xzf paracord-server-linux-x64-*.tar.gz
chmod +x paracord-server livekit-server
./paracord-server
```

That's it. For remote access, forward TCP+UDP port 8080 and TCP port 8443 (HTTPS) on your router/firewall.

### Docker

```bash
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord
cp .env.example .env
# Fill in the required secrets before starting (each must be unique + random):
#   PARACORD_JWT_SECRET=$(openssl rand -hex 32)
#   PARACORD_LIVEKIT_API_SECRET=$(openssl rand -hex 32)
# Edit .env and paste the generated values. `docker compose up` intentionally
# fails fast until both secrets are set.
docker compose up -d
```

This starts the Paracord server and a LiveKit SFU instance. See `docker-compose.yml` for the full list of environment variables, or check [docs/docker-setup.md](docs/docker-setup.md) for detailed configuration.

Once running, the Docker stack serves plain **HTTP** at `http://<server-ip>:8090` (there is no TLS on 8443 in the container).

> **Voice/screen-share on Docker needs HTTPS.** Browsers only grant microphone, camera, and screen-share access in a secure context, so the plain-HTTP Docker deployment **must** sit behind a TLS-terminating reverse proxy (Caddy/nginx) — or run with `PARACORD_TLS_ENABLED=true` and mounted certificates — before mic/camera/screen-share work in a browser. The native desktop client is unaffected. See [docs/docker-setup.md](docs/docker-setup.md) for a reverse-proxy example.

### Joining a Server

**Desktop app:** Install, paste the server URL, create an account.

**Browser (native/binary server):** Navigate to `https://<server-ip>:8443`, accept the self-signed certificate warning, and create an account. (Docker users connect over `http://<server-ip>:8090` instead — see the Docker note above.)

> **Why HTTPS?** Browsers require a secure context for microphone and camera access. The **native/binary** server auto-generates self-signed TLS certificates and serves HTTPS on port 8443 so voice and streaming work out of the box. This does **not** apply to the Docker stack, which serves plain HTTP on 8090 and needs a TLS reverse proxy in front for browser voice.

## Configuration

The server auto-generates `config/paracord.toml` on first run with:
- Random JWT secret and LiveKit API credentials
- SQLite database in `./data/`
- Local upload storage in `./data/uploads/`
- TLS certificates in `./data/certs/`
- Manual port forwarding for internet exposure

All settings can be overridden via environment variables prefixed with `PARACORD_`. See `paracord.example.toml` in the server package for the full reference.

Uploads use the local filesystem by default; Paracord does not require AWS or any cloud storage service. Operators who want object storage can enable the optional S3-compatible backend for MinIO, Cloudflare R2, DigitalOcean Spaces, or AWS S3 by building with the `s3` feature and setting `storage_type = "s3"`. See [the deployment guide](SELF_HOSTING_DEPLOYMENT_GUIDE.md#8-optional-object-storage-configuration) for the explicit opt-in configuration.

<details>
<summary><h3>Using PostgreSQL Instead of SQLite</h3></summary>

Paracord uses SQLite by default — zero setup, single file, works out of the box. But if you're running a larger server or want the operational tooling that comes with a traditional database, Paracord also supports PostgreSQL as a drop-in alternative. All features work identically on both backends.

#### 1. Install PostgreSQL

<details>
<summary><strong>Windows</strong></summary>

1. Download the installer from [postgresql.org/download/windows](https://www.postgresql.org/download/windows/) (pick the latest version 16.x)
2. Run the installer. Use all the defaults and set a password for the `postgres` superuser when prompted — **remember this password**
3. When asked about components, make sure **"Command Line Tools"** is checked (it is by default)
4. Finish the installer. The PostgreSQL service starts automatically

The installer adds `psql` and other tools to `C:\Program Files\PostgreSQL\16\bin\`. If you want to use them from any terminal, add that directory to your system PATH:
```
Settings → System → About → Advanced system settings → Environment Variables → Path → Edit → New
```
Add: `C:\Program Files\PostgreSQL\16\bin`

To verify it's running, open **Command Prompt** or **PowerShell** and run:
```cmd
psql -U postgres
```
Enter the password you set during installation. If you see a `postgres=#` prompt, you're good. Type `\q` to exit.

</details>

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

</details>

<details>
<summary><strong>Docker (standalone)</strong></summary>

```bash
docker run -d --name paracord-postgres \
  -e POSTGRES_USER=paracord \
  -e POSTGRES_PASSWORD=changeme \
  -e POSTGRES_DB=paracord \
  -p 5432:5432 \
  -v pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

This creates the database and user automatically — skip step 2.

</details>

PostgreSQL 12 or newer is required. Version 16 is recommended.

#### 2. Create a Database and User

Skip this step if you used the Docker command above.

**Windows** — open Command Prompt or PowerShell:
```cmd
psql -U postgres
```
Enter the password you set during installation when prompted.

**Linux:**
```bash
sudo -u postgres psql
```

Then run these SQL commands:
```sql
CREATE USER paracord WITH PASSWORD 'pick-a-strong-password';
CREATE DATABASE paracord OWNER paracord;
```

Type `\q` to exit.

To verify the new database works:
```cmd
psql -U paracord -d paracord -h localhost
```
Enter the password you just set. If you get a `paracord=>` prompt, the database is ready.

#### 3. Point Paracord at PostgreSQL

Open your `paracord.toml` (auto-generated on first server run in the `config/` directory) and update the `[database]` section:

```toml
[database]
engine = "postgres"
url = "postgresql://paracord:pick-a-strong-password@localhost:5432/paracord"
max_connections = 20
```

That's the minimum needed. The `engine` field tells Paracord which migration track to use, and the `url` is a standard PostgreSQL connection string.

**Or use environment variables** (useful for Docker / CI):

Linux / macOS:
```bash
export PARACORD_DATABASE_ENGINE=postgres
export PARACORD_DATABASE_URL="postgresql://paracord:pick-a-strong-password@localhost:5432/paracord"
```

Windows (Command Prompt):
```cmd
set PARACORD_DATABASE_ENGINE=postgres
set PARACORD_DATABASE_URL=postgresql://paracord:pick-a-strong-password@localhost:5432/paracord
```

Windows (PowerShell):
```powershell
$env:PARACORD_DATABASE_ENGINE = "postgres"
$env:PARACORD_DATABASE_URL = "postgresql://paracord:pick-a-strong-password@localhost:5432/paracord"
```

Environment variables always override the config file.

#### 4. Start the Server

**Windows:**
```cmd
paracord-server.exe --config config\paracord.toml
```

**Linux:**
```bash
./paracord-server --config config/paracord.toml
```

Paracord runs its PostgreSQL migration track automatically on startup. You'll see:
```
migrations: applied successfully
```

That's it — you're running on PostgreSQL.

#### 5. Docker Compose with PostgreSQL

If you're using Docker Compose, add a `postgres` service and update the Paracord environment:

```yaml
services:
  paracord:
    # ... existing paracord config ...
    environment:
      - PARACORD_DATABASE_ENGINE=postgres
      - PARACORD_DATABASE_URL=postgresql://paracord:changeme@postgres:5432/paracord
      - PARACORD_DATABASE_MAX_CONNECTIONS=20
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=paracord
      - POSTGRES_PASSWORD=changeme
      - POSTGRES_DB=paracord
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  postgres-data:
```

#### Optional Tuning

These are safe to leave at defaults but useful for production:

```toml
[database]
engine = "postgres"
url = "postgresql://paracord:password@localhost:5432/paracord?sslmode=prefer"
max_connections = 20

# Kill any single query that runs longer than 30 seconds (0 = no limit)
statement_timeout_secs = 30

# Kill transactions that sit idle for over 60 seconds (0 = no limit)
idle_in_transaction_timeout_secs = 60

# Per-connection sort/hash memory for PostgreSQL (0 = server default)
work_mem_mb = 16

# Per-connection maintenance memory (0 = server default)
maintenance_work_mem_mb = 64
```

Paracord also automatically sets `lock_timeout = 10s` and `timezone = UTC` on every connection.

**Pool sizing guidance:**
- Small deployments (< 200 concurrent users): `max_connections = 20` is usually fine.
- Medium deployments (200-1000 concurrent users): start at `max_connections = 50`.
- Large deployments (> 1000 concurrent users): plan for `max_connections = 75-100` and tune with DB monitoring.

**When to move from SQLite to PostgreSQL:**
- Sustained > 500 concurrent users.
- Message history reaching ~1M+ records.
- Frequent SQLite `busy_timeout` warnings or write stalls under peak load.
- Need for external DB tooling (replicas, managed backups, query observability).

**Permission cache sizing:**
```toml
[server]
permission_cache_max_entries = 10000
```
Raise this for large guild/channel footprints to reduce permission recomputation churn.
Environment variable: `PARACORD_PERMISSION_CACHE_MAX_ENTRIES`.

**Environment variable equivalents:**
| Config Key | Environment Variable |
|---|---|
| `engine` | `PARACORD_DATABASE_ENGINE` |
| `url` | `PARACORD_DATABASE_URL` |
| `max_connections` | `PARACORD_DATABASE_MAX_CONNECTIONS` |
| `statement_timeout_secs` | `PARACORD_DATABASE_STATEMENT_TIMEOUT_SECS` |
| `idle_in_transaction_timeout_secs` | `PARACORD_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_SECS` |
| `work_mem_mb` | `PARACORD_DATABASE_WORK_MEM_MB` |
| `maintenance_work_mem_mb` | `PARACORD_DATABASE_MAINTENANCE_WORK_MEM_MB` |

#### Connection String Reference

| Scenario | URL |
|---|---|
| Local, no password | `postgresql://localhost:5432/paracord` |
| Local with auth | `postgresql://user:password@localhost:5432/paracord` |
| SSL preferred (default) | `postgresql://user:password@host:5432/paracord?sslmode=prefer` |
| SSL required | `postgresql://user:password@host:5432/paracord?sslmode=require` |
| Remote server | `postgresql://user:password@db.example.com:5432/paracord?sslmode=require` |

#### Backups

When running on PostgreSQL, Paracord's built-in backup system uses `pg_dump` and `pg_restore` instead of SQLite's `.backup` command. Backups can be triggered from the admin settings panel or the API, and work the same way regardless of which database backend you're using.

#### Migrating from SQLite to PostgreSQL

There is no built-in migration tool to move data from an existing SQLite database to PostgreSQL. If you need to migrate, export your data manually (e.g. via SQL dump scripts) before switching the engine. For new deployments, just start with PostgreSQL from the beginning if you know you'll want it.

</details>

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Rust (axum, tokio, SQLx) |
| Client | Tauri v2 + React 19 + TypeScript |
| Database | SQLite (default, zero-config) or PostgreSQL + optional SQLCipher encryption |
| Voice/Video | LiveKit SFU (bundled) |
| State | Zustand v5 |
| Styling | Tailwind CSS v4 |
| Auth | Argon2 hashing, JWT sessions, Ed25519 cryptographic identity |
| Encryption | X25519 + AES-GCM (E2E DMs), AES-256-GCM (at-rest) |
| TLS | rustls + rcgen auto-certs, ACME/Let's Encrypt |
| Networking | Manual router/firewall port forwarding |
| CI/CD | GitHub Actions (build, test, security audit, DAST) |
| Testing | Vitest + Playwright E2E |

## Platform Support

| | Server | Desktop Client | Browser |
|---|---|---|---|
| **Windows x64** | Yes | Yes | Yes |
| **Linux x64** | Yes | Yes (.deb) | Yes |
| **macOS** | Build from source | Build from source | Yes |

## Development

### Prerequisites
- [Rust 1.88+](https://rustup.rs/)
- [Node.js 22+](https://nodejs.org/)

### Running Locally

```bash
# Clone and enter project
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord

# Terminal 1: client dev server
cd client
npm install
npm run dev

# Terminal 2: server (Vite proxies API/WS to it)
cargo run --bin paracord-server --no-default-features
```

### Building for Release

```bash
# Build client web UI
cd client && npm install && npm run build && cd ..

# Build server with embedded web UI
cargo build --release --bin paracord-server

# The binary includes the web UI; no --web-dir needed
./target/release/paracord-server
```

### Building the Desktop Client

```bash
cd client
npm install
npx tauri build
```

Produces an Inno Setup `.exe` installer plus a Tauri `.msi` on Windows, and `.deb` plus `.AppImage` bundles on Linux in the release workflow.

## Project Structure

```
paracord/
|-- crates/                 # Rust server workspace
|   |-- paracord-server/    # Binary entry point, TLS, LiveKit management
|   |-- paracord-api/       # REST API routes (90+ endpoints)
|   |-- paracord-ws/        # WebSocket gateway (events, presence, typing)
|   |-- paracord-core/      # Business logic, permissions engine, event bus
|   |-- paracord-db/        # SQLite/PostgreSQL via SQLx
|   |-- paracord-federation/# Server-to-server federation (Ed25519 signed transport)
|   |-- paracord-models/    # Shared types and data structures
|   |-- paracord-media/     # File storage (local + optional object storage) + LiveKit voice/streaming
|   `-- paracord-util/      # Snowflake IDs, validation, at-rest encryption
|-- client/                 # Tauri v2 + React client
|   |-- src/                # React TypeScript frontend
|   |   |-- components/     # UI (chat, voice, guilds, threads, polls, forums, bots)
|   |   |-- stores/         # 17 Zustand state stores
|   |   |-- gateway/        # WebSocket connection + event dispatch
|   |   `-- pages/          # 20 route pages
|   |-- src-tauri/          # Native Rust backend (system audio, TLS, signed updater support)
|   `-- e2e/                # Playwright E2E tests
|-- docs/                   # Design specs, security docs, API contracts
`-- docker-compose.yml      # Docker deployment with LiveKit
```

## License

Source-available. See [LICENSE](LICENSE) for full terms. You may use, study, and modify the software for personal use, and share official releases. Redistribution of modified versions and derivative works is not permitted without written permission.

