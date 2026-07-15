# Paracord README Brief (research deliverable)

> **Purpose:** Accurate marketing/content research so another agent can write a
> professional GitHub README. **Do not treat the current root `README.md` as
> ground truth** — verify against this brief and the cited sources.
>
> **Constraints observed:** This brief does **not** replace `README.md` and was
> not committed. Research date: 2026-07-12. Branch observed:
> `overhaul/v1.0-shippable`. Repo: `https://github.com/Scoduglas1999/Paracord`.

---

## 1. What Paracord is today (product truth)

Paracord is a **self-hostable Discord-like community platform**: Rust (axum)
server workspace + Tauri v2 / React 19 desktop client (web UI also embedded in
the server binary for production). Communities run guilds (spaces), text/voice/
forum/stage channels, DMs, bots, moderation, and optional server-to-server
federation — on their own hardware.

**Default media path is native QUIC/WebTransport**, not LiveKit. LiveKit remains
an optional WebRTC SFU profile. Zero-config first run generates config, JWT
secret, SQLite DB, and (for the binary) self-signed TLS.

**Design / IA product names that are real and shipped in the client tree:**

| Name | What it is | Source |
|------|------------|--------|
| **Emerald Commons** | Design language: warm-neutral dark surfaces, emerald primary + rationed teal, runtime CSS tokens, 4 themes | `docs/design-spec.md` |
| **Rooms + Unified Stream** | Client IA: `AppShell` + `UnifiedSidebar` (Needs you / Recent / Spaces) + toggleable `ContextPanel` + guild-home `RoomsView` | `docs/layout-spec.md` (status: SHIPPED) |
| **Native QUIC media** | `paracord-transport` + `paracord-relay` + `paracord-codec`; desktop raw QUIC, browser WebTransport | `docs/getting-started.md`, crates |

**Version reality (critical):**

| Surface | Version today |
|---------|----------------|
| `Cargo.toml` workspace | `0.9.0` |
| `client/package.json` | `0.9.0` |
| `client/src-tauri/tauri.conf.json` | `0.9.0` |
| Git tags | Latest public tag: **`v0.9.0`** (no `v1.0.0` tag yet) |
| Branch / release notes framing | Targeting first public **`v1.0.0`** at tag time |
| Current root README | Claims **Paracord 1.0 / v1.0.0** — **ahead of tagged metadata** |

**Recommendation:** Until `v1.0.0` is tagged and Cargo/npm/Tauri bumped, either
(a) frame README as release-candidate / upcoming 1.0, or (b) only claim `v1.0.0`
in the same commit that tags and bumps versions. Do not leave “Current release:
v1.0.0” while metadata says `0.9.0`.

---

## 2. Current README audit — still true vs stale

### Still true (keep / refine)

- Self-hosted Discord alternative; one binary or Docker Compose path.
- First registered account becomes server owner/admin.
- Native QUIC media default; LiveKit optional; no LiveKit required for typical use.
- Zero-config first run (`config/paracord.toml`, JWT, SQLite, self-signed certs for binary).
- `paracord-server init` one-shot initializer exists.
- One port story for binary remote access: **8443 TCP + UDP**.
- Emerald Commons + Rooms / Unified Stream are real product concepts and shipped IA.
- Bots/webhooks/developer portal exist (`docs/bot-development.md`).
- Federation via Ed25519-signed HTTP envelopes exists; **disabled by default**.
- Optional E2EE DMs (X25519 / AES-GCM) and media E2EE on native path exist in code.
- Multi-server connect + unified sidebar merge across servers.
- SQLite default / PostgreSQL for production; Tauri v2 + React 19 stack.
- Source-available license (footer of README is correct about license *type*).
- Dev stack: Rust 1.88+, Node 22+, `cargo` + `client` Vite on `:1420`.
- liberate `vpx` / libvpx required for desktop VP9 — do not tell readers to disable it.
- Permission flag count “30” matches `Permissions` bitflags (30 named flags; bit 19 reserved unused).
- Themes: dark / light / amoled / high-contrast + custom CSS — matches `useTheme.ts`.

### Stale, broken, or misleading (fix or remove)

| Claim / artifact | Problem |
|------------------|---------|
| **“Paracord 1.0” / “Current release: v1.0.0”** | No `v1.0.0` tag; workspace still `0.9.0`. `docs/known-limitations.md` still titled for **v0.9.0 RC**. |
| **“open-source”** (lede) | Conflicts with LICENSE + README license section: **source-available**, not OSI open source. Redistribution of modified versions needs author permission. |
| **Screenshot gallery paths** `assets/readme/*.png` | Directory **`assets/readme/` is empty**. All four README images 404. |
| **Implied “release screenshots are current Emerald Commons”** | Only extant product PNGs: `docs/screenshots/{dashboard,text-chat}-current.png` (May 2026, pre–full Emerald Commons recapture plan). `docs/readme-screenshot-plan.md` says recapture into `assets/readme/` — not done. |
| **GitHub shields/badges** | None in root README (only text nav links). Vendor READMEs have crates.io badges — irrelevant. |
| **Docker “serves HTTP on 8090” without nuance** | Compose publishes **`127.0.0.1:8090` only** (loopback) + UDP `8443`. Not LAN-open by default. TLS off inside container; browser voice needs HTTPS proxy. |
| **Desktop updater “can use built-in updater when artifacts published”** | Technically true only for **signed official** releases; unsigned/local builds must not advertise updates (`docs/known-limitations.md`). Soften or omit until a signed release workflow has actually published updater artifacts. |
| **macOS silence + “Windows and Linux”** | Correct to omit macOS as supported desktop target. macOS **system audio capture not implemented**. Do not expand to “macOS supported.” |
| **Federation “cross-server messaging, file proxying, and federated discovery are built in”** | Code/routes exist, but protocol docs say **MVP / evolving**; known-limitations: validate every flow before public federation. Avoid “production-ready federation” tone. |
| **`SELF_HOSTING_DEPLOYMENT_GUIDE.md` LiveKit-centric examples** | Operator guide still shows LiveKit-heavy production YAML; newer docs (`getting-started`, `deployment`) say native default. Prefer linking newer docs from README; don’t copy old LiveKit-required framing. |
| **Architecture tree omits crates** | Workspace has 13 crates including `paracord-models`, `paracord-util`, `paracord-media-dev` — README tree is abbreviated (OK if labeled incomplete). |

---

## 3. Brand voice

**From Emerald Commons (`docs/design-spec.md`):**

- Direction: **Expressive & Social, but MATURE.** Warm, alive, community-feeling — never childish, never corporate-sterile.
- Personality from craft: warm-neutral dark, calibrated emerald spent only on meaning, real elevation, display face on headings, restrained motion.
- Anti-hype / anti-slop: no gradient hero washes, no emoji chrome, no placeholder microcopy, no purple-glow SaaS tone.
- Empty-state / product copy style: specific, warm, human, actionable.

**From existing README closing line (good keep):**

> Built for communities who want their conversations back.

**Voice rules for README prose:**

- Prefer concrete operator facts (“one binary”, “port 8443 TCP+UDP”, “first account is owner”) over slogans.
- Avoid: “revolutionary”, “Discord killer”, “blazing fast”, “enterprise-grade”, “fully federated”, “open source” (unless license changes).
- Prefer: “self-hosted”, “source-available”, “native QUIC”, “optional”, “disabled by default”, “Windows and Linux desktop”.
- Name product systems once with correct casing: **Emerald Commons**, **Rooms**, **Unified Stream** / unified sidebar.

---

## 4. Feature truths (safe claims)

### Core platform

- Guilds/spaces, text channels, voice, stage, forum, threads, DMs / group DMs.
- Roles & permissions (30 flags), moderation, audit logs.
- Friends, invites, server discovery, guild templates.
- Polls, custom emoji, scheduled events, file uploads + guild storage policies.
- Bots: developer portal, bot tokens, OAuth-style install, slash commands, webhooks (`docs/bot-development.md`); JS SDK under `packages/paracord-bot-sdk` (note: package may be MIT while app is source-available — don’t overclaim SDK license without checking).
- Multi-server accounts with Ed25519 identity carrying across servers; unified sidebar merges attention across connected servers.

### Self-hosting

- Zero-config binary first run; `init` subcommand.
- Docker Compose zero-config for secrets (JWT generated into volume); LiveKit via `--profile livekit` only.
- Embedded web UI in release server binary (`embed-ui` feature, default on).
- PostgreSQL recommended for sustained multi-user production; SQLite fine for small instances.
- `paracord-server migrate-to-postgres` exists for offline migration.

### Media

- Default: native QUIC (desktop) / WebTransport (browser) with E2EE media path.
- LiveKit optional fallback.
- VP9 screen share / video depends on libvpx in desktop builds.
- Platform capture: Windows primary; Linux PipeWire/portal functional but distro-dependent; macOS system audio **not** implemented.

### Privacy / crypto (careful wording)

- Optional E2EE for **direct messages** (X25519 + AES-GCM).
- Native media path includes E2EE for voice/video frames (codec/relay layer).
- At-rest encryption (AES-256-GCM) for configured secrets/data paths — don’t imply “all data E2EE on server disk.”
- Session JWT auth + Ed25519 cryptographic identity.

### Client UX

- Emerald Commons themes: dark (default), light, AMOLED, high-contrast; custom CSS.
- Rooms view as guild home; unified sidebar Needs you / Recent / Spaces; ContextPanel for members/threads/pins/search.
- Command palette (Ctrl/⌘K); Tauri desktop for Windows & Linux; browser client via server URL.

---

## 5. In-repo visual assets inventory

| Asset | Path | Status for README |
|-------|------|-------------------|
| Logo banner | `docs/logo-banner.svg` | **Use** — already in README hero |
| App icon | `client/app-icon.png` (1024²) | Optional small mark; packaging |
| PWA icons | `client/public/pwa-*.png` | Not ideal for README hero |
| Tauri icons | `client/src-tauri/icons/**` | Packaging only |
| Planned gallery | `assets/readme/*.png` | **Missing (empty dir)** — do not link until captured |
| Older RC shots | `docs/screenshots/dashboard-current.png`, `text-chat-current.png` | 1440×900 May 2026; may predate full Emerald Commons / Rooms IA — use only with caveat or replace |
| Screenshot plan | `docs/readme-screenshot-plan.md` | Follow for recapture filenames |
| Release inventory | `docs/release-screenshot-inventory.md` | Says defer voice/stream shots until media validation |
| Shields/badges | — | **None** maintained for Paracord itself |

**Screenshot guidance for the writing agent:**

1. Prefer no broken images: either omit gallery until `assets/readme/` is filled, or temporarily use `docs/screenshots/*` with honest captions.
2. Must-have captures per plan: `home.png`, `sidebar-unified.png` / `unified-sidebar.png`, `rooms-view.png`, `text-chat.png`.
3. Defer live voice/stream screenshots until validated (per release inventory).

**Suggested badges (optional, after tag):**

- Release: `https://img.shields.io/github/v/release/Scoduglas1999/Paracord`
- License: custom “Source-Available” (not MIT/Apache)
- Avoid CI-passing green theater badges unless workflow status is intentionally advertised.

---

## 6. Recommended README structure (GitHub-optimized)

Professional, not hypey. Order matters for skim readers.

1. **Hero** — centered `docs/logo-banner.svg` + one-liner + short supporting sentence  
2. **Nav row** — Download / Quick Start / Docs / Features / License (no fake badge spam)  
3. **Version line** — honest tag (`v0.9.0` or `v1.0.0` only if tagged)  
4. **What is Paracord?** — 1 short paragraph + 2–3 bullets (owner account, native media, self-host)  
5. **Screenshots** — 2×2 table only if files exist; else omit section  
6. **Features** — grouped: Self-hosting · Media · Client (Emerald Commons / Rooms) · Bots · Federation (cautious) · Crypto · Platform checklist  
7. **Quick Start** — Path A binary · Path B Docker · One-port note · link Getting Started  
8. **Desktop client** — Windows/Linux table + browser URL; no macOS claim  
9. **Architecture** — short table + abbreviated tree (optional; keep compact)  
10. **Development** — clone, two-terminal run, test commands matching repo **today**  
11. **Documentation** — table of real docs paths  
12. **Known limitations** — link prominently (builds trust)  
13. **License & contributing** — source-available clarity, no “open source”  
14. **Footer tagline** — existing closing line

---

## 7. Ready-to-use copy blocks

### Tagline options (pick one)

1. **Primary (recommended):**  
   `Self-hosted community chat — native QUIC voice & video, no third-party media cloud required.`

2. **Brand-forward:**  
   `Paracord — run your own community. Emerald Commons UI, Rooms layout, native QUIC media.`

3. **Operator-forward:**  
   `Stand up a private Discord-style server in one command. First account owns it.`

4. **Closing (keep):**  
   `Built for communities who want their conversations back.`

### Hero supporting sentence

```text
Paracord is a source-available, self-hostable chat platform: guilds, channels,
DMs, bots, and optional federation on your hardware. Voice and video use
Paracord’s own QUIC/WebTransport engine by default — LiveKit is optional.
```

### Feature bullets (accurate)

```markdown
- **Zero-config self-hosting** — start `paracord-server` (or `docker compose up`);
  config, JWT secret, and SQLite are created on first run. The first registered
  account becomes the server owner.
- **Native QUIC media (default)** — voice, video, and screen share over
  QUIC/WebTransport with E2EE. Forward **8443/tcp and 8443/udp** for remote
  access. LiveKit remains an optional WebRTC SFU.
- **Emerald Commons + Rooms** — mature warm-neutral UI with emerald accents;
  unified sidebar across servers (Needs you / Recent / Spaces) and a
  presence-first Rooms home per space.
- **Bots & webhooks** — developer portal, bot accounts, slash commands, and
  webhooks for integrations.
- **Optional federation** — Ed25519-signed server-to-server envelopes; off by
  default; enable only with trusted peers.
- **Optional E2EE DMs** — X25519 key exchange and AES-GCM for direct messages.
- **Multi-server** — connect to multiple Paracord hosts; the sidebar merges
  attention across them.
- **Desktop + browser** — Tauri v2 clients for Windows and Linux; open the
  server URL in a browser for the embedded web UI.
```

### Quick-start commands (match repo TODAY)

**Binary (release artifact or local build):**

```bash
./paracord-server init   # optional: write config + print next steps, exit
./paracord-server        # start (use -c <path> for a custom config)
```

```powershell
.\paracord-server.exe
```

**From source (production-like server with embedded UI):**

```bash
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord
cd client && npm install && npm run build && cd ..
cargo build --release --bin paracord-server
./target/release/paracord-server
```

**Docker Compose:**

```bash
git clone https://github.com/Scoduglas1999/Paracord.git
cd Paracord
docker compose up -d
# HTTP on 127.0.0.1:8090 (loopback); native media UDP 8443
# Put TLS reverse proxy in front for browser mic/camera; see docs/getting-started.md
```

**Local development (two terminals):**

```bash
# Terminal 1 — Vite client (:1420), proxies to server
cd client && npm install && npm run dev

# Terminal 2 — API/gateway without embedding UI (UI served by Vite)
cargo run --bin paracord-server --no-default-features
```

**Verify / test:**

```bash
cargo check --workspace
cargo test --workspace
cd client && npm test
```

### Desktop client blurb

```markdown
Installers ship on the [Releases](../../releases/latest) page when published.

| Platform | Format |
|----------|--------|
| Windows  | `.exe` / `.msi` |
| Linux    | `.deb` (and release tarballs as published) |
| Browser  | `https://<host>:8443` (binary TLS) or your reverse-proxy URL |

The desktop app can auto-trust self-signed server certificates and uses the
native Opus/RNNoise/VP9 pipeline over QUIC when built with libvpx.
```

### License blurb (required accuracy)

```markdown
Paracord is **source-available** under the [Paracord Source-Available License](LICENSE)
(Copyright © 2026 Sean Douglas). You may use, study, and modify it for personal
use and share official releases. Redistribution of modified versions and
derivative works requires written permission from the author.
```

---

## 8. Claims that must NOT be made

1. **Do not say “open source” / OSI / MIT/Apache for the app** — it is source-available with redistribution limits. (Bot SDK license is a separate package decision.)
2. **Do not claim current release is `v1.0.0` until tagged** and Cargo/npm/Tauri match.
3. **Do not link `assets/readme/*.png` until files exist** — broken images are worse than no gallery.
4. **Do not claim macOS desktop support** or macOS system-audio capture.
5. **Do not claim federation is production-complete / Matrix-parity / always-on** — MVP, off by default, evolving.
6. **Do not claim LiveKit is required** — or that Docker needs a hand-edited `.env` for the default native path.
7. **Do not claim automatic updates for all builds** — only signed official releases with updater artifacts.
8. **Do not claim “everything is E2EE”** — DMs optional; guild/channel content is server-visible; at-rest ≠ E2EE.
9. **Do not claim Linux screen share is universally solid** without “depends on portal/PulseAudio; validate on your distro.”
10. **Do not disable or recommend disabling the `vpx` feature** as a workaround.
11. **Do not imply Docker publishes cleartext HTTP to the LAN by default** — loopback bind is intentional.
12. **Do not use voice/streaming screenshots** that imply validated multi-peer media until release inventory allows it.
13. **Do not copy purple-gradient / “AI SaaS” marketing tone** — violates Emerald Commons kill-list spirit for brand consistency.
14. **Do not promise enterprise SLA, infinite scale, or “Discord replacement feature-complete.”** Prefer “Discord alternative you host.”

---

## 9. Doc / deep-link map for the writing agent

| Link from README | Path |
|------------------|------|
| Getting Started | `docs/getting-started.md` |
| Deployment | `docs/deployment.md` |
| Docker | `docs/docker-setup.md` |
| Design (Emerald Commons) | `docs/design-spec.md` |
| Layout (Rooms + Unified Stream) | `docs/layout-spec.md` |
| Known limitations | `docs/known-limitations.md` |
| Bot development | `docs/bot-development.md` |
| Federation protocol (MVP) | `docs/federation-protocol.md` |
| Operator runbook | `SELF_HOSTING_DEPLOYMENT_GUIDE.md` (prefer newer deployment docs for media defaults) |
| Release notes | `RELEASE_NOTES.md` |
| Screenshot capture plan | `docs/readme-screenshot-plan.md` |
| This brief | `docs/marketing/README_BRIEF.md` |

---

## 10. Checklist before publishing the new README

- [ ] Version string matches git tag + `Cargo.toml` / `package.json` / `tauri.conf.json`
- [ ] License wording = source-available everywhere (no “open-source” slip)
- [ ] Every image `src=` resolves to a real file
- [ ] Quick-start commands copy-pasted and smoke-tested
- [ ] Docker section mentions loopback HTTP + TLS proxy for browser media
- [ ] Federation / E2EE / updater / macOS claims stay inside §8 bounds
- [ ] Link to `docs/known-limitations.md` remains visible
- [ ] Footer tagline retained or deliberately replaced with equal warmth

---

## Appendix A — Architecture one-liner for README

Rust workspace (axum, SQLx SQLite/Postgres) + Tauri v2 / React 19 client.
Native media: `paracord-transport` (QUIC/WebTransport), `paracord-relay`,
`paracord-codec` (Opus, RNNoise, VP9). Optional LiveKit via `paracord-media`.
Federation: `paracord-federation`. Embedded UI in `paracord-server` (`embed-ui`).

## Appendix B — Top findings summary (for handoff)

**Must-keep facts:** self-host zero-config; first account = owner; native QUIC default; Emerald Commons + Rooms IA shipped; source-available license.

**Must-remove / fix:** v1.0.0-as-current; “open-source”; broken `assets/readme/` images; overconfident federation; macOS/updater overclaim.
