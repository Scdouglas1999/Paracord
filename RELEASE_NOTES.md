## What's New in v0.7.0

### UI Overhaul

The entire client layout has been rebuilt from scratch. The old monolithic `UnifiedSidebar` has been replaced with a new multi-panel architecture that separates the server dock, channel sidebar, content area, and member list into distinct glass-morphic surfaces.

- **New layout system**: Workspace canvas with separated dock rail, channel panel, content stage, and member panel -- each independently scrollable and collapsible
- **Glass-morphic panels**: Panels use layered gradients, subtle noise texture overlay, and backdrop blur for a modern frosted-glass look with soft 24px rounded corners and inset highlight borders
- **Server dock**: Dedicated dark dock rail (72px, down from 84px) with pill-shaped server icons and animated active indicators
- **Channel sidebar**: Fully rewritten with collapsible channel categories (click a category header to collapse/expand), inline channel creation (click the **+** next to a category), unread count badges, and guild member presence
- **Refined typography**: Tighter font scale (11/13/15/17/20px), tabular numbers via `font-feature-settings`, and subpixel anti-aliasing across platforms
- **AMOLED dark theme**: True-black theme option for OLED displays, alongside improved light/dark contrast ratios. Switch between Dark, Light, and AMOLED under **Settings > Appearance > Theme**
- **Accent color presets**: 10 built-in palettes (Red, Blue, Emerald, Amber, Rose, Violet, Cyan, Lime, Orange, Slate) with dynamic shade generation for hover/active states. Pick one under **Settings > Appearance > Accent Color**
- **Mobile-first responsive**: Swipe right from the left edge to open the channel sidebar; swipe left from the right edge to open the member list. Bottom tab bar provides quick navigation on small screens
- **Lazy-loaded pages**: Settings, GuildSettings, Admin, Discovery, and Developer pages are code-split for faster initial load
- **Accessibility**: Skip-to-content link, improved focus styles, WCAG contrast improvements on interactive elements

New components shipping with this release: **ConnectionStatusBar** (live connection health), **MobileBottomNav** (bottom tabs), **MiniVoiceBar** (persistent voice indicator when navigating away from voice channel), **ConfirmDialog**, **ChannelManager** (create/edit channels inline), **GuildWelcomeScreen** (onboarding), **MessageEmbed** (rich link previews), and **GitHubEventEmbed** (commit/PR cards from webhooks).

### Progressive Web App (PWA) Support

The web client now ships with a service worker and web app manifest, so browsers that support PWA installation can add Paracord to the home screen or desktop. In Chrome/Edge, look for the install icon in the address bar or go to **Menu > Install app**. On mobile Safari, use **Share > Add to Home Screen**. This is browser-native behavior -- there's no custom install button in the app itself.

- **Service worker**: Auto-updating Workbox worker caches app assets for faster repeat loads
- **Web app manifest**: Proper metadata, theme color, and icons (64px through 512px + maskable)
- **Font caching**: Inter and JetBrains Mono font files cached so they don't re-download on every visit

### Signal Protocol End-to-End Encryption (E2EE v2)

DM encryption has been upgraded from static ECDH to the full Signal Protocol, providing forward secrecy and post-compromise security. This is transparent to users -- when both sides of a DM conversation are on v0.7.0+, sessions automatically upgrade to Signal Protocol the next time a message is sent. No manual setup required; existing v1 conversations continue to work.

- **X3DH key agreement**: Extended Triple Diffie-Hellman for initial key exchange
- **Double Ratchet**: Symmetric-key ratcheting for per-message forward secrecy
- **HKDF key derivation**: Standards-compliant key derivation chain
- **Session persistence**: Encrypted session state stored via Tauri secure storage (OS keychain) with fallback to encrypted localStorage on web
- **Prekey management**: Upload, rotate, and fetch prekey bundles via new API endpoints
- Full crypto library in `client/src/lib/crypto/` with comprehensive test suite

### Gateway Protocol Rewrite (Realtime v2)

New modular gateway architecture with an alternative **SSE + HTTP command bus** transport alongside the existing WebSocket gateway. Controlled by the `VITE_RT_V2` env var (defaults to SSE on).

- **Modular design**: Separated into protocol, manager, client, dispatch, queue, and transport layers -- replaces the old monolithic `gateway/connection.ts`
- **Server-Sent Events**: `POST /api/v2/rt/session`, `GET /api/v2/rt/events`, `POST /api/v2/rt/commands` -- handles 20+ event types including presence, voice state, and typing
- **Automatic reconnection**: EventSource with smart retry and session resumption
- **Message queue**: Backpressure-aware outbound queue buffers messages during reconnection (up to 200 pending)
- **WebSocket still available**: Set `VITE_RT_V2=false` to use the classic WebSocket gateway instead

### Enhanced Message Composer

- **@mention autocomplete**: Type `@` followed by a username to search guild members. Use Arrow Up/Down to navigate the popup, then Tab or Enter to insert the mention
- **Draft persistence**: Drafts auto-save as you type and restore when you switch back to that channel -- no lost messages
- **Paste-to-attach**: Copy an image to your clipboard and Ctrl+V (Cmd+V) directly into the message box to attach it
- **Formatting toolbar**: Click the formatting button next to the input to access markdown shortcuts (bold, italic, code, etc.)

### Code Syntax Highlighting

Code blocks now render with full syntax highlighting. Wrap code in triple backticks with an optional language tag:

~~~
```rust
fn main() {
    println!("Hello, Paracord!");
}
```
~~~

Supported languages: `js`, `ts`, `rust`, `python`, `go`, `java`, `c`, `cpp`, `csharp`, `ruby`, `php`, `sql`, `bash`, `json`, `yaml`, `toml`, `html`, `css`, `markdown`, `diff`, and more. If you omit the language tag, the highlighter will auto-detect where it can. Every code block has a **Copy** button in the top-right corner.

### Voice v2 & LiveKit Improvements

- **New voice endpoints**: `POST /api/v2/voice/{channel_id}/join`, `/leave`, `/state`, `/recover`
- **Multi-candidate URLs**: Server provides multiple LiveKit connection candidates with intelligent fallback (direct -> proxied -> fallback)
- **Environment overrides**: `PARACORD_LIVEKIT_DIRECT_PUBLIC_URL` and `PARACORD_FORCE_LIVEKIT_PUBLIC_URL` for deployment flexibility
- **Race condition fixes**: In-flight room tracking prevents simultaneous connection attempts
- Background room cleanup to avoid client timeouts

### API Observability (Wire Tracing)

New wire-level tracing infrastructure for debugging production deployments. Enable it by setting environment variables before starting the server:

```bash
PARACORD_WIRE_TRACE=1                         # turn on wire logging
PARACORD_WIRE_TRACE_PAYLOADS=1                # include request/response bodies
PARACORD_WIRE_TRACE_PAYLOAD_MAX_BYTES=2048    # max bytes per payload preview (default 1024)
```

Logs appear on the `wire` tracing target and include HTTP method/path/latency/status and WebSocket opcode/frame size per message.

### Database Improvements

- **Message deduplication**: Nonce-based dedup at the database level prevents duplicate messages on retry
- **Snowflake ID type safety**: Fixed critical `INTEGER -> BIGINT` migration for channels, polls, events, and prekey tables (prevents i32 overflow)
- Migrations for both SQLite and PostgreSQL tracks

### Bug Fixes

- **TLS configuration** (PR #11, @SweetLiberty92): Fixed HTTP and HTTPS binding on different ports -- TLS address now correctly uses the configured host
- **TLS env var respected** (PR #14): `PARACORD_TLS_ENABLED` is now properly assigned into the config when running behind a reverse proxy
- **Vite dev proxy**: Added `secure: false` and updated default target to `https://localhost:8443` for self-signed backend certs
- **Voice connection leaks**: Graceful cleanup of old rooms before new joins; AbortError handling for transient failures
- **Draft race condition**: Fixed autosave cleanup during channel switches
- **Config validation**: Improved placeholder secret detection (catches "replace_with" patterns)

### Community Contributions

- **@SweetLiberty92** -- PR #11: Refactored TLS address binding to use the configured host, fixing a critical port-binding bug
- **@SweetLiberty92** -- PR #14: Ensured `PARACORD_TLS_ENABLED` is respected and correctly assigned into the server config

### New API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/v2/rt/session` | POST | Create realtime SSE session |
| `/api/v2/rt/events` | GET | Stream server-sent events |
| `/api/v2/rt/commands` | POST | Send gateway commands over HTTP |
| `/api/v1/users/@me/keys` | PUT | Upload Signal prekey bundle |
| `/api/v1/users/@me/keys/count` | GET | Get remaining prekey count |
| `/api/v1/users/{user_id}/keys` | GET | Fetch peer's public prekey bundle |
| `/api/v2/voice/{channel_id}/join` | POST | Join voice with URL candidates |
| `/api/v2/voice/{channel_id}/leave` | POST | Clean voice disconnect |
| `/api/v2/voice/state` | POST | Update voice state |
| `/api/v2/voice/recover` | POST | Recover voice without re-join |

### Auth Middleware Enhancement

Token authentication now supports three formats for broader client compatibility:
- `Authorization: Bearer <token>` (header -- existing)
- `Cookie: paracord_access=<token>` (cookie -- new)
- `?token=<token>` (query parameter -- new, for SSE/EventSource)

### Breaking Changes

- **Sidebar width**: Reduced from 84px to 72px -- may affect custom CSS overrides
- **Voice join response**: v1 endpoint now also returns `url_candidates` array alongside the existing `url` field
- **E2EE payload**: `MessageE2eePayload` includes optional `header` field for Signal Protocol; v1 payloads still work

### Migration Guide

1. **Database**: Migrations run automatically on startup. Two new migrations fix Snowflake ID types and add message nonce dedup
2. **TLS**: If using TLS, verify both HTTP redirect and HTTPS use the expected ports (both now respect `host` from config)
3. **Environment**: New optional env vars for observability (`PARACORD_WIRE_TRACE`) and voice (`PARACORD_LIVEKIT_DIRECT_PUBLIC_URL`)
