# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview
Paracord is a decentralized, self-hostable Discord alternative. Rust server (axum) + Tauri v2 desktop client (React 19).

## Build & Run Commands

### Server (Rust)
```bash
cargo check --workspace                        # Fast type-check (no codegen)
cargo build --workspace                        # Debug build
cargo build --release --bin paracord-server     # Release build (requires client/dist/ for embedded UI)
cargo run --bin paracord-server                 # Run dev server (port 8090 by default)
cargo run --bin paracord-server -- -c path/to/config.toml  # Custom config
```

### Client (React/TypeScript)
```bash
cd client && npm install                       # Install dependencies
cd client && npm run dev                       # Vite dev server on :1420 (proxies to localhost:8090)
cd client && npm run build                     # Type-check + production build → client/dist/
cd client && npm run typecheck                 # TypeScript check only (tsc --noEmit)
```

### Testing
```bash
# Rust
cargo test --workspace                         # All tests
cargo test -p paracord-api                     # Single crate
cargo test -p paracord-api -- test_name        # Single test by name
cargo test -p paracord-api --test channel_message_routes  # Single integration test file

# Client
cd client && npm test                          # Typecheck + unit tests
cd client && npm run test:unit                 # Vitest unit tests (CI mode)
cd client && npm run test:unit:watch           # Vitest watch mode
cd client && npm run test:e2e                  # Playwright e2e tests
```

### Linting
```bash
cargo fmt --all -- --check                     # Rust format check
cargo clippy --workspace -- -D warnings        # Clippy (CI treats warnings as errors)
```

## Native Dependencies (libvpx / VP9)

**CRITICAL: Do NOT disable the `vpx` feature to work around build errors. The `vpx` feature is enabled by default in `client/src-tauri/Cargo.toml` and is REQUIRED for live video streaming. Disabling it silently breaks screen share and video calls at runtime. Fix the build environment instead.**

The `paracord-codec` crate has a `vpx` feature flag that enables VP9 video encoding/decoding via libvpx. The Tauri desktop client (`client/src-tauri`) enables this by default: `default = ["custom-protocol", "vpx"]`.

### How it works
- `env-libvpx-sys` build script discovers libvpx via either:
  1. **`VPX_LIB_DIR` env var** (explicit path) — also requires `VPX_INCLUDE_DIR` and `VPX_VERSION`
  2. **pkg-config** fallback — looks for `vpx.pc` on `PKG_CONFIG_PATH`

### Windows setup (vcpkg)
libvpx is pre-built in `tmp-vcpkg/` via vcpkg with the `x64-windows-static` triplet. To build the client with VP9 support, set these env vars before `cargo build`:
```bash
export VPX_LIB_DIR="$PWD/tmp-vcpkg/installed/x64-windows-static/lib"
export VPX_INCLUDE_DIR="$PWD/tmp-vcpkg/installed/x64-windows-static/include"
export VPX_VERSION="1.16.0"
export VPX_STATIC=1
```

If `tmp-vcpkg/` is missing or needs to be rebuilt:
```bash
# Requires vcpkg to be installed (https://vcpkg.io)
cd tmp-vcpkg && vcpkg install libvpx:x64-windows-static
```

### Linux setup
```bash
# Debian/Ubuntu
sudo apt install libvpx-dev
# The pkg-config path is usually already set; verify with:
pkg-config --libs vpx
```

### macOS setup
```bash
brew install libvpx
```

### If the build fails with vpx linker errors
1. Verify the env vars above are set (Windows) or that `pkg-config --libs vpx` works (Linux/macOS)
2. Verify the header files exist: `ls $VPX_INCLUDE_DIR/vpx/vpx_encoder.h`
3. Verify the library exists: `ls $VPX_LIB_DIR/vpx.lib` (Windows) or `ls $VPX_LIB_DIR/libvpx.a` (Unix)
4. **Do NOT remove the `vpx` feature from `client/src-tauri/Cargo.toml` or `paracord-codec` — this breaks live streaming**

## Architecture

### Server: 13-crate Rust workspace under `crates/`
| Crate | Role |
|---|---|
| `paracord-server` | Binary entry point, config loading, startup orchestration, background tasks |
| `paracord-api` | REST route handlers (axum). Routes in `src/routes/`, one file per domain |
| `paracord-ws` | WebSocket gateway. Handles connection lifecycle, compression, origin validation |
| `paracord-core` | Business logic, event bus (`EventBus`), permission cache (moka), presence manager |
| `paracord-db` | SQLx database layer. Dual SQLite/PostgreSQL support. Modules mirror domain tables |
| `paracord-models` | Shared Rust types and permission flags |
| `paracord-media` | LiveKit voice/video integration, pluggable storage backend (local or S3) |
| `paracord-federation` | Server-to-server federation via Ed25519-signed HTTP envelopes |
| `paracord-util` | Snowflake ID generation, input validation, at-rest encryption (AES-256-GCM) |
| `paracord-transport` | QUIC/WebTransport media transport (native media alternative to LiveKit) |
| `paracord-relay` | Media routing: room/participant management, bandwidth estimation, VAD, E2EE |
| `paracord-codec` | Audio (Opus, RNNoise) and video (VP9) encoding/decoding |
| `paracord-media-dev` | Standalone dev server for testing native media transport |

### Client: Tauri v2 desktop app under `client/`
- React 19 + TypeScript + Vite 6 + Tailwind CSS v4
- Zustand v5 stores in `src/stores/` — one store per domain (auth, guild, message, channel, voice, etc.)
- API client in `src/api/client.ts` — axios with auth interceptors, token refresh, per-server factory
- WebSocket gateway in `src/gateway/` — manages connections with resume/replay support
- Types in `src/types/index.ts` — all shared interfaces and enums
- Theming via CSS custom properties in `src/styles/globals.css` (Tailwind v4 `@theme`, no JS config)
- Path alias: `@/*` → `./src/*`

### Key Architectural Patterns

**Event Bus** (`paracord-core/src/events.rs`): Broadcast channel with guild/user scoping. `ServerEvent` carries guild_id and optional target_user_ids for efficient fan-out. Sessions indexed by guild and user via DashMap.

**Database**: Dual-engine via SQLx `Any` pool. Engine detected from URL scheme (`sqlite://` vs `postgres://`). Separate migration directories: `migrations/` (SQLite) and `migrations_pg/` (PostgreSQL). Tests use in-memory SQLite: `create_pool("sqlite::memory:", 1)`.

**Permission Cache**: Moka LRU cache keyed by `(user_id, channel_id)`, 5-min TTL, 10k max entries. Located in `paracord-core`.

**Snowflake IDs**: Custom epoch 2024-01-01. Format: 42-bit timestamp | 10-bit worker | 12-bit sequence. All entity primary keys are `i64` snowflakes.

**AppState**: Central shared state struct in `paracord-core` holding db pool, event bus, config, voice manager, storage, federation service, permission cache, and presence manager. Passed to all route handlers via axum state.

**Test Pattern (Rust)**: Integration tests in `crates/paracord-api/tests/` build a `TestContext` with in-memory SQLite, run migrations, create temp dirs, and test against the axum Router directly via Tower's `ServiceExt`.

**Test Pattern (Client)**: Vitest with jsdom. Stores tested by mocking API modules with `vi.mock()`, resetting store state in `beforeEach`, and asserting via `useStore.getState()`.

## Configuration
- Config file: `config/paracord.toml` (auto-generated on first run with random JWT secret)
- No `.env` files — all config via TOML sections + environment variables
- Key env vars for dev: `PARACORD_LOG_ANSI`, `PARACORD_HTTP_SLOW_MS`, `PARACORD_TRUST_PROXY`
- Client dev proxy target: `VITE_DEV_PROXY_TARGET` (defaults to `https://localhost:8443`)

## Code Style
- Rust: default rustfmt, edition 2021, Rust 1.88+
- TypeScript: strict mode, React 19 patterns (no explicit eslint/biome config)
- Use Snowflake IDs (i64) for all entity primary keys
- CSS custom properties for theming (Discord-like dark theme)
- Permissions use BigInt on client, bitflags on server
