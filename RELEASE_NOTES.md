# Paracord 1.0.0 — Native Media, Zero-Config, Emerald Commons

**Paracord 1.0.0** is the first public release of a decentralized, self-hostable Discord alternative — a Rust (axum) server and a Tauri v2 / React 19 client that you own end to end. It represents a fundamental shift in what "self-hosted chat" means: you no longer wire up a media cloud, generate secrets by hand, or forward a dozen ports. Start the server, register the first account, and you have a working private community with end-to-end-encrypted voice and video running on Paracord's own QUIC engine — plus a redesigned client, a full bot platform, and a pre-release security-hardening pass behind it.

This release spans **42 commits** and **1,122 files changed** (+274,835 / −63,261 lines) since [v0.9.0](https://github.com/Scdouglas1999/Paracord/releases/tag/v0.9.0), including **44 new database migrations** (SQLite + PostgreSQL parity). Full compare: **[v0.9.0...v1.0.0](https://github.com/Scdouglas1999/Paracord/compare/v0.9.0...v1.0.0)** · release commit `156125c`.

---

## Highlights at a Glance

| Area | What's new |
|------|------------|
| **UI** | **Emerald Commons** design system + **Rooms + Unified Stream** layout — one attention-ranked sidebar across every connected server |
| **Voice & video** | Native QUIC/WebTransport media is now the **default**; LiveKit becomes optional opt-in |
| **Security** | Full pre-release IDOR / broken-access-control sweep across the route handlers — every confirmed issue fixed and regression-tested (incl. two High-severity flaws) |
| **Setup** | Zero-config first run — config, JWT secret, SQLite DB, and self-signed TLS cert all generated automatically |
| **Networking** | One port to forward: **8443** (TCP for HTTPS/gateway/WebTransport, UDP for QUIC media) |
| **Database** | Dual SQLite/PostgreSQL from one pool; new offline **SQLite→PostgreSQL migrator** |
| **Dev platform** | Slash commands, interactions (buttons/selects/modals), GitHub webhooks, reviewable bot store, XP/leveling |
| **E2EE** | Signal-protocol E2EE DMs and real per-frame E2EE on the media path — relay routes ciphertext only |
| **Desktop** | Windows `.exe`/`.msi` and Linux `.deb`/`.AppImage` builds; native Rust audio pipeline |

> Verified green at release: `cargo test --workspace` passing, **1,126 client unit tests** passing, and clippy clean on the changed crates. See [Verification](#verification--full-changelog).

---

## What's New in v1.0.0

### Redesigned experience — Rooms + Unified Stream on Emerald Commons

The desktop client retires the Discord skeleton (guild rail + channel column + docked member list) for a bolder information architecture. The old `Sidebar`, `ChannelSidebar`, `GuildChannelList`, `DMList`, and `VoiceControls` modules are gone.

- **Unified Stream sidebar** — a single attention-ranked feed that spans *every* connected server. "Needs you" scores mentions > DM unreads > thread replies > plain unread > voice activity (capped with overflow counts), followed by "Recent," pinned conversations, and "Spaces."
- **Rooms home per space** — opening a server lands on a presence-first `RoomsView`: live voice/stage rooms as occupant cards with speaking rings, an "around now" online-member strip, an optional space briefing, and grouped text channels below.
- **Full-width chat + toggleable Context Panel** — members, threads, pins, search, and economy move into one right-side panel opened on demand. A channel-switcher popover and the ⌘K/Ctrl+K command palette restore fast movement without a permanent channel rail.
- **Emerald Commons design system** ([docs/design-spec.md](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/design-spec.md), `client/src/styles/tokens.css`) — warm-neutral dark surfaces, a calibrated emerald primary with rationed teal secondary, a real elevation ramp, and a display face on headings. Ships **dark** (default), **light**, **AMOLED**, and **high-contrast** themes plus user-swappable accents, AA/AAA contrast, and visible focus rings. Full IA contract in [docs/layout-spec.md](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/layout-spec.md).
- **Discoverability & onboarding** — persistent anchor nav (Home / Friends with a pending-request badge / Messages) in both sidebar states, an "Add a space" entry, incoming friend requests pinned to the top of "Needs you," a cross-server DM index at `/app/dms`, and a one-time 3-step layout tour.

### Native media & performance

- **Native QUIC is now the default.** `[voice] native_media` flipped `false → true` (v0.9.0 was LiveKit-first). Voice, video, and screen share run on Paracord's own end-to-end-encrypted engine (`paracord-transport` + `paracord-relay` + `paracord-codec`) — raw QUIC for desktop, HTTP/3 WebTransport for browsers. **LiveKit is fully optional**, enabled only if you specifically need a WebRTC SFU (`docker compose --profile livekit up`).
- **One port for remote access** — `8443`, TCP and UDP. A single unified UDP endpoint serves both raw-QUIC and WebTransport clients into a shared relay that routes encrypted datagrams between participants, with room/participant tracking and speaker detection built in.
- **Native surface rendering** — a new `client/src-tauri/src/native_media/native_render/` path (Linux/macOS) renders decoded video on a native GPU surface instead of pushing raw frames across IPC ([docs/streaming-native-render-spec.md](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/streaming-native-render-spec.md)); where the browser can decode (e.g. Windows/WebView2), frames take a WebCodecs passthrough. Binary IPC for video frames removes JSON serialization overhead, and video-frame backpressure prevents memory buildup during screen share.
- **Simulcast + per-viewer layer selection** on hardware-encode paths; relay-side adaptive bitrate (AIMD goodput/loss estimator) drives the encoder.
- **Linux screen-share repaired** — the PipeWire/portal pipeline now handles non-16:9 and odd dimensions and honors portal chunk offsets/stride.
- **Self-view correctness** — local E2EE track keys are registered with the local decryptor; persistent-backdrop-blur and speaking-tick re-render hotspots removed.
- **QUIC transport hardening** — the insecure default QUIC client config is gone; pinned certs are now required.

### Security & hardening

v1.0.0 shipped only after an endpoint-by-endpoint IDOR / broken-access-control sweep across the route handlers. **Every confirmed vulnerability was fixed and covered by a regression test, and the full `cargo test --workspace` suite passes.** Details live in [docs/security-review-2026-07-10.md](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/security-review-2026-07-10.md).

**High severity**

- **Cross-guild message injection via announcement follows** — `add_channel_follow` authorized against an attacker-owned source plus body-supplied target IDs, letting an attacker persist messages into arbitrary channels/guilds. Now bound to the target (`MANAGE_WEBHOOKS` on it), the target must be a guild channel, and `target_guild_id` is derived server-side.
- **Federation cross-server read IDOR** — `get_event` let any trusted peer read any local guild's message history. Now enforces a room-participation guard tightened so only actual members count.

**Medium severity**

- **Ban evasion via public-guild self-join** — `join_public_guild` now applies the same ban / anti-raid checks as the invite path.
- **Relationship block-bypass** — `remove_relationship` no longer deletes both directional rows; a block placed by the other party is preserved.

**Low severity (batch)**

- Edit-message now honors channel permission overwrites for moderators.
- Federation reaction identity-spoofing and unstructured global event fan-out closed.
- Stage-instance reads require `VIEW_CHANNEL`.
- Private bot applications can no longer be read or force-installed by non-owners.
- Webhook tokens are hashed at rest (scheme-tagged SHA-256, migrate-on-use).
- HSTS `max-age` raised to two years; a shipped LiveKit dev secret was blocklisted.

**Earlier hardening folded in**

- Federation SSRF protection — RPC/discovery/moderation-sync fetches disable auto-redirects; federated file downloads follow redirects manually with DNS/private-network validation at each hop; discovery caps streamed peer JSON at 512 KiB.
- Host-header injection fix — verification and password-reset links are built only from configured `public_url` or trusted-proxy headers.
- Cert-pin enforcement on Windows WebView2, interaction/modal integrity binding, an OS-native consent boundary for camera/screen capture, a correct trusted-proxy CIDR/XFF resolver, and native-response resource caps (LiveKit proxy/admin, OpenGraph previews, AI provider URLs, Tenor GIF search all timeout-bounded, redirect-free, and size-capped).
- Snowflake generator hardened against backwards clock steps; media E2EE uses a per-`(ssrc, epoch)` nonce rollover counter with wrap-boundary tests.

### Under the hood & self-hosting

- **Zero-config first run** — starting `paracord-server` (or `paracord-server init`) writes `config/paracord.toml` with a random JWT secret, creates the SQLite database, generates a self-signed TLS certificate, and prints the URL plus next steps. **The first account you register becomes the server owner/admin.**
- **SQLite → PostgreSQL migrator (new)** — the offline `paracord-server migrate-to-postgres` subcommand copies a SQLite database into a freshly migrated PostgreSQL database inside a single all-or-nothing transaction, verifying each table's row count against the source (`--dry-run` supported). PostgreSQL gains `pg_trgm`-backed search. See [docs/sqlite-to-postgres-migration.md](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/sqlite-to-postgres-migration.md).
- **Default role permissions fixed** — `Permissions::default()` now includes `CREATE_INSTANT_INVITE | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS` for Discord parity (`MENTION_EVERYONE` deliberately excluded). An idempotent dual-DB migration ORs these bits into existing default roles — the root cause of members hitting spurious 403s when creating invites or uploading files. It only touches the default role and skips rows that already have the bits.
- **Guild file storage management** — per-guild quotas, retention, and MIME restrictions via `GET/PATCH /api/v1/guilds/{id}/storage`; list/bulk-delete via `GET/DELETE /api/v1/guilds/{id}/files`. Uploads are validated against an active-content-downgraded MIME type, so a forged `Content-Type` cannot bypass allowlists; attachments carry a SHA-256 `content_hash`.
- **Docs overhaul** — `getting-started.md`, `deployment.md`, `sqlite-to-postgres-migration.md`, `postgres-pg-trgm.md`, `known-limitations.md`, `security-release-gate.md`, layout/design/streaming specs, and a release-validation suite (`docs/release-validation.md`, `scripts/release_*_smoke.py`).
- **Vendored build patches** — `env-libvpx-sys`, `libspa-sys`, `pipewire-sys`, and `tauri-runtime-wry` are vendored with a modern-bindgen bump for current Linux toolchains; `third_party/scap` is vendored for cross-platform screen capture.

### Fixes

- The Linux desktop client now compiles and packages (build-environment fixes).
- LIVE badge appears immediately in the sidebar on stream start; stopping a stream no longer hangs ~15 seconds (re-entrancy guard prevents duplicate stop calls); auto-watch renders the StreamViewer immediately.
- Clicking a voice channel you are already in navigates back instead of disconnecting.
- Honest SSE resume/replay — `GET /api/v2/rt/events` replays from the advertised cursor in order (replacing a cosmetic `"cursor": 0` that silently dropped events).
- Centralized REST client resolution via `getApi()` fixes "requests went to the wrong server after switching."
- Mobile bottom-nav "Space" always opens the selected space's Rooms home, not a stale last channel.
- Numerous client re-render / performance regressions removed.

---

## Full Feature Overview

Everything below is in the shipped product. ★ marks a notable differentiator; items flagged partial/experimental are detailed under [Known Limitations](#known-limitations).

### Messaging & channels
- Text, Announcement, Voice, Category, Thread, and Forum channels; threads with archive; forum posts with tags and sort order.
- Rich Markdown: bold/italic/underline/strikethrough, click-to-reveal spoilers, highlighted code blocks, blockquotes, `<@id>` mentions, custom emoji, sanitized links.
- Reactions (custom + unicode), replies, edit/delete with full per-message edit history.
- Pinned messages, saved messages/bookmarks, per-channel search.
- Scheduled messages (create/list/edit/cancel, delivered even after a server restart); ephemeral messages in the composer.
- Polls (timed, single/multi-vote), custom emoji + stickers, server-proxied Tenor GIF picker.
- Slowmode incl. adaptive slowmode and slowmode-exempt roles, per-user thread rate limits, optional anonymous-posting channels (mods can de-anonymize).
- Read state / unread + mention counts, typing indicators, and an inbox overlay — all merged across every connected server.
- ★ **AI channel catch-up** — `GET /channels/{id}/summary` via a configurable provider (OpenAI / Anthropic / Ollama / OpenAI-compatible); refuses to summarize E2EE channels.

### Voice, video & screen share
- ★ **Native QUIC/WebTransport media engine is the default** — desktop over raw QUIC, browsers over HTTP/3 WebTransport; LiveKit is an optional WebRTC-SFU fallback only.
- Voice: join/leave, self-mute/deafen, push-to-talk + voice activation with rebindable keys, per-user volume (0–2× gain), device selection with hot-switch, speaking indicators, occupant lists.
- Audio: Opus (48 kHz, FEC + DTX, up to 192 kbps stereo), RNNoise suppression (default on, toggleable), echo cancellation + AGC (SpeexDSP), jitter buffer, resampling.
- Video/screen share: VP9 (libvpx) universal fallback plus hardware H.264/AV1 (NVENC/VAAPI/QSV on Linux, MediaFoundation on Windows), 3-tier simulcast (180p/360p/720p), webcam capture, multi-source screen picker with thumbnails.
- ★ **Real E2EE of media frames** — AES-128-GCM with an SRTP-style nonce, per-sender per-track ephemeral keys rotated by epoch on membership change, X25519-wrapped per recipient; the relay routes ciphertext only.
- Adaptive bitrate / congestion control (relay-side goodput + loss estimator, AIMD 512 kbps–100 Mbps).
- Stage channels: speaker vs. audience, invite/remove speaker, raise-hand, moderator dismiss; audience listen-only.
- ★ **System/application audio capture during screen share** (Windows WASAPI process-loopback excluding Paracord; Linux PipeWire/PulseAudio virtual sink) with a native consent prompt each session.
- DM voice calls (1:1 and group).

### Servers, roles & permissions
- ★ **Discord-style permission model** — 30 permission flags, role hierarchy, per-channel overwrites, and a moka permission cache.
- Guild lifecycle: create/update/delete, ownership transfer, channel reordering, vanity URLs.
- Roles CRUD; member list/update, kick, leave, join-public-guild; per-guild custom emoji + stickers.
- Invites (create/accept/revoke with validation of `max_uses`/`max_age`); opt-in public server discovery with normalized tags (new guilds private by default).
- ★ **Guild templates** — snapshot a server and apply it to create new ones (stored role/channel data validated before creation).
- Onboarding: first-run wizard, layout coach-marks, per-guild join gate (welcome, rules ack, Q&A screening, role prompts).
- Scheduled events with RSVP/interest, recurrence, voice/external types, and iCal (`.ics`) export per event and per guild.

### Direct messages & social
- 1:1 and group DMs (add/remove recipients, group member panel).
- Friends & relationships: friend requests (in/out pending), accept, remove, blocking.
- Presence (online/idle/dnd/offline/streaming) with activity sharing and typing indicators — scoped and merged across servers.
- ★ **Optional E2EE DMs** — Signal-style X3DH + Double Ratchet (X25519/Ed25519 via `@noble/curves`), signed + one-time prekeys, off-main-thread decryption, and safety-number/fingerprint verification. Group DMs use epoch-based sender keys with recovery for lost local secure storage.

### Moderation & safety
- Bans, kicks, and timeouts (comm-disabled-until); bans evict voice/media and invalidate the permission cache.
- ★ **Audit log** with a fixed taxonomy, filterable, gated on `VIEW_AUDIT_LOG`.
- Moderation templates — reusable warn/timed-mute/kick/ban quick-actions with placeholders and an optional target DM notice.
- User reports + a moderator resolution queue wired to real enforcement; a configurable mod-log channel with human-readable embeds.
- AutoMod (keyword/regex, link allow/block, spam/dup/mention-spam, account-age gate → delete/warn/quarantine/mute/ban), anti-raid (join-rate lockdown, min-account-age), and a custom verification gate (ack + waiting period + Q&A). *(Configuration is JSON-driven with limited UI — see Known Limitations.)*
- Optional malware scanning via a bring-your-own external-scanner hook (fail-closed, quarantine dir). *(No bundled scanner; off unless configured.)*

### Bots, webhooks & developer platform
- Bot applications with backing bot users, hashed tokens (shown once, regenerable), and validated redirect URIs; a developer portal with a permission calculator.
- OAuth2 install flow with a privilege-escalation guard (granted perms capped to the installer's own).
- ★ **Slash commands** (global + guild, bulk overwrite, nested options, choices, autocomplete) plus full **interactions** — buttons, string/entity selects, modals — with hashed interaction tokens and strict channel access checks. Bot message components persist through history reload.
- ★ **Webhooks incl. GitHub-format ingestion** (HMAC-SHA256 verified, secrets encrypted at rest; renders push/PR/issues/comments/stars). Guild webhook settings with copy/refresh/test-execute.
- ★ **Bot store/marketplace** — searchable, categorized, featured, with a verified-developer badge, 1–5★ reviews, and per-developer install/usage metrics.
- Bot presence updates (status + single activity).

### Federation ★ (MVP, off by default)
- Server-to-server via Ed25519-signed HTTP envelopes (`paracord-federation`): federated messages, reactions, bans/member-leave, voice signaling, and cached federated file fetches (token-based download proxy with optional local caching). Non-full-mesh relay forwards room events to peers with accepted prior membership (A→B→C topologies).
- Disabled by default (`federation.enabled=false`, `allow_discovery=false`); per-peer rate limits; trusted peers only. *See Known Limitations before enabling.*

### Self-hosting & operations
- ★ **Zero-config first run** — auto config / JWT secret / SQLite DB / self-signed TLS; prints the URL. First registered account = owner/admin.
- ★ **Dual DB engine** — SQLite (default) or PostgreSQL from one SQLx `Any` pool; offline `migrate-to-postgres` and `init` subcommands.
- Pluggable storage — local filesystem (default) or S3 (feature-gated; requires explicit credentials unless `use_aws_credential_chain = true`).
- TLS: automatic ACME/Let's Encrypt (HTTP-01) or self-signed; single-port `8443` (TCP HTTPS + gateway, UDP native QUIC media).
- At-rest encryption (AES-256-GCM) for configured secrets/SQLite/files — opt-in (off by default; MFA requires it when a public URL is set).
- Backups: create/list/restore from the admin panel with configurable retention.
- Admin dashboard: stats, user + guild management, settings, security-event log, self-update/restart.
- One binary or `docker compose up`; embedded web UI in release builds.

### Platform & client
- ★ Cross-platform desktop via **Tauri v2 for Windows and Linux** (macOS desktop **not** supported), plus a browser client served from the same binary.
- Multi-server: connect to many Paracord hosts; a portable Ed25519 identity carries across them.
- ★ **Command palette** (Ctrl/⌘K) — fuzzy jump to actions, navigation, channels, spaces, and cross-server DMs.
- Theming "Emerald Commons": four themes, 10 accent presets, sanitized user custom CSS with live preview, plus density and low-bandwidth modes.
- Keyboard shortcuts throughout (OS-aware ⌘ vs. Ctrl); PWA (installable, auto-update; desktop unregisters the service worker to avoid stale caches).
- Desktop: minisign-signed auto-updater, TOFU self-signed cert pinning, native notifications, close-to-tray, `paracord://` deep links, OS-keyring secure storage.
- Auth: Argon2 password hashing, JWT sessions with refresh rotation + reuse detection, TOTP 2FA (QR), Ed25519 identity.

### Engagement — XP / leveling ★ (XP-only, no currency)
- Message XP (15–25 per message + length bonus + cooldown) with computed levels.
- ★ Level-roles at thresholds, achievements/badges, streaks, and a per-guild leaderboard with rank. *(No currency, coins, wallet, or shop anywhere.)*

---

## Install & Self-Host Quickstart

### Desktop builds
Official signed desktop installers are produced by the release build and attached to the published release:

- **Windows** — Inno Setup `.exe` installer and Tauri `.msi`
- **Linux** — `.deb` and `.AppImage`

There is **no macOS desktop build** (see Platform Support). If installers are not yet listed under **Assets** above, the release build is still in progress — you can always build from source (see [Getting Started](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/getting-started.md)).

### Run the server (zero-config)
Starting the server for the first time generates everything you need:

```bash
cargo run --bin paracord-server        # or run the release binary
```

It writes `config/paracord.toml` (with a random JWT secret), creates the SQLite DB under `./data/`, generates a self-signed TLS cert under `./data/certs/`, and prints the URL to open and share. **Register the first account immediately — it becomes the owner/admin.**

### One port to forward
For remote access, forward a single port — **8443** over both TCP and UDP:

- **TCP** — HTTPS (web UI, REST API, WebSocket gateway, WebTransport)
- **UDP** — native QUIC voice/video datagrams

No separate LiveKit port unless you explicitly enable the LiveKit profile.

### Docker Compose (no `.env` editing)
```bash
docker compose up          # zero-config; secrets persist to the data volume on first run
```

- Default: native QUIC media, HTTP inside the container (`PARACORD_TLS_ENABLED=false`) — terminate TLS at a reverse proxy for production, since browsers require HTTPS for mic/camera/screen share.
- LiveKit opt-in: `docker compose --profile livekit up -d`.

### Documentation
- [Getting Started](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/getting-started.md) — step-by-step walkthrough incl. native-vs-LiveKit guidance and TLS/WebTransport nuance.
- [Deployment notes](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/deployment.md) — reverse-proxy TLS termination, UDP forwarding, `PUBLIC_URL`, PostgreSQL, backups.
- [SQLite → PostgreSQL migration](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/sqlite-to-postgres-migration.md) · [Known limitations](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/known-limitations.md).

---

## Platform Support

| Platform | Status |
|----------|--------|
| **Windows desktop** | ✅ Supported — primary path for screen capture and system audio (Process Loopback Exclusion) |
| **Linux desktop** | ✅ Supported — screen-share via PipeWire/portal; **capture paths are distro-dependent**, validate on your target distribution |
| **Browser (any OS)** | ✅ Supported — full WebTransport + WebCodecs media in-browser |
| **macOS desktop** | ❌ **Not supported** in v1.0.0 |

Linux hardware-encode (FFmpeg/lavc) and VP9 (libvpx) are build-time dependencies; without them the client narrows to software/stub codecs. Do **not** disable the `vpx` feature — it silently breaks live video.

---

## Known Limitations

Being honest about the edges. Full detail in [docs/known-limitations.md](https://github.com/Scdouglas1999/Paracord/blob/v1.0.0/docs/known-limitations.md).

- **Federation is an MVP, off by default, and experimental.** It is a trusted-peers-only relationship. Enabling it currently federates **all** guilds to **all** trusted peers — a per-guild opt-in is a planned follow-up. Validate every cross-server flow in staging before public use.
- **Gateway intents are not enforced yet.** The selector UI exists and choices persist, but the gateway does not gate events on them today — treat it as forward-looking, not functional event-gating.
- **AutoMod, anti-raid, and the verification gate are JSON-configured with limited UI.** They are powerful but driven mainly through guild `bot_settings` JSON (the UI is largely a toggle + quarantine review). The verification gate is **custom** (ack + waiting period + Q&A), not Discord's numeric verification tiers.
- **Malware scanning is an optional external hook.** There is **no bundled scanner**; it is off unless you wire up a bring-your-own scanner (fail-closed, quarantine dir).
- **At-rest encryption is opt-in and off by default.** With it disabled, non-E2EE guild/channel messages remain readable by the server operator. (E2EE DMs and E2EE media are separate and always encrypted end to end.)
- **Webhook tokens migrate-on-use to hashed-at-rest.** New tokens are hashed immediately; legacy plaintext tokens self-heal to the hashed scheme on their first use.
- **Server folders are not shipped.** Store-level logic exists but is not wired into the UI — it is not a v1.0.0 feature.
- **macOS desktop is not supported**, and some Linux capture paths are distro-dependent (see Platform Support).
- **Docker quick start is HTTP-only inside the container** — terminate TLS at a reverse proxy for production browser voice.
- **The desktop updater** only works for official signed releases with workflow-generated signatures.
- **Schema rollback is not supported**, and `migrate-to-postgres` is an offline maintenance-window tool, not live replication. Back up before upgrading.
- A **legacy V1 static-ECDH DM path** remains only as an env-gated, deprecated fallback.

---

## Upgrade Notes (from v0.9.0)

1. **Back up** your database and media directory before upgrading.
2. **Stop** the running server.
3. Replace the `paracord-server` binary (or pull the new Docker image).
4. **Start** the server — the 44 new migrations run automatically on boot. The **default-role-permissions migration is idempotent and applied automatically** (it ORs the new baseline bits into existing default roles and skips rows that already have them), so members previously hitting spurious 403s on invites/uploads are fixed with no manual action.
5. **Forward port 8443 TCP+UDP** if you haven't already — native media is now the default.
6. **Update** desktop clients to match the server version.
7. Review `config/paracord.toml`: `native_media = true` is now the default and **LiveKit becomes opt-in**. Set `native_media = false` and configure LiveKit only if you need a WebRTC SFU fallback.

**No manual action is required for the security fixes** — they are code/behavior changes applied automatically on upgrade. Voice-join responses may now include `native_media`, `media_endpoint`, `media_token`, and `cert_hash` fields alongside any existing LiveKit fields, and six new gateway media opcodes (12–17) handle native session negotiation. S3 storage now requires explicit `access_key_id`/`secret_access_key` unless `use_aws_credential_chain = true`.

> Version metadata (Cargo, npm, Tauri) is stamped to **1.0.0 at release time**; the working tree carried `0.9.0` until the release cut.

---

## Verification & Full Changelog

This release was validated before cutting:

- `cargo test --workspace` — **passing** (every security fix ships with a regression test).
- **1,126 client unit tests** — **passing**.
- `clippy` — **clean on the changed crates**.
- Release-load and real-browser UI smokes exercise login, navigation, messaging, uploads, discovery, admin, federation, backup, native-voice participants, and stream start/stop with RSS capture (`scripts/release_*_smoke.py`).

**Full changelog:** [v0.9.0...v1.0.0](https://github.com/Scdouglas1999/Paracord/compare/v0.9.0...v1.0.0)

---

Thank you to everyone who contributed code, testing, security review, and documentation across the v0.9.0 release-candidate line and the v1.0.0 overhaul — the native media engine, the Emerald Commons redesign, the Rooms + Unified Stream layout, the bot platform, and the extensive security, accessibility, and error-feedback pass that made this first public release shippable.
