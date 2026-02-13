<p align="center">
  <img src="docs/logo-banner.svg" alt="Paracord" width="800"/>
</p>

<p align="center">
  A decentralized, self-hostable, open-source Discord alternative.
</p>

<p align="center">
  <a href="../../releases/latest">Download</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#development">Development</a>
</p>

---

## The Why

On February 9th, 2026, Discord's CEO announced that they would be starting to roll out age verification in the coming month. This meant that all accounts would be labeled as "teen" and one would have to prove they were an adult through an AI powered face scan or uploading government issued ID. The privacy implications of this should be incredibly obvious, and at least my group of friends that regularly used Discord were 100% against giving Discord any of this information, and frankly, didn't feel they should have to. But Discord doesn't have any magic that makes them untouchable in the software space, so here we are, a completely decentralized Discord alternative, gotten up and running in under a week from their announcement. Many new features will be coming to Paracord at breakneck speed, and it already includes many of Nitro's big features like high resolution streaming, just without the paywall :).

## Features

### Text Chat

Guilds, channels, and DMs with the full messaging experience — send, edit, delete, reply, pin, react with emoji, attach files via drag-and-drop, and see who's typing in real-time. Images embed inline, files show name and size, and messages group by author just like you'd expect.

<img width="2537" height="1387" alt="image" src="https://github.com/user-attachments/assets/e6e4da61-1352-4e17-bd5e-b2a350aac3b4" />

### Voice Chat

WebRTC voice powered by a bundled LiveKit SFU. Mute, deafen, pick your mic and speakers, and toggle noise suppression, echo cancellation, and noise gate. Speaking indicators light up in real-time, and join/leave sounds play when people hop in and out of channels. Configurable keybinds for mute, deafen, and push-to-talk.

<!-- Screenshot: voice channel with participants and speaking indicators -->
<!-- ![Voice chat](docs/screenshots/voice-chat.png) -->

### Live Streaming

Share your screen or a specific window at up to 4K/100Mbps with six quality presets. System audio is captured natively on Windows (WASAPI loopback) and Linux (PulseAudio monitor) so viewers actually hear your game or movie audio — not just silence. The stream viewer has quality selection, volume control, a fullscreen button, and an elapsed time counter.

| Preset | Resolution | FPS | Bitrate |
|--------|-----------|-----|---------|
| 720p 30 | 1280x720 | 30 | 5 Mbps |
| 1080p 60 | 1920x1080 | 60 | 15 Mbps |
| 1440p 60 | 2560x1440 | 60 | 25 Mbps |
| 4K 60 | 3840x2160 | 60 | 40 Mbps |
| Movie 50 | 3840x2160 | 60 | 50 Mbps |
| Movie 100 | 3840x2160 | 60 | 100 Mbps |

<!-- Screenshot: stream viewer with quality selector -->
<!-- ![Streaming](docs/screenshots/streaming.png) -->

### Roles & Permissions

30 granular permission flags with role hierarchy, color-coded role names, and per-channel permission overwrites. Create roles, assign colors and permissions, drag to reorder priority, and assign them to members. Admins get full access; everyone else gets exactly what you give them.

### Friends & DMs

Add friends by username, accept or reject incoming requests, block users you don't want to hear from, and filter your friends list by online status. Open a DM with anyone — DMs use the same full-featured chat as guild channels.

<!-- Screenshot: friends list with online/offline status -->
<!-- ![Friends](docs/screenshots/friends.png) -->

### Moderation

Ban and kick members (with reasons), browse a full audit log of every admin action — role changes, channel edits, kicks, bans, invite management — and manage active invites from the guild settings panel. The first registered user on a server is auto-promoted to admin.

### Server Admin

Admins can toggle registration, rename the server, set a description, cap guilds-per-user and members-per-guild, view server stats, manage all users and guilds, and trigger a remote update & restart that pulls the latest code, rebuilds, and restarts the server — all from the settings panel.

### Self-Hosted & Zero-Config

One binary, one SQLite database, zero external dependencies. Run the server and it auto-generates config, TLS certificates, and database on first start. UPnP (with NAT-PMP/PCP fallback) auto-forwards ports on most home routers. The web UI is baked into the server binary — no separate web server, no Docker, no nginx.

### Desktop Client

Native app built with Tauri v2 for Windows and Linux. Auto-trusts self-signed server certificates so you don't have to click through browser warnings. Captures system audio natively for streams (WASAPI on Windows, PulseAudio on Linux). Configurable keybinds for mute, deafen, and push-to-talk.

<!-- Screenshot: desktop client window -->
<!-- ![Desktop client](docs/screenshots/desktop-app.png) -->

### Appearance

Dark, light, and AMOLED black themes. Compact or cozy message density. The UI is a command palette shortcut away from anywhere (Ctrl+K).

### Coming Soon

- **Federation** — Server-to-server communication (infrastructure scaffolded, protocol not yet active)
- **Video calls** — Camera in voice channels (backend support exists, UI in progress)
- **Custom emojis** — Database ready, upload and management UI coming
- **macOS native audio capture** — Falls back to browser audio today; ScreenCaptureKit planned
- **Threads** — Reply chains exist, dedicated thread view coming

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

That's it. UPnP auto-forwards ports on most home routers. If your router doesn't support UPnP, forward TCP+UDP port 8080 and TCP port 8443 (HTTPS).

### Joining a Server

**Desktop app:** Install, paste the server URL, create an account.

**Browser:** Navigate to `https://<server-ip>:8443`, accept the self-signed certificate warning, and create an account.

> **Why HTTPS?** Browsers require a secure context for microphone and camera access. The server auto-generates self-signed TLS certificates and serves HTTPS on port 8443 so voice and streaming work out of the box.

## Configuration

The server auto-generates `config/paracord.toml` on first run with:
- Random JWT secret and LiveKit API credentials
- SQLite database in `./data/`
- TLS certificates in `./data/certs/`
- UPnP enabled by default

All settings can be overridden via environment variables prefixed with `PARACORD_`. See `paracord.example.toml` in the server package for the full reference.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Rust (axum, tokio, SQLx) |
| Client | Tauri v2 + React 19 + TypeScript |
| Database | SQLite (embedded, zero-config) |
| Voice/Video | LiveKit SFU (bundled) |
| State | Zustand v5 |
| Styling | Tailwind CSS v4 |
| Auth | Argon2 password hashing, JWT tokens |
| TLS | rustls + rcgen auto-generated certificates |
| Networking | UPnP IGD + NAT-PMP/PCP fallback |

## Platform Support

| | Server | Desktop Client | Browser |
|---|---|---|---|
| **Windows x64** | Yes | Yes | Yes |
| **Linux x64** | Yes | Yes (.deb) | Yes |
| **macOS** | Build from source | Build from source | Yes |

## Development

### Prerequisites
- [Rust 1.85+](https://rustup.rs/)
- [Node.js 22+](https://nodejs.org/)

### Running Locally

```bash
# Clone and enter project
git clone <repo-url>
cd paracord

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

# The binary includes the web UI — no --web-dir needed
./target/release/paracord-server
```

### Building the Desktop Client

```bash
cd client
npm install
npx tauri build
```

Produces `.exe` + `.msi` on Windows, `.deb` + `.AppImage` on Linux.

## Project Structure

```
paracord/
├── crates/                 # Rust server workspace
│   ├── paracord-server/    # Binary entry point, TLS, UPnP, LiveKit management
│   ├── paracord-api/       # REST API routes (50+ endpoints)
│   ├── paracord-ws/        # WebSocket gateway (events, presence, typing)
│   ├── paracord-core/      # Business logic, permissions engine, event bus
│   ├── paracord-db/        # SQLite via SQLx (migrations, queries)
│   ├── paracord-federation/# Server federation (scaffolded for future)
│   ├── paracord-models/    # Shared types and data structures
│   ├── paracord-media/     # File storage + LiveKit voice/streaming
│   └── paracord-util/      # Snowflake IDs, validation
├── client/                 # Tauri v2 + React client
│   ├── src/                # React TypeScript frontend
│   │   ├── components/     # UI (chat, voice, guilds, settings, moderation)
│   │   ├── stores/         # Zustand state management
│   │   ├── gateway/        # WebSocket connection + event dispatch
│   │   └── pages/          # Route pages
│   └── src-tauri/          # Native Rust backend (system audio, TLS handling)
└── docs/                   # Design specs and API documentation
```

## License

Source-available. See [LICENSE](LICENSE) for full terms. You may use, study, and modify the software for personal use, and share official releases. Redistribution of modified versions and derivative works is not permitted without written permission.
