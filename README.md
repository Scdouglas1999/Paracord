<p align="center">
  <img src="docs/logo-banner.svg" alt="Paracord" width="800"/>
</p>

<p align="center">
  <strong>Paracord 1.0</strong> — a self-hosted Discord alternative you can stand up in one command.<br/>
  Native QUIC voice &amp; video, end-to-end encrypted DMs, federation, bots, and a redesigned desktop client — no LiveKit required.
</p>

<p align="center">
  <a href="../../releases/latest">Download</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="docs/getting-started.md">Getting Started</a> &bull;
  <a href="docs/deployment.md">Deployment</a> &bull;
  <a href="#key-features">Features</a> &bull;
  <a href="#development">Development</a> &bull;
  <a href="docs/known-limitations.md">Known Limitations</a>
</p>

<p align="center">
  Current release: <strong>v1.0.0</strong>
</p>

---

## What is Paracord?

Paracord is an open-source, privacy-first chat platform you run on your own hardware. One binary (or one `docker compose up`) gives you guilds, channels, DMs, voice, screen share, roles, moderation, bots, and optional server-to-server federation — without handing your community's data to a third party.

**v1.0.0** is the first public release. It focuses on what self-hosters actually need: zero-config first run, native QUIC media out of the box, a single port to forward, and a desktop client with a fresh **Emerald Commons** UI and **Rooms + Unified Stream** layout.

The **first account you register becomes the server owner/admin**. Voice and video run on Paracord's own end-to-end-encrypted QUIC/WebTransport engine by default — LiveKit is fully optional.

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/readme/unified-sidebar.png" alt="Unified sidebar with Needs you, Recent, and Spaces across all servers" width="100%"/>
      <br/><sub><strong>Unified Stream</strong> — mentions, DMs, and recent conversations from every connected server in one sidebar</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/readme/rooms-view.png" alt="Rooms view showing live voice rooms and text channels" width="100%"/>
      <br/><sub><strong>Rooms view</strong> — presence-first home for each server: who's in voice, who's around, channels below</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/readme/text-chat.png" alt="Text chat with Emerald Commons dark theme" width="100%"/>
      <br/><sub><strong>Text chat</strong> — threads, reactions, pins, search, markdown, and file uploads</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/readme/home.png" alt="Paracord home dashboard" width="100%"/>
      <br/><sub><strong>Home</strong> — friends, activity, and quick navigation into your spaces</sub>
    </td>
  </tr>
</table>

---

## Key Features

### Zero-config self-hosting

No secrets to generate, no voice infrastructure to wire up, no database to provision. Start the server and it creates `config/paracord.toml`, a random JWT secret, the SQLite database, and a self-signed TLS certificate — then prints the URL to open and share. `docker compose up` needs no `.env` editing; everything persists into the data volume on first run.

### Native QUIC media (default)

Voice, video, and screen share run on Paracord's own QUIC/WebTransport engine with E2EE. Desktop clients speak raw QUIC; browsers use WebTransport over HTTP/3. **One port to forward** for remote access: `8443` over **both TCP and UDP** (HTTPS + gateway on TCP, native media on UDP). LiveKit remains available as an optional WebRTC SFU for legacy interop or very large rooms — not a requirement.

### Emerald Commons UI

A mature, expressive design language: warm-neutral dark surfaces, a calibrated emerald primary accent, runtime CSS tokens, and four built-in themes (dark, light, AMOLED, high-contrast) plus custom CSS. See [docs/design-spec.md](docs/design-spec.md).

### Rooms + Unified Stream layout

The v1.0 client retires the Discord skeleton for a bolder information architecture: one attention-ranked **unified sidebar** (Needs you / Recent / Spaces across all servers), a full-width content pane, and a contextual right panel (members, threads, pins, search) that toggles on demand. Opening a server lands on its **Rooms view** — live voice rooms as occupant cards, presence, and grouped text channels. See [docs/layout-spec.md](docs/layout-spec.md).

### Bots & webhooks

Full bot platform with developer dashboard, OAuth2 authorization, bot user accounts, slash commands, and webhooks for external integrations.

### Federation

Server-to-server federation via Ed25519-signed HTTP envelopes. Disabled by default; enable only after configuring trusted peers. Cross-server messaging, file proxying, and federated discovery are built in.

### End-to-end encrypted DMs

Optional E2EE for direct messages using X25519 key exchange and AES-GCM, alongside session-backed JWT auth and Ed25519 cryptographic identity.

### Multi-server

Connect to multiple Paracord servers at once. The unified sidebar merges mentions, DMs, and recent conversations from **every** connected server. Your Ed25519 identity carries across servers — one account, many communities.

### Everything else you'd expect

Guilds, channels, threads, polls, forum channels, custom emoji, scheduled events, roles & permissions (30 flags), friends & DMs, server discovery, moderation & audit logs, file storage policies, and a Tauri v2 desktop client for Windows and Linux.

---

## Quick Start

Paracord is zero-config. Pick a path and you have a running server in minutes.

### Path A — single executable

```bash
# Linux (from the extracted release tarball)
./paracord-server
```

```powershell
# Windows: double-click paracord-server.exe, or:
.\paracord-server.exe
```

On first run the binary generates config, database, TLS certs, and prints the URL to open. Register the **first account** — it becomes the server owner.

Prefer to read instructions before starting?

```bash
./paracord-server init      # writes config/paracord.toml (if missing), prints next steps, exits
./paracord-server           # start the server (-c <path> for a custom config location)
```

### Path B — Docker Compose

```bash
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord
docker compose up -d        # no .env, no secrets — the server generates and persists them
```

The Docker stack serves the web UI over plain **HTTP on `8090`** (native media on UDP `8443`) and expects TLS at a reverse proxy for browser voice. The native desktop client speaks raw QUIC and is unaffected. See [docs/getting-started.md](docs/getting-started.md) and [docs/deployment.md](docs/deployment.md).

### One port to forward

For access from outside your network, forward **`8443` over both TCP and UDP** to the host running the server. TCP carries HTTPS (web UI + gateway); UDP carries native QUIC voice/video.

---

## Desktop Client

Grab installers from the **[Releases page](../../releases/latest)**.

| Platform | Format |
|----------|--------|
| Windows | `.exe` installer (Start Menu shortcut) or `.msi` for enterprise deployment |
| Linux | `.deb` for Debian/Ubuntu |
| Browser | Open `https://<server-ip>:8443` — no download needed |

The desktop app auto-trusts self-signed server certificates, runs the full native audio pipeline (Opus + RNNoise + E2EE over QUIC), and supports VP9 screen share when built with libvpx. Official signed releases can use the built-in updater when updater artifacts are published.

---

## Architecture

Paracord is a Rust server workspace plus a Tauri v2 + React 19 desktop client.

| Layer | Technology |
|-------|-----------|
| Server | Rust (axum, tokio, SQLx) — 13 crates |
| Client | Tauri v2 + React 19 + TypeScript + Tailwind CSS v4 |
| Database | SQLite (default) or PostgreSQL |
| Voice/Video | Native QUIC/WebTransport (`paracord-transport`, `paracord-relay`, `paracord-codec`) + optional LiveKit SFU |
| Auth | Argon2, JWT sessions, Ed25519 identity |
| Encryption | X25519 + AES-GCM (E2EE DMs), AES-256-GCM (at-rest) |
| State (client) | Zustand v5 |

```
paracord/
├── crates/
│   ├── paracord-server/     # Binary entry point, TLS, config
│   ├── paracord-api/        # REST API routes
│   ├── paracord-ws/         # WebSocket gateway
│   ├── paracord-core/       # Business logic, permissions, event bus
│   ├── paracord-db/         # SQLite / PostgreSQL via SQLx
│   ├── paracord-transport/  # QUIC / WebTransport media transport
│   ├── paracord-relay/      # Media routing, VAD, E2EE
│   ├── paracord-codec/      # Opus, RNNoise, VP9
│   ├── paracord-federation/ # Server-to-server federation
│   └── paracord-media/      # File storage + optional LiveKit
├── client/                  # Tauri + React desktop app
└── docker-compose.yml       # Container deployment
```

The web UI is embedded in the server binary — no separate frontend server required for production.

---

## Development

### Prerequisites

- [Rust 1.88+](https://rustup.rs/)
- [Node.js 22+](https://nodejs.org/)

### Run locally

```bash
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord

# Terminal 1: client dev server (Vite on :1420, proxies API/WS to server)
cd client && npm install && npm run dev

# Terminal 2: server
cargo run --bin paracord-server --no-default-features
```

### Build & test

```bash
# Fast type-check (no codegen)
cargo check --workspace

# All Rust tests
cargo test --workspace

# Client typecheck + unit tests
cd client && npm test

# Vitest only (CI mode)
cd client && npm run test:unit

# Production client build
cd client && npm run build

# Release server with embedded UI
cargo build --release --bin paracord-server
```

### Desktop client build

The desktop client links **libvpx** for VP9 video — the `vpx` feature is on by default and required for screen share. **Do not disable it.**

```bash
# Linux / macOS — install libvpx first
sudo pacman -S libvpx webkit2gtk-4.1   # Arch/CachyOS
# sudo apt install libvpx-dev webkit2gtk-4.1-dev   # Debian/Ubuntu
# brew install libvpx   # macOS

cd client && npm install && npx tauri build
```

Windows developers source `scripts/set-vpx-env.ps1` for vcpkg libvpx paths. See [CLAUDE.md](CLAUDE.md) for full build notes.

### Linting

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
```

---

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Step-by-step first-run walkthrough |
| [Deployment](docs/deployment.md) | Production: reverse proxy TLS, UDP forwarding, `PUBLIC_URL`, PostgreSQL, backups |
| [Design Spec](docs/design-spec.md) | Emerald Commons design language contract |
| [Layout Spec](docs/layout-spec.md) | Rooms + Unified Stream information architecture |
| [Docker Setup](docs/docker-setup.md) | Full container configuration reference |
| [Known Limitations](docs/known-limitations.md) | Current support boundaries |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Full v1.0.0 changelog |

---

## License & Contributing

Paracord is **source-available** under the [Paracord Source-Available License](LICENSE) (Copyright © 2026 Sean Douglas). You may use, study, and modify the software for personal use and share official releases. Redistribution of modified versions and derivative works requires written permission from the author.

Issues and pull requests are welcome on GitHub. For security concerns, review [docs/](docs/) security documentation before reporting.

---

<p align="center">
  <sub>Built for communities who want their conversations back.</sub>
</p>
