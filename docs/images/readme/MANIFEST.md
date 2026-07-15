# README promo screenshots

Captured: 2026-07-13T00:30:01Z
Base URL: `https://127.0.0.1:8443` (embedded UI from running `paracord-server`)
Viewport: 1440×900
Theme: dark Emerald Commons (Appearance → Dark + teal/emerald accent)
Demo space shown: **Fuel** (existing account guild; not renamed)

## Files

- `readme-home.png` — Home / resume dashboard with unified sidebar (Fuel space)
- `readme-sidebar.png` — Unified sidebar showing Needs you, Recent, and Spaces
- `readme-rooms.png` — Guild/server home Rooms view with live room card and text channels
- `readme-messaging.png` — Text channel messaging (#general) with Emerald Commons dark theme
- `readme-members.png` — Text channel with Members context panel open
- `readme-voice.png` — Voice channel lobby (General) with Join voice CTA
- `readme-friends.png` — Friends page (Online tab empty state)
- `readme-dms.png` — Direct messages hub
- `readme-settings.png` — User settings — Appearance (Dark / Emerald accent)
- `readme-guild-settings.png` — Guild settings overlay (Invites section)
- `readme-command-palette.png` — Command palette (Ctrl+K)
- `home.png` — Legacy alias of readme-home.png (README.md path)
- `unified-sidebar.png` — Legacy alias of readme-sidebar.png
- `rooms-view.png` — Legacy alias of readme-rooms.png
- `text-chat.png` — Legacy alias of readme-messaging.png

## Could not capture / incomplete

- `readme-voice-joined.png` — Web Join voice failed in headless Chromium: “Opening handshake failed” (native media/QUIC). Lobby shot kept instead.
- `readme-stream.png` — No active screen share / stream available during capture window.
- `Video grid with multiple participants` — Only one demo account; no second client connected.

## Login / blockers

- Login succeeded with existing demo account `readme-1783269377@example.test` (password via script env / defaults).
- No login blocker for web UI against local HTTPS (`8443`).
- Browser MCP tab tooling was flaky in this environment; captures were taken with Playwright + Chromium instead.
- Desktop window (`paracord-desktop`) was running; ffmpeg x11grab produced a black frame (WebKit/compositor), discarded.
- Voice **connected** grid/stream not available from headless web join (handshake failure). Lobby UI was captured.
- Guild settings Overview nav was limited; polished settings shot is user Appearance + guild Invites overlay.

## Notes

- Review images before publishing; avoid any accidental token leakage (none intentionally included).
- Legacy unprefixed aliases support current root README image paths under `assets/readme/` if you copy them over later — this folder is the durable source of truth for this pass.

