# Paracord Comprehensive Analysis Report

**Date:** 2026-03-01
**Purpose:** Full-spectrum analysis of the Paracord decentralized chat platform with actionable recommendations for meaningful improvements.

---

## Table of Contents

1. [Market Research & Competitive Analysis](#1-market-research--competitive-analysis)
2. [UI Design Analysis](#2-ui-design-analysis)
3. [User Experience Analysis](#3-user-experience-analysis)
4. [Feature Completeness Audit](#4-feature-completeness-audit)
5. [New Feature Recommendations](#5-new-feature-recommendations)
6. [Security Hardening](#6-security-hardening)
7. [Performance Analysis](#7-performance-analysis)
8. [Code Quality & Architecture](#8-code-quality--architecture)

---

<!-- SECTION: market-research -->
## 1. Market Research & Competitive Analysis

### 1.1 Competitive Landscape Overview

The real-time communication platform market in 2026 is experiencing a significant inflection point. Discord's controversial age verification mandate (requiring facial recognition or government ID), combined with a prior data breach exposing ~70,000 users' government IDs, has driven searches for "Discord alternatives" up by over 10,000%. This presents a rare window of opportunity for privacy-respecting, self-hostable alternatives like Paracord.

#### Major Competitors

**Tier 1: Dominant Incumbents**

| Platform | Type | Users | Strengths | Weaknesses |
|----------|------|-------|-----------|------------|
| **Discord** | Centralized, proprietary | 200M+ MAU | Massive ecosystem, polished UX, bot marketplace, streaming, Nitro monetization | Proprietary, age verification controversy, data breach history, no self-hosting, no federation, growing privacy concerns |
| **Slack/Teams** | Centralized, enterprise | 400M+ combined | Enterprise integrations, compliance, large org support | Not community-focused, expensive, no self-hosting (Teams has on-prem but deprecated), no E2EE |

**Tier 2: Open-Source Community Platforms**

| Platform | Type | Users | Strengths | Weaknesses |
|----------|------|-------|-----------|------------|
| **Matrix/Element** | Federated, open protocol | 100M+ accounts | True federation, government adoption (16+ nations), E2EE by default, protocol-level interop, bridge ecosystem | Complex setup, performance issues with large rooms, fragmented client ecosystem, steep learning curve |
| **Stoat (formerly Revolt)** | Open-source, self-hostable | ~500K+ | Discord-like UX, Rust backend, privacy-focused, no ID verification, growing rapidly | Smaller ecosystem, federation not yet implemented, limited bot ecosystem, recent rebrand confusion |
| **Rocket.Chat** | Open-source, enterprise | Large enterprise base | Enterprise compliance (HIPAA, GDPR), self-hosting, extensive integrations, omnichannel support | Slack-like (not Discord-like), complex admin, enterprise pricing for advanced features, not federated |

**Tier 3: Specialized Alternatives**

| Platform | Type | Strengths | Weaknesses |
|----------|------|-----------|------------|
| **Mattermost** | Open-source, enterprise | Slack replacement, DevOps integrations, compliance | Enterprise-focused, not community-oriented, limited free tier |
| **Zulip** | Open-source, threaded | Unique topic-based threading, excellent for async, open-source projects | Niche UX (email-like), small community, not Discord-like |
| **Mumble** | Open-source, voice-only | Sub-20ms latency voice, lightweight, self-hostable, free | Voice-only (no text/community features), dated UI, no mobile apps |
| **TeamSpeak** | Proprietary, voice-focused | 3D positional audio, gaming-optimized | Proprietary, paid server hosting, limited text features |
| **Signal** | Open-source, encrypted | Best-in-class E2EE, 70M MAU, CIA-endorsed privacy | 1:1/group messaging only, no server/guild model, no community features |
| **Guilded** | Shut down (Dec 2025) | Was a strong Discord competitor | Acquired by Roblox ($90M), shut down, users displaced -- potential Paracord targets |

### 1.2 Paracord's Current Positioning

Based on codebase analysis, Paracord occupies a unique position in the market that no single competitor currently fills. It combines:

1. **Discord-compatible UX model**: Guilds, channels (text, voice, forum, stage, announcement, threads), roles, permissions, invites, reactions, polls, webhooks, bots, custom emoji -- the full Discord feature vocabulary
2. **True federation**: Ed25519-signed HTTP envelope protocol for server-to-server communication, allowing independent Paracord instances to interoperate (similar to Matrix but with Discord's UX)
3. **Self-hosting first**: Single binary deployment with SQLite or PostgreSQL, TOML configuration, auto-generated secrets
4. **Native media stack**: Custom QUIC/WebTransport media transport with VP9 video, Opus audio, RNNoise noise suppression, bandwidth estimation, and VAD -- not dependent on third-party services like LiveKit (though LiveKit is also supported as a fallback)
5. **E2EE for DMs**: Client-side end-to-end encryption for direct messages
6. **Desktop-native client**: Tauri v2 (Rust + React 19) providing native performance without Electron's resource overhead
7. **At-rest encryption**: AES-256-GCM encryption for stored data
8. **Comprehensive API**: REST + WebSocket gateway with resume/replay, mirroring Discord's API patterns

**Positioning statement**: Paracord is the only platform that combines Discord's community-oriented UX with Matrix-like federation, Signal-like encryption, and Mumble-like native media performance -- all in a self-hostable package.

### 1.3 Key Differentiators

| Differentiator | Paracord | Nearest Competitor | Paracord's Advantage |
|----------------|----------|-------------------|---------------------|
| **Federation + Discord UX** | Ed25519-signed federation with full guild/channel model | Matrix (federation) or Stoat (Discord UX), but not both | Only platform combining both; users get Discord's familiar experience without sacrificing decentralization |
| **Native media transport** | Custom QUIC/WebTransport with VP9, Opus, RNNoise, bandwidth estimation | LiveKit (requires separate infrastructure) | Zero external dependencies for voice/video; lower latency, simpler deployment |
| **Rust server + Tauri client** | Full-stack Rust (axum + Tauri v2) | Stoat (Rust backend, but web-only client) | Superior resource efficiency and native desktop performance; no Electron overhead |
| **Dual database support** | SQLite (single-node) and PostgreSQL (scalable) | Most competitors require PostgreSQL or MongoDB | SQLite mode enables single-binary, zero-config deployment for small communities |
| **DM E2EE** | Built-in client-side encryption for DMs | Matrix (full E2EE), Signal (full E2EE) | E2EE integrated into Discord-like UX without complexity of Matrix key management |
| **At-rest encryption** | AES-256-GCM for stored data | Rarely offered in self-hosted chat | Data protection even if server storage is compromised |
| **Bot system with interactions** | Slash commands, message components, application commands | Discord (massive ecosystem), Matrix (limited bots) | Discord-compatible bot API patterns make porting bots easier |
| **Forum channels** | Full forum channel type with tags, sorting, FTS | Discord (recently added), Matrix (no equivalent) | Better async discussion support than most alternatives |

### 1.4 Market Gaps and Opportunities

#### Gap 1: Federated Discord Alternative (HIGH PRIORITY)
No existing platform offers Discord's guild/channel/role model with true server-to-server federation. Matrix has federation but a fundamentally different UX. Stoat has Discord's UX but no federation. Paracord is uniquely positioned to fill this gap.

**Opportunity**: Position as "the fediverse's Discord" -- interoperable community servers with familiar UX. Target communities already familiar with ActivityPub/Mastodon who want federated chat.

#### Gap 2: Post-Discord Privacy Refugees (HIGH PRIORITY, TIME-SENSITIVE)
Discord's age verification controversy and data breach have created a wave of users actively seeking alternatives. Searches spiked 10,000%+ in February 2026. Guilded's shutdown in December 2025 displaced additional users.

**Opportunity**: Capture migrating users with a clear "no ID required, self-host your data" message. Create one-click migration tools for Discord server exports.

#### Gap 3: Government and Enterprise Sovereignty (MEDIUM PRIORITY)
16+ national governments use Matrix for sovereign communications. Healthcare systems (Germany's 150K+ organizations serving 74M citizens) are deploying federated chat. But Matrix's UX complexity limits adoption.

**Opportunity**: Offer Paracord as a simpler, Discord-familiar alternative for organizations that need sovereignty and federation but find Matrix too complex.

#### Gap 4: Gaming Communities Without Corporate Overhead (MEDIUM PRIORITY)
Gaming communities want voice chat (low latency), text channels, bots, and no corporate surveillance. Discord serves this market but increasingly prioritizes monetization over community needs.

**Opportunity**: Paracord's native QUIC media transport could deliver Mumble-class voice latency with Discord-class community features. Target gaming clans, esports teams, and Minecraft/game server operators who already self-host.

#### Gap 5: Developer and Open-Source Project Communication (MEDIUM PRIORITY)
Open-source projects need persistent, searchable, community-oriented chat. Many use Discord (proprietary, ephemeral) or Matrix (complex). Zulip serves this niche but lacks Discord's community features.

**Opportunity**: Forum channels + federation + self-hosting makes Paracord attractive for open-source projects that want to own their communication infrastructure.

### 1.5 Target Audience Analysis

#### Primary Audiences (Highest conversion potential)

**1. Privacy-Conscious Discord Users**
- **Size**: Millions of users actively seeking alternatives (10,000%+ search spike)
- **Pain points**: Age verification, data breaches, surveillance, proprietary lock-in
- **What they want**: Same UX, no ID requirements, data ownership
- **Conversion strategy**: Discord server export/import tools, familiar UI, "switch in 5 minutes" marketing
- **Retention risk**: Will leave if UX is significantly worse than Discord

**2. Self-Hosting Enthusiasts and Homelab Operators**
- **Size**: Growing community (r/selfhosted: 500K+ members, r/homelab: 1M+)
- **Pain points**: Limited self-hostable Discord alternatives with full feature parity
- **What they want**: Docker one-liner deployment, low resource usage, SQLite simplicity
- **Conversion strategy**: Single-binary deployment, excellent docs, Ansible/Docker Compose templates
- **Retention risk**: Low -- once self-hosted, switching costs are high

**3. Open-Source and Developer Communities**
- **Size**: Tens of thousands of projects currently on Discord or Matrix
- **Pain points**: Discord is proprietary and ephemeral; Matrix is complex
- **What they want**: Self-hosted, searchable, persistent, with forum/thread support
- **Conversion strategy**: GitHub integration, bot API compatibility, forum channels
- **Retention risk**: Medium -- depends on community migration coordination

#### Secondary Audiences (Longer-term growth)

**4. Small Organizations and Teams (10-100 people)**
- **Pain points**: Slack/Teams too expensive, Discord too informal, Rocket.Chat too complex
- **What they want**: Simple self-hosted chat with voice, manageable admin, low cost
- **Conversion strategy**: Zero-cost self-hosting, admin dashboard, LDAP/SSO support (roadmap)

**5. Gaming Communities and Esports Teams**
- **Pain points**: Discord monetization pressure, Mumble lacks text/community features
- **What they want**: Low-latency voice, text channels, bots, game integrations
- **Conversion strategy**: Native media latency benchmarks, game overlay (Tauri), bot ecosystem

**6. Fediverse-Aligned Users**
- **Pain points**: No federated Discord-like platform exists
- **What they want**: Decentralized community platform interoperable with other instances
- **Conversion strategy**: Federation features, Mastodon/fediverse cross-promotion

### 1.6 Growth and Adoption Strategy

#### Phase 1: Foundation (Months 1-6) -- Build Credibility

1. **Publish benchmarks**: Latency comparisons (voice latency vs. Discord/Mumble), resource usage (RAM/CPU vs. Element/Rocket.Chat), message throughput
2. **One-click deployment**: Docker image, docker-compose.yml, Helm chart, Coolify/Cloudron app
3. **Discord migration tool**: Import Discord server export (channels, messages, roles, permissions) into Paracord
4. **Documentation blitz**: Comprehensive self-hosting guide, API documentation, bot development guide
5. **Dogfood**: Use Paracord for Paracord development -- host the project's own community server

#### Phase 2: Community (Months 6-12) -- Build Network Effects

1. **Bot SDK/framework**: TypeScript and Python bot libraries mirroring discord.js/discord.py APIs for easy porting
2. **Public directory**: Federated server discovery for finding and joining public communities
3. **Bridge to Discord**: Allow Paracord channels to mirror Discord channels (easing migration)
4. **Content creator outreach**: Target tech YouTubers and privacy advocates for reviews
5. **Guilded refugee campaign**: Target displaced Guilded communities with migration support

#### Phase 3: Scale (Months 12-24) -- Build Ecosystem

1. **Mobile clients**: iOS and Android apps (React Native or native)
2. **Plugin/extension system**: Server-side plugins for custom functionality
3. **Enterprise features**: LDAP/SAML SSO, audit logs, compliance exports, SLA
4. **Federation protocol specification**: Publish formal spec to enable third-party implementations
5. **Marketplace**: Theme store, bot directory, plugin marketplace

#### Key Adoption Metrics to Track

| Metric | Target (6 months) | Target (12 months) | Target (24 months) |
|--------|-------------------|--------------------|--------------------|
| Self-hosted instances | 500 | 5,000 | 25,000 |
| Registered users (all instances) | 10,000 | 100,000 | 1,000,000 |
| Federated server pairs | 50 | 500 | 5,000 |
| GitHub stars | 5,000 | 15,000 | 50,000 |
| Active bots | 50 | 500 | 5,000 |
| Monthly active users | 2,000 | 30,000 | 300,000 |

### 1.7 Competitive Feature Matrix

| Feature | Discord | Matrix/Element | Stoat (Revolt) | Rocket.Chat | Mattermost | Zulip | Mumble | Paracord |
|---------|---------|---------------|-----------------|-------------|------------|-------|--------|----------|
| **Self-Hostable** | No | Yes | Yes | Yes | Yes | Yes | Yes | **Yes** |
| **Open Source** | No | Yes (Apache 2.0) | Yes (AGPL) | Yes (MIT) | Yes (MIT/AGPL) | Yes (Apache 2.0) | Yes (BSD) | **Yes** |
| **Federation** | No | Yes (native) | No | No | No | No | No | **Yes** |
| **E2E Encryption** | No | Yes (Megolm) | Partial (in progress) | Yes (OTR) | Enterprise only | No | Yes (voice) | **Yes (DMs)** |
| **At-Rest Encryption** | Unknown | No | No | No | Enterprise only | No | No | **Yes (AES-256-GCM)** |
| **Guild/Server Model** | Yes | Spaces (limited) | Yes | No (channels) | No (teams) | No (streams) | No (channels) | **Yes** |
| **Text Channels** | Yes | Yes | Yes | Yes | Yes | Yes | Limited | **Yes** |
| **Voice Chat** | Yes | Yes (Element Call) | Yes | No (plugin) | No (plugin) | No | Yes | **Yes (native QUIC)** |
| **Video/Screen Share** | Yes | Yes | Limited | No | No | No | No | **Yes (VP9)** |
| **Forum Channels** | Yes | No | No | No | No | Yes (topics) | No | **Yes** |
| **Threads** | Yes | Yes | No | Yes | Yes | Native | No | **Yes** |
| **Stage Channels** | Yes | No | No | No | No | No | No | **Yes** |
| **Roles & Permissions** | Yes | Limited | Yes | Yes | Yes | Limited | Yes (ACL) | **Yes (bitflags)** |
| **Bot API** | Yes (large ecosystem) | Yes (limited) | Yes (small) | Yes (extensive) | Yes | Yes | No | **Yes** |
| **Slash Commands** | Yes | No | No | Yes | Yes | No | No | **Yes** |
| **Webhooks** | Yes | Yes | Yes | Yes | Yes | Yes | No | **Yes** |
| **Custom Emoji** | Yes (Nitro) | Yes | Yes | Yes | Yes | Yes | No | **Yes** |
| **Reactions** | Yes | Yes | Yes | Yes | Yes | Yes | No | **Yes** |
| **Polls** | Yes | Yes | No | Yes | No | Yes | No | **Yes** |
| **File Uploads** | Yes | Yes | Yes | Yes | Yes | Yes | No | **Yes** |
| **Message Embeds** | Yes | Limited | Yes | Yes | Yes | No | No | **Yes** |
| **Audit Logs** | Yes | Limited | No | Yes | Yes | Limited | No | **Yes** |
| **Invite System** | Yes | Yes | Yes | No | No | Yes | No | **Yes** |
| **Desktop App** | Yes (Electron) | Yes (Electron) | Web only | Yes (Electron) | Yes (Electron) | Web + mobile | Yes (native) | **Yes (Tauri v2, native)** |
| **Mobile App** | Yes | Yes | Yes (limited) | Yes | Yes | Yes | Yes (3rd party) | **Not yet** |
| **Web Client** | Yes | Yes | Yes | Yes | Yes | Yes | No | **Embedded in server** |
| **SQLite Support** | N/A | No (requires Postgres) | No (requires MongoDB) | No (requires MongoDB) | No (requires Postgres) | No (requires Postgres) | Yes (SQLite) | **Yes** |
| **Single Binary Deploy** | N/A | No | No | No | No | No | Yes | **Yes** |
| **S3 Storage** | N/A | Yes | No | Yes | Yes | Yes | N/A | **Yes** |
| **Rate Limiting** | Yes | Yes | Limited | Yes | Yes | Yes | N/A | **Yes** |
| **User Presence** | Yes | Yes | Yes | Yes | Yes | Limited | Yes (voice) | **Yes** |
| **Typing Indicators** | Yes | Yes | Yes | Yes | Yes | Yes | N/A | **Yes** |
| **Message Search** | Yes (Nitro) | Yes | Limited | Yes | Yes | Yes | N/A | **Yes (FTS)** |
| **GIF Integration** | Yes (built-in) | No | No | No | Yes | No | No | **Yes (Tenor)** |
| **MFA/TOTP** | Yes | Yes | No | Yes | Yes | Yes | No | **Yes** |

### 1.8 Strategic Recommendations

1. **Lead with the privacy narrative**: Discord's age verification controversy is the #1 acquisition opportunity in 2026. Every marketing message should contrast Paracord's "no ID, no tracking, your server your rules" stance against Discord's mandatory biometric collection.

2. **Prioritize mobile clients**: The biggest gap in Paracord's competitive position is the lack of mobile apps. Every major competitor has them. This is a dealbreaker for most consumer users and should be the top development priority after core stability.

3. **Invest in migration tooling**: The easier it is to switch from Discord, the more users will switch. A Discord server export importer, a Discord bot bridge, and a "Paracord looks and works like Discord" landing page would be high-ROI investments.

4. **Publish a federation specification**: Paracord's federation is its strongest moat against Stoat/Revolt. Publishing a formal specification would attract implementers, build credibility, and establish Paracord as a protocol, not just an application.

5. **Target the Guilded diaspora**: Guilded shut down December 2025, displacing communities that already chose a Discord alternative once. These users are pre-qualified leads -- they have demonstrated willingness to leave Discord and are now looking for a new home again.

6. **Benchmark native media performance**: Paracord's custom QUIC/WebTransport media stack is a technical differentiator. Publishing latency and quality benchmarks against Discord and Mumble would appeal to gaming communities and technical users.

7. **Build the bot ecosystem**: Discord's bot ecosystem is its strongest network effect. Paracord should invest in Discord-API-compatible bot SDKs (TypeScript/Python) that make porting existing bots trivial, and host a bot directory.

### 1.9 SWOT Analysis

| | Positive | Negative |
|---|---------|----------|
| **Internal** | **Strengths**: Full-stack Rust performance, unique federation+Discord-UX combination, native media stack, dual DB support, E2EE, at-rest encryption, comprehensive feature set, single-binary deployment | **Weaknesses**: No mobile client, small community, no established bot ecosystem, early-stage federation protocol, limited documentation/marketing, no LDAP/SSO, unproven at scale |
| **External** | **Opportunities**: Discord privacy backlash (10,000%+ search spike), Guilded shutdown diaspora, government sovereignty demand, growing self-hosting movement, fediverse momentum | **Threats**: Matrix's established federation network and government adoption, Stoat's rapid growth and brand recognition, Discord potentially reversing course on ID requirements, resource constraints of solo/small-team development |

### 1.10 Conclusion

Paracord enters the market at an exceptionally favorable moment. Discord's self-inflicted privacy crisis, Guilded's shutdown, and growing demand for digital sovereignty have created the largest window of opportunity for Discord alternatives in the platform's history. Paracord's unique combination of Discord-familiar UX, true federation, native media, and self-hosting simplicity positions it to capture a meaningful share of this migration.

The critical success factors are: (1) shipping mobile clients to remove the biggest adoption barrier, (2) investing in migration tooling to reduce switching friction, (3) building a bot ecosystem to create network effects, and (4) publishing federation specifications to establish Paracord as a protocol standard. The technology foundation is strong -- the challenge now is community building and ecosystem development.

<!-- END SECTION: market-research -->

---

<!-- SECTION: ui-design -->
## 2. UI Design Analysis

### 2.1 Visual Design System

Paracord implements a mature, Discord-inspired design system built on CSS custom properties with Tailwind CSS v4. The system is defined in `client/src/styles/globals.css` (1746 lines) and provides a comprehensive token architecture.

**Design Tokens & Typography**
- Primary font: Inter (system fallback chain included). Monospace: JetBrains Mono for code blocks.
- Spatial tokens for layout dimensions: `--header-height: 3rem`, `--sidebar-width: 4.5rem`, `--channel-panel-width: 16.25rem`, `--member-panel-width: 15rem`.
- Color tokens follow a semantic naming convention: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-primary`, `--accent-danger`, `--accent-success`, `--accent-warning`.
- Border tokens: `--border-subtle`, `--border-strong` with opacity-based layering.

**Strengths:**
- Consistent use of semantic color tokens throughout all components. Hardcoded color values are rare.
- The glassmorphism depth system (`glass-rail` at 28px blur, `glass-panel` at 18px, `glass-modal` at 12px) creates clear visual hierarchy across dock, panels, and modals.
- Ambient glow effects (`--ambient-glow-primary`, `--ambient-glow-success`) add a polished, modern feel to settings panels and modals.
- Well-defined reusable CSS classes: `btn-primary`, `btn-ghost`, `btn-danger`, `input-field`, `select-field`, `tab-btn`, `channel-item`, `member-item`, `icon-btn`, `guild-icon`, `context-menu`, `settings-nav-item`, `auth-card`, `auth-shell`, `card-surface`, `panel-surface`.
- Animations are tasteful and purposeful: `skeleton-pulse`, `modal-enter`, `overlay-enter`, `popup-enter`, `voice-pulse`, `scale-in`, `toast-slide-in`.

**Weaknesses:**
- The `globals.css` file at 1746 lines is monolithic. It mixes base styles, component styles, theme definitions, animations, and utility overrides. Extracting themes and animations into separate files would improve maintainability.
- Some inline styles bypass the design system. For example, `BotStoreSection.tsx:237` uses inline `color-mix` style which is creative but not tokenized. Similar inline style patterns appear in `ThemeSelector.tsx` and `GuildSettings.tsx`.
- The `ThemeSelector.tsx` component defines its own `ACCENT_COLORS` array (line 11-20) with different color values than the 10 accent presets in `useTheme.ts`, creating two divergent accent color systems.

### 2.2 Theme System

Four theme variants are implemented via `[data-theme]` selectors in `globals.css` and managed through `useTheme.ts` (363 lines):

| Theme | Characteristics |
|-------|----------------|
| **Dark** (default) | Deep navy/gray palette. Primary bg `#1a1a2e`, secondary `#16172b`. |
| **Light** | Bright palette with adequate contrast. Primary bg `#f8f9fc`, text `#1a1a2e`. |
| **AMOLED** | Pure black backgrounds (`#000000`). Optimized for OLED displays. |
| **High Contrast** | Pure black with high-visibility borders (`#ffffff26`) and brighter text. |

**10 Accent Color Presets** (`useTheme.ts:14-91`): red, blue, emerald, amber, rose, violet, cyan, lime, orange, slate. Each preset includes primary, hover, and RGB triplet values applied as CSS custom properties.

**Strengths:**
- Complete variable coverage per theme -- each theme overrides 80+ CSS variables ensuring no visual gaps.
- Accent presets are cleanly separated from base themes, allowing any accent with any theme.
- Custom CSS injection is supported with `sanitizeCustomCss()` preventing `@import`, `url()`, and JavaScript injection.
- Density modes (compact, comfortable, default) via `data-density` attribute provide additional personalization.

**Weaknesses:**
- Theme application is split between `useTheme.ts` (which sets CSS variables and data attributes) and `globals.css` (which defines theme variables). There is no single source of truth -- the hook contains hardcoded color maps that should ideally be generated from or reference the CSS definitions.
- The `ThemeSelector.tsx` component (`client/src/components/customization/ThemeSelector.tsx:68`) directly mutates `document.documentElement` attributes instead of going through the `useTheme` hook or `uiStore`, creating a bypass path.
- Light theme preview colors in `ThemeSelector.tsx` (line 33) do not match the actual CSS variable values in `globals.css`, giving users an inaccurate preview.

### 2.3 Component Quality

**Layout Components** (all in `client/src/components/layout/`)

- **Sidebar.tsx** (623 lines): Guild dock with folder organization, multi-server grouping, unread/mention badges, context menus. Well-structured but complex -- the single component handles folders, drag-and-drop, context menus, and icon rendering. Could benefit from decomposition.
- **ChannelSidebar.tsx** (1118 lines): The largest layout component. Handles three distinct modes (DM list, collapsed guild, full guild channel list) with inline channel creation, voice participant display, and user panel. This file would benefit from extraction of sub-components (DMList, GuildChannelList, UserPanel).
- **TopBar.tsx** (697 lines): Implements search, pins, inbox, and help as overlay panels within the same component. Each overlay uses `useFocusTrap` correctly. The component manages 5+ overlays' open/close states, making it a good candidate for extraction.
- **MemberList.tsx** (461 lines): Properly virtualized with `@tanstack/react-virtual`. Supports role-based grouping, compact mode, skeleton loading, and profile popups via portal.

**Message Components** (all in `client/src/components/message/`)

- **MessageList.tsx** (549+ lines): Well-implemented virtualization with proper scroll-to-bottom behavior, infinite scroll for older messages, date separators, reply threading with depth limits (6 levels, 18px indent per level), and read state tracking.
- **MessageInput.tsx** (751 lines): Feature-rich with file upload (drag/drop/paste), emoji picker, GIF picker, poll composer, @mention autocomplete, markdown toolbar, and draft persistence. Auto-resizing textarea capped at 50vh.
- **MessageComponents.tsx** (915 lines): Comprehensive bot interaction component system supporting buttons (5 styles), string select menus, user/role/mentionable/channel entity select menus, and action rows. Each select type loads its entity list lazily on open.

**Guild Management Components** (all in `client/src/components/guild/`)

- **GuildSettings.tsx** (800+ lines): The most complex component. Manages 14 settings sections (overview, server-hub, bot-store, roles, members, channels, invites, emojis, webhooks, bots, events, bans, audit-log, file-storage) with 40+ state variables. This component is doing too much work and should be decomposed into per-section sub-components.
- **ChannelManager.tsx** (885 lines): Implements drag-and-drop channel reordering via `@dnd-kit/core` with category grouping, inline channel creation, voice settings (bitrate/user limit), NSFW toggle, slowmode, and per-channel permission editing.
- **CreateGuildModal.tsx** (449 lines): Three-tab modal (Create/Join/Template) with focus trap, icon upload, invite code parsing, and template preview. Good use of portal rendering and aria attributes.
- **BotStoreSection.tsx** (315 lines): Clean card-based UI for native bot management with install/configure/uninstall flow. Good visual design with color-mix backgrounds and feature lists.

**Voice Components** (all in `client/src/components/voice/`)

- **VoiceControlBar.tsx** (284 lines): Floating control bar with mute/deafen/screen share/disconnect. Screen share quality selector supports 720p30 to 4K at 100Mbps. Push-to-talk visual indicator included.
- **MiniVoiceBar.tsx** (111 lines): Compact voice status bar for mobile or when viewing a different channel. Clean, focused component with proper ARIA labels.

**Specialized Components**

- **ForumView.tsx** (751 lines): Full forum channel implementation with grid/list layout toggle, tag filtering, search with full-text search, post creation modal, tag manager, archived post toggle, and sort by latest activity or newest. Well-organized with clear separation between the view and its sub-modals (NewPostModal, TagManagerModal).
- **ThemeSelector.tsx** (158 lines): Visual theme picker with mini-preview layouts showing sidebar/chat/bg colors, and accent color dot selector. Compact and visually effective.
- **OnboardingWizard.tsx** (165 lines): Two-step introduction wizard explaining Paracord's value proposition (self-hosted, E2EE, multi-server) and how to connect to a server. Includes step indicator dots, skip option, and localStorage persistence of completion state.

### 2.4 Layout & Navigation Architecture

The application uses a workspace-stage-panel architecture defined in `globals.css`:

```
workspace-canvas
  workspace-stage
    dock-stage (guild sidebar - 4.5rem, collapsible)
      stage-grid
        nav-panel (channel sidebar - 16.25rem, collapsible)
        content-panel (messages/forum/voice - flex-1)
        member-panel (member list - 15rem, toggleable)
```

**Strengths:**
- Panel-based layout with smooth collapse/expand animations (300ms ease transitions on `nav-panel`).
- Dock sidebar collapses to zero-width with hover-to-expand behavior, controlled by `dockPinned` state in `uiStore.ts`.
- Member panel toggleable via `memberPanelOpen` state, persisted across sessions.
- Settings panels (User, Guild) render as full-page overlays with `AnimatePresence` from Framer Motion.

**Weaknesses:**
- The `AppLayout.tsx` (216 lines) passes no props to child pages via outlet context, relying entirely on Zustand stores for inter-component communication. While this works, it makes the data flow implicit.
- Mobile layout (detected via `window.matchMedia('(max-width: 768px)')`) replaces panel animations with full-screen views but does not implement a proper navigation stack. Pressing "back" in settings on mobile uses the browser history rather than an in-app back stack.

### 2.5 Accessibility

**Implemented:**
- Skip-to-content link (`AppLayout.tsx:92-97`) allows keyboard users to bypass navigation.
- `prefers-reduced-motion` support (`globals.css:1726-1746`) disables all animations and transitions.
- Touch target minimum sizing (`globals.css:1589-1625`) ensures 44px minimum height for interactive elements on coarse pointer devices (WCAG 2.5.5).
- ARIA roles and labels on modals: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on CreateGuildModal, search overlay, pins overlay, inbox overlay, help overlay in TopBar.
- `useFocusTrap` hook applied to all overlays and modals (TopBar search, CreateGuildModal).
- Focus-visible outlines: `outline: 2px solid var(--accent-primary)` with `outline-offset: 2px` on all interactive elements.
- Keyboard shortcut handler (`useKeyboardNavigation.ts`) respects `input`/`textarea`/`contenteditable` focus to avoid conflicts.

**Missing or Incomplete:**
- No `aria-live` regions for real-time updates. New messages, typing indicators, connection status changes, and toast notifications are not announced to screen readers.
- The `MessageList.tsx` virtual list does not have `role="feed"` or `role="log"` attributes. Screen readers cannot identify it as a message stream.
- `ChannelSidebar.tsx` channel list does not use `role="tree"` / `role="treeitem"` for the hierarchical category > channel structure.
- Color contrast in the default dark theme is not verified against WCAG AA (4.5:1 for normal text, 3:1 for large text). The `--text-muted` color on dark backgrounds may fall below AA ratio.
- Forum tag buttons (`ForumView.tsx:227-249`) rely solely on color to indicate selection state, which fails WCAG 1.4.1 (Use of Color). An icon or border change should supplement the color change.
- No visible focus indicator on guild icons in the dock sidebar (`Sidebar.tsx`). The `guild-icon` class does not include `:focus-visible` styling.
- Context menus (right-click) are not keyboard-navigable. They open on `onContextMenu` but lack arrow-key navigation and Escape-to-close within the menu itself.

### 2.6 Design System Gaps

1. **No component library documentation.** Reusable CSS classes like `btn-primary`, `input-field`, `card-surface`, etc. exist but are not documented. New contributors must read `globals.css` to discover available primitives.

2. **Inconsistent button patterns.** Some components use the CSS class `btn-primary` (defined in `globals.css`), while others use the `<Button>` React component from `client/src/components/ui/Button.tsx` (used in `BotStoreSection.tsx:217-224`). Both exist in the codebase with overlapping purposes.

3. **Error display inconsistency.** Error messages use at least three different patterns:
   - Inline `<div>` with danger border styling (ServerConnectPage, LoginPage, GuildSettings)
   - Toast notifications via `toast.error()` (ForumView)
   - Inline `<p>` with status text (UserSettings)

4. **Loading state inconsistency.** Loading indicators use:
   - Spinning border circle (ForumView, GuildPage)
   - "Loading..." text (CreateGuildModal templates)
   - Skeleton pulse animation (MemberList)
   - Button text change ("Connecting...", "Working...", "Creating...")
   No standard loading component or pattern is established.

5. **Modal backdrop inconsistency.** Some modals use `modal-overlay` CSS class (CreateGuildModal), some use inline `style={{ backgroundColor: 'var(--overlay-backdrop)' }}` with a separate backdrop div (ForumView TagManagerModal, NewPostModal). The layering and z-index management should be standardized.

### 2.7 Specific UI Issues

| Issue | File | Line(s) | Severity |
|-------|------|---------|----------|
| GuildSettings has 40+ `useState` calls creating cognitive and maintenance burden | `GuildSettings.tsx` | 74-125 | Medium |
| ChannelSidebar at 1118 lines handles 3 distinct view modes in one component | `ChannelSidebar.tsx` | 1-1118 | Medium |
| Forum post card shows truncated owner_id instead of username | `ForumView.tsx` | 420 | Low |
| MessageComponents uses hardcoded Tailwind color classes (`bg-blue-600`, `bg-gray-600`) instead of design system tokens | `MessageComponents.tsx` | 41-51 | Medium |
| ThemeSelector accent colors diverge from useTheme accent presets | `ThemeSelector.tsx` vs `useTheme.ts` | 11-20 vs 14-91 | Medium |
| Welcome Bot config requires raw channel Snowflake ID instead of a channel picker | `BotStoreSection.tsx` | 181-186 | Low |
| DM page has a fixed-position members toggle button that can overlap content | `DMPage.tsx` | 178-185 | Low |

### 2.8 UI Design Improvement Recommendations

**High Priority:**
1. **Decompose GuildSettings** into per-section components (OverviewSection, RolesSection, MembersSection, etc.) to reduce the 40+ state variables and improve maintainability.
2. **Standardize error/loading/empty state patterns** across the application. Create shared components like `<ErrorBanner>`, `<LoadingSpinner>`, and `<EmptyState>` to replace the 3+ inconsistent patterns.
3. **Unify the button system** -- either adopt the `<Button>` component universally or remove it in favor of CSS classes. Having both causes confusion.
4. **Add `aria-live` regions** for message list, typing indicators, and toast notifications to support screen reader users.

**Medium Priority:**
5. **Extract ChannelSidebar sub-components** (DMList, GuildChannelList, VoiceParticipants, UserPanel) to reduce the 1118-line monolith.
6. **Fix MessageComponents to use design system tokens** instead of hardcoded Tailwind colors for button styles.
7. **Unify ThemeSelector and useTheme accent color definitions** into a single source of truth.
8. **Add `role="tree"`/`role="treeitem"` semantic structure** to the channel sidebar for screen reader navigation.
9. **Add `role="feed"` or `role="log"`** to the virtualized message list.

**Low Priority:**
10. **Split `globals.css`** into separate files: base tokens, theme definitions, component styles, animations, and utilities.
11. **Add a visible focus indicator to guild icons** in the dock sidebar.
12. **Replace raw Snowflake ID input** in bot configuration with a channel picker dropdown.
13. **Verify WCAG AA color contrast** for all text/background combinations across all four themes.

<!-- END SECTION: ui-design -->

---

<!-- SECTION: ux -->
## 3. User Experience Analysis

### 3.1 Onboarding Experience

**First-Time User Flow:**
1. User opens the app and lands on `ServerConnectPage.tsx`.
2. If no servers are saved and onboarding has not been completed, an `OnboardingWizard` is shown (2 steps: welcome + how to connect).
3. After wizard completion (or skip), user sees the Add Server form.
4. User enters a server URL, invite link, or portable link (`paracord://invite/...`).
5. The app probes `/health` to verify it is a Paracord server, warns about insecure HTTP on non-localhost servers, then connects with challenge-response authentication.
6. On success, user navigates to `/app` or an invite acceptance page.

**Strengths:**
- The onboarding wizard (`OnboardingWizard.tsx`) effectively explains Paracord's three key differentiators (self-hosted, E2EE, multi-server) with clear, icon-decorated cards.
- The "Skip introduction" option respects experienced users who do not need hand-holding.
- Server URL normalization (`normaliseServerUrl` in `ServerConnectPage.tsx:14-33`) is robust -- it handles bare IPs, ports, missing protocol, localhost detection, and same-host detection.
- Portable link parsing (`paracord://invite/...`) provides a clean single-link sharing mechanism for both server URL and invite code.
- The insecure HTTP warning dialog (non-localhost only) is a good security-conscious UX pattern.

**Weaknesses:**
- The wizard is only 2 steps and does not help users actually connect to a server. It explains concepts but leaves the user at the Add Server form with no server to connect to. A "Try a public demo server" button would reduce first-run friction.
- No account creation guidance. After connecting to a server, users must navigate to `/login` which shows login/register forms, but there is no obvious path from onboarding to account creation.
- The "Your Servers" list on `ServerConnectPage.tsx:253-301` shows connected/disconnected status but provides no "reconnect" action -- only "remove". A user with a temporarily disconnected server must remove and re-add it.
- Error messages from failed server probes are generic: "Could not connect. Check the URL and ensure the server is running." More specific error messages (DNS failure, timeout, wrong protocol, CORS issue) would help users troubleshoot.

### 3.2 Core User Flows

**Message Sending Flow:**
- Typing in `MessageInput.tsx` auto-resizes the textarea (up to 50vh).
- Draft content is saved to localStorage per channel with 300ms debounce (`MessageInput.tsx` draft persistence).
- @mention autocomplete triggers on `@` character with cursor-position-aware detection, showing a filtered member list.
- File attachments support drag-and-drop, paste, and file picker with image preview thumbnails.
- On submit, the message is sent and the input clears. Errors from the server are extracted and displayed inline below the input.
- Markdown shortcuts (bold, italic, code, etc.) are available via a toolbar button.

**Assessment:** This is one of the strongest UX flows in the application. The draft persistence, auto-resize, @mention autocomplete, and multi-attachment support create a polished messaging experience comparable to Discord. The poll composer (question + options + multiselect toggle + duration) adds significant value.

**Guild/Server Management Flow:**
- Guild settings open as a full-page overlay (`GuildSettings.tsx`) with a left navigation panel (14 sections).
- Each section loads data via `refreshAll()` which fetches 11 API endpoints in parallel using `Promise.allSettled` with graceful degradation for non-essential data.
- Role management supports creation, color/permission editing, and deletion with permission invalidation.
- Channel management uses drag-and-drop reordering, inline creation, and category grouping.
- Bot store provides one-click install/configure/uninstall for native bots.

**Assessment:** Functionally comprehensive but the monolithic `GuildSettings.tsx` with 40+ state variables creates a complex, hard-to-navigate experience. The 14-section navigation in a single component means all section data is re-fetched on any change, even for unrelated sections. Mobile users see a horizontal scrolling tab bar which works but is not ideal for 14 items.

**Voice Chat Flow:**
- User clicks a voice channel in `ChannelSidebar.tsx` to join.
- Voice participants appear inline under the channel name with speaking indicators, mute/deaf/video/stream status icons.
- `VoiceControlBar.tsx` appears as a floating bar at the bottom with mute/deafen/screen share/disconnect.
- Screen share includes a quality selector popup (720p30 to 4K 100Mbps).
- `MiniVoiceBar.tsx` shows when viewing a different page while connected to voice, with quick controls and a link back to the voice channel.
- Push-to-talk mode is supported with visual indicator (pulsing radio icon).
- Voice keybinds are configurable in User Settings (default: Ctrl+Shift+M for mute, Ctrl+Shift+D for deafen).

**Assessment:** The voice flow is well-designed with clear visual states and appropriate controls. The mini voice bar for mobile/cross-page viewing is a thoughtful touch. Push-to-talk support with visual feedback is good for gaming use cases.

**Forum Channel Flow:**
- Forum view (`ForumView.tsx`) shows posts in grid or list layout with tag filters, sort options, and search.
- Creating a new post opens a modal with title, content, and tag selection.
- Tag management has its own modal for create/delete operations.
- Posts navigate to thread views on click.

**Assessment:** Solid implementation. The grid/list toggle, tag filtering, and full-text search provide flexibility. The "include archived" checkbox is a nice detail. One UX issue: forum post cards show truncated `owner_id` instead of the author's username (`ForumView.tsx:420`).

### 3.3 Error Handling & User Feedback

**Connection Status:**
- `ConnectionStatusBar.tsx` shows a fixed top banner for "reconnecting" and "disconnected" states.
- A 4-second grace period prevents the banner from flashing during transient reconnects.
- The banner is suppressed when voice is connected (proves network is up) or when an API health check succeeds.
- Connection latency is shown in `TopBar.tsx` with a color-coded WiFi icon (green < 150ms, yellow < 300ms, red >= 300ms).

**Assessment:** The connection status system is well-designed with appropriate grace periods and smart suppression logic. The latency indicator provides ongoing confidence in connection quality.

**Error Patterns Analysis:**

| Context | Error Display | File | Quality |
|---------|--------------|------|---------|
| Server connect | Inline banner with danger border | `ServerConnectPage.tsx:207-210` | Good -- prominent and descriptive |
| Login | Inline banner with danger border | `LoginPage.tsx` | Good -- includes rate limit feedback |
| Guild settings | Top-of-panel error with generic extraction | `GuildSettings.tsx:135-138` | Adequate -- uses `getApiErrorMessage()` helper |
| Forum operations | Toast notifications | `ForumView.tsx:52,114` | Adequate -- non-blocking but easy to miss |
| User settings | Status text below actions | `UserSettings.tsx:284-295` | Weak -- status text is not visually distinct from success messages |
| Message send | Inline error below input | `MessageInput.tsx` | Good -- positioned close to the action |
| Voice/stream | Error display in VoiceControlBar | `VoiceControlBar.tsx` | Good -- detailed stream error messages |

**Identified Issues:**
- No unified error boundary at the application level. If a component throws during render, the entire app crashes to a white screen with no recovery path.
- The `UserSettings.tsx` component uses the same `statusText` state for both success ("Profile updated.") and error ("Failed to update profile.") messages, with no visual differentiation.
- Toast notifications in `ForumView.tsx` are the only toast-based errors in the app. The toast system exists but is inconsistently applied.
- When `refreshAll()` in `GuildSettings.tsx` fails for the essential guild info fetch, the error is shown but the panel remains open with stale/empty data. A retry button would be helpful.

### 3.4 Navigation & Information Architecture

**Primary Navigation:**
- **Dock sidebar** (`Sidebar.tsx`): Guild icons with unread badges, organized by folders and multi-server groups. Context menu with mark-as-read, mute, invite, folder management.
- **Channel sidebar** (`ChannelSidebar.tsx`): Category-grouped channels with collapsible categories (state persisted in localStorage). Inline voice participant display.
- **Top bar** (`TopBar.tsx`): Channel name/topic, search, pins, members toggle, inbox (unread across guilds), help/shortcuts.

**Keyboard Navigation** (`useKeyboardNavigation.ts`):
- `Alt+Up/Down`: Navigate between channels.
- `Ctrl+B`: Toggle dock sidebar.
- `Escape`: Close overlays, command palette, search panel.
- Configurable voice keybinds (mute, deafen, push-to-talk) with customization in User Settings.
- Tauri-specific: blocks browser shortcuts (Ctrl+F, Ctrl+P, Ctrl+R, F12, Ctrl+Shift+I/J, zoom) to prevent UI conflicts.

**Assessment:**
- Channel navigation is well-organized with the standard Discord-like hierarchy (dock > channels > content).
- The keyboard navigation system is functional but limited. There is no keyboard shortcut for switching between guilds, opening user/guild settings, or navigating to DMs.
- The command palette (`commandPaletteOpen` in `uiStore.ts`) is referenced but its implementation is not visible in the reviewed components, suggesting it may be incomplete or minimal.
- The inbox overlay in TopBar (`TopBar.tsx`) shows unread channels across all guilds with mention counts, which is a valuable cross-guild aggregation feature.

### 3.5 Real-Time Experience

**WebSocket/SSE Gateway** (`connectionManager.ts`, 1013 lines):
- Dual transport support: SSE (v2 realtime) and WebSocket with zlib compression.
- Auto-reconnection with exponential backoff: immediate first retry, then 1-30 second range.
- Heartbeat with latency tracking: 3 missed ACKs trigger reconnection.
- Offline/online detection: listens for browser `online`/`offline` events and reconnects on recovery.
- Visibility change handling: reconnects when tab regains focus if heartbeat was missed.
- Challenge-response Ed25519 authentication for multi-server connections.
- Duplicate SSE connection prevention for same-URL servers.

**Presence System** (`useActivityPresence.ts`, 231 lines):
- Idle detection: 5-minute timeout, checked every 30 seconds, resets on mousemove/keydown/mousedown/touchstart.
- Tauri foreground app detection: polls every 5 seconds, builds Activity with detected app name and window title.
- Respects user DND/invisible status and per-app disable list.
- Publishes presence updates to all connected servers.

**Assessment:** The real-time infrastructure is robust. The reconnection strategy with exponential backoff, offline detection, visibility-change handling, and heartbeat monitoring covers the standard failure modes well. The 4-second grace period on the connection status banner prevents UI flicker during normal transient disconnections. The activity presence system with idle detection and app detection (Tauri-specific) adds polish comparable to Discord.

### 3.6 Mobile & Responsive Experience

**Breakpoints:**
- Primary mobile breakpoint: 768px (`window.matchMedia('(max-width: 768px)')`)
- Small mobile: 640px (`max-sm:` Tailwind prefix)
- Touch target sizing at `(pointer: coarse)` via CSS media query (`globals.css:1589-1625`)

**Mobile Adaptations:**
- `AppLayout.tsx`: Swipe gestures for sidebar (`useSwipeGesture`) and member panel. Dock and channel sidebar become overlay panels instead of persistent sidebars.
- `MiniVoiceBar.tsx`: Shows on mobile when connected to voice but viewing a different page.
- `GuildSettings.tsx:126-129`: Mobile detection with horizontal scrolling tab bar replacing the vertical sidebar navigation.
- `UserSettings.tsx:101-104`: Same mobile detection pattern with horizontal tab navigation.
- `TopBar.tsx`: Sidebar toggle button for collapsing/expanding the navigation panel.
- `MessageList.tsx:250-253`: Coarse pointer detection adjusts interaction patterns (e.g., tap instead of hover for message actions).

**Assessment:**
- The responsive implementation covers the critical use cases (sidebar overlay, swipe gestures, touch targets).
- However, the mobile experience is a "responsive adaptation" rather than a "mobile-first" design. Components detect mobile breakpoints independently via `window.matchMedia` rather than using a shared responsive context, leading to potential inconsistencies if breakpoint values diverge.
- The swipe gesture for sidebar toggle is a good mobile pattern, but there is no haptic feedback or visual affordance (e.g., a swipe indicator edge) to discover it.
- `GuildSettings` and `UserSettings` on mobile use a horizontal scrolling tab bar, which is functional but sub-optimal for 14 (GuildSettings) and 9 (UserSettings) items. A collapsible dropdown or bottom sheet would be more mobile-friendly.

### 3.7 UX Anti-Patterns

| Anti-Pattern | Location | Impact | Recommendation |
|-------------|----------|--------|----------------|
| **Monolithic settings page** | `GuildSettings.tsx` (14 sections, 40+ state vars) | All data fetched on open regardless of which section user wants. Navigation is overwhelming. | Split into routed sub-pages or lazy-loaded sections. |
| **Destructive actions without undo** | Channel/role/webhook/emoji deletion in GuildSettings. `handleDeleteChannel` in `ChannelManager.tsx:279-287` immediately deletes. | No undo or soft-delete mechanism for accidental deletions. | Add confirmation dialogs for all destructive actions (some have them, others do not). Add an undo toast for recent deletions. |
| **Silent failures** | Multiple `catch {}` blocks with no user feedback: `useActivityPresence.ts` presence publishing, `MessageList.tsx:282-284` role color fetch, thread hydration (`MessageList.tsx:468-469`). | Users have no visibility into background failures. | Log silently but consider a diagnostics panel for debugging connection/sync issues. |
| **State in localStorage without versioning** | Draft messages, category collapse state, onboarding completion, theme preferences in localStorage. | No migration path if key format changes. Could cause stale state bugs after updates. | Add version prefix to localStorage keys; implement a migration helper. |
| **Inconsistent mobile detection** | Each component independently calls `window.matchMedia('(max-width: 768px)')` (`GuildSettings.tsx:126`, `UserSettings.tsx:101`, `AppLayout.tsx`). | Breakpoint could diverge if one component changes its threshold. | Centralize mobile detection into a shared hook or store value. |
| **Eager data fetching in settings** | `GuildSettings.refreshAll()` fetches 11 API endpoints on open. | Slow initial render on large guilds. Wastes bandwidth for sections user never visits. | Fetch data per-section on navigation, not all at once. |
| **No empty state for new guilds** | A newly created guild with no channels shows the guild page but `GuildPage.tsx` has no welcome/setup guidance. | New server owners see a blank page and must discover settings independently. | Show a welcome screen with "Create your first channel" CTA for empty guilds. |

### 3.8 User Settings UX

The `UserSettings.tsx` component (400+ lines visible) provides 9 sections: Account, Appearance, Voice & Video, Notifications, Activity Privacy, Keybinds, Identity, Server (admin), and About.

**Account Section:**
- Profile editing (display name, bio).
- Password change with current password verification.
- Email change with current password verification.
- Session management with list and revoke capabilities.
- MFA/TOTP setup with QR code, verification, and backup codes.
- Account data export.

**Appearance Section:**
- Theme selection (dark/light/amoled/high-contrast).
- Accent color preset selection (10 options).
- Compact mode toggle.
- Custom CSS injection.

**Voice & Video Section:**
- Audio input/output device selection from enumerated devices.
- Device list refreshes on section visit with permission request.

**Assessment:** The settings experience is comprehensive. The MFA setup flow with QR code display and backup code generation is well-implemented. The keybind customization with capture mode (`capturingKeybind` state) is a nice touch. However, the settings overlay closes on Escape (`handleKeyDown` at line 215) which could accidentally close settings during keybind capture if not properly guarded.

### 3.9 UX Improvement Recommendations

**High Priority:**
1. **Add an application-level error boundary** with a recovery mechanism (reload button, "return to app" link) instead of crashing to a white screen.
2. **Implement per-section lazy loading in GuildSettings** -- only fetch API data when the user navigates to that section, not all 11 endpoints on open.
3. **Add confirmation dialogs to all destructive actions** -- channel deletion, emoji deletion, and webhook deletion in the channel manager currently execute immediately without confirmation.
4. **Centralize mobile detection** into a shared `useMobile()` hook or `uiStore` value to prevent breakpoint divergence across components.
5. **Differentiate success and error status messages** in UserSettings with distinct visual styles (green for success, red for error) instead of using the same `statusText` state for both.

**Medium Priority:**
6. **Add a "reconnect" action to the server list** on ServerConnectPage instead of requiring remove-and-re-add for disconnected servers.
7. **Show a setup wizard for newly created guilds** with "Create your first channel" guidance instead of a blank page.
8. **Add an undo mechanism for recent deletions** (channels, roles, emojis) using a timed undo toast pattern.
9. **Add version prefixes to localStorage keys** with a migration helper to prevent stale state bugs after updates.
10. **Implement more specific error messages for server connection failures** -- distinguish DNS failure, timeout, wrong protocol, and CORS errors in `ServerConnectPage.tsx`.

**Low Priority:**
11. **Add a "Try a public demo server" option** to the onboarding wizard to reduce first-run friction for users without their own server.
12. **Replace horizontal scrolling tab bars** in mobile settings views with a dropdown selector or bottom sheet for better mobile ergonomics.
13. **Add swipe discovery affordance** -- a subtle edge indicator or tooltip on first use to help users discover the swipe-to-open-sidebar gesture on mobile.
14. **Add a diagnostics/debug panel** accessible from user settings to help users troubleshoot connection, sync, and presence issues.
15. **Implement a proper command palette** if one does not already exist -- the `commandPaletteOpen` state in `uiStore.ts` suggests intent but the implementation appears minimal.

<!-- END SECTION: ux -->

---

<!-- SECTION: feature-completeness -->
## 4. Feature Completeness Audit

### 4.1 Feature Inventory

The table below catalogs every feature present in the codebase with its implementation status across server, client, and database layers.

**Status Key:** **Complete** = Full server API + database schema + client UI + gateway events | **Partial** = Core flow works but missing edge cases, UI, or secondary features | **Backend Only** = Server endpoint exists but no client UI | **Missing UI** = Server endpoint exists with no corresponding client interface

#### Core Messaging

| Feature | Status | Details |
|---------|--------|---------|
| Text channels (CRUD) | **Complete** | routes/channels.rs + ChannelSidebar + ChannelManager |
| Send/receive messages | **Complete** | MessageInput, MessageList, gateway dispatch |
| Edit messages | **Complete** | MessageList context menu + message_edit_history |
| Delete messages | **Complete** | MessageList context menu, bulk delete API |
| Bulk delete messages | **Complete** | channelApi.bulkDeleteMessages (up to 500) |
| Message edit history | **Partial** | API + client wrapper exist but no UI to view edit history in MessageList |
| Message search | **Complete** | SearchPanel.tsx, channels.rs::search_messages |
| Pinned messages | **Complete** | TopBar pins button, pin/unpin API |
| Reactions | **Complete** | Reaction UI + add/remove reaction API |
| Typing indicators | **Complete** | MessageInput trigger, realtime event bus |
| Read states / unread tracking | **Complete** | channelStore unread badges, read_states table |
| Message embeds (OpenGraph) | **Partial** | opengraph.rs + MessageEmbed.tsx; link preview fetching may not trigger for all URLs |
| Message nonce dedup | **Complete** | messages.nonce column prevents duplicates |
| Markdown rendering | **Complete** | lib/markdown.ts with full GFM support |
| Code blocks with syntax highlighting | **Complete** | CodeBlock.tsx |
| File attachments | **Complete** | FileUpload.tsx + FilePreview.tsx + files.rs (64MB limit) |
| Image lightbox | **Complete** | ImageLightbox.tsx |

#### Threads and Forums

| Feature | Status | Details |
|---------|--------|---------|
| Thread creation | **Complete** | ThreadPanel.tsx, channels type=6 |
| Thread listing (active/archived) | **Complete** | get_threads, get_archived_threads |
| Thread archive/lock | **Complete** | thread_metadata JSON column |
| Forum channels | **Complete** | ForumView.tsx, channels type=7, forum_tags |
| Forum tags | **Complete** | Tag CRUD + filtering in ForumView |
| Forum sort order | **Complete** | channels.default_sort_order |
| Forum full-text search | **Partial** | SQLite FTS5 works; Postgres FTS not implemented |

#### Voice and Video

| Feature | Status | Details |
|---------|--------|---------|
| Voice channels | **Complete** | voice.rs + VoiceChannel.tsx + VoiceControls.tsx |
| Voice state (mute/deaf/video) | **Complete** | VoiceControlBar + MiniVoiceBar + voice_states table |
| Screen sharing | **Complete** | start_stream/stop_stream + StreamViewer.tsx + SplitPane.tsx |
| LiveKit integration | **Complete** | livekit_proxy.rs + useVoice.ts |
| Native QUIC media transport | **Partial** | Server relay (paracord-transport/relay) built; client Tauri path exists; VP9 requires build env |
| DM voice calls | **Complete** | dms.rs join/leave + DMPage voice button |
| Stage channels | **Partial** | Full API in stage.rs; client renders in sidebar but no dedicated Stage UI (speaker queue, audience view, request-to-speak) |
| VP9 video codec | **Complete** | paracord-codec vpx feature (when configured) |
| Video grid / focused webcam | **Complete** | VideoGrid.tsx + FocusedWebcamView.tsx |
| Voice keybinds (PTT) | **Complete** | useVoiceKeybinds.ts |

#### Guild Management

| Feature | Status | Details |
|---------|--------|---------|
| Guild CRUD | **Complete** | guilds.rs + CreateGuildModal + GuildSettings |
| Guild ownership transfer | **Complete** | transfer_ownership API + GuildSettings |
| Channel categories | **Complete** | type=4, ChannelSidebar collapsing |
| Channel position reordering | **Complete** | update_channel_positions + ChannelManager drag-drop |
| Channel permission overwrites | **Complete** | ChannelPermissionsEditor.tsx + channel_overwrites table |
| Roles (CRUD + permissions) | **Complete** | roles.rs + GuildSettings roles tab |
| Member management (kick) | **Complete** | MemberList context menu |
| Ban management | **Complete** | bans.rs + GuildSettings bans tab |
| Invites | **Complete** | InviteModal.tsx + InvitePage.tsx |
| Vanity URLs | **Complete** | GuildSettings vanity section |
| Audit logs | **Complete** | audit_logs.rs + GuildSettings audit tab |
| Guild discovery | **Complete** | DiscoveryPage.tsx + discovery.rs |
| Guild templates | **Partial** | Full CRUD API; CreateGuildModal uses templates but no dedicated template browsing/management page |
| Server hub / welcome screen | **Complete** | GuildHub.tsx + ServerHubSettings.tsx + GuildWelcomeScreen.tsx |
| Guild storage management | **Complete** | FileStorageSection.tsx + guild_storage_policies |
| Scheduled events | **Complete** | EventList.tsx + events.rs + RSVP |
| Channel follows (announcements) | **Partial** | API + client wrappers exist but no visible UI for managing follows |

#### Authentication and Users

| Feature | Status | Details |
|---------|--------|---------|
| Registration | **Complete** | RegisterPage.tsx + auth.rs |
| Login (email + username) | **Complete** | LoginPage.tsx + flexible identifier login |
| JWT access + refresh tokens | **Complete** | authToken.ts + client.ts interceptor + sessions table |
| Session management | **Complete** | UserSettings sessions section |
| Password change | **Complete** | UserSettings password section |
| Email change | **Complete** | UserSettings email section |
| Forgot/reset password | **Partial** | API + AccountRecoverPage exist; no email delivery integration |
| Email verification | **Partial** | API exists; no SMTP configured |
| MFA (TOTP) | **Complete** | Full flow: QR code, backup codes, login with MFA |
| Crypto auth (challenge-response) | **Complete** | LoginPage challenge flow + public key auth |
| User profiles | **Complete** | UserProfile.tsx + UserSettings.tsx |
| User settings | **Complete** | Full settings with theme, locale, keybinds, notifications |
| Custom CSS | **Complete** | CustomCSS.tsx with sanitization |
| Data export (GDPR) | **Complete** | users.rs::export_my_data |
| Account deletion | **Complete** | users.rs::delete_me |
| Identity export/import | **Complete** | Export/import user identity across servers |

#### Social Features

| Feature | Status | Details |
|---------|--------|---------|
| Friend requests | **Complete** | FriendsPage.tsx + relationships.rs |
| Block user | **Complete** | FriendsPage block action |
| DM channels (1-on-1) | **Complete** | DMPage.tsx + dms.rs |
| Group DMs | **Complete** | Up to 10 members, add/remove recipients |
| DM E2E encryption | **Complete** | dmE2ee.ts + Signal prekeys |
| Presence | **Complete** | presenceStore.ts + MemberList status dots |
| Custom status | **Complete** | UserSettings + MemberList tooltip |
| Activity presence | **Complete** | useActivityPresence.ts |

#### Bot Ecosystem

| Feature | Status | Details |
|---------|--------|---------|
| Bot application CRUD | **Complete** | DeveloperPage.tsx + bots.rs |
| Bot token management | **Complete** | Token regeneration with HMAC hashing |
| Bot installation (OAuth2) | **Complete** | BotAuthorizePage.tsx + oauth2_authorize |
| Bot store (discovery) | **Complete** | BotStoreSection.tsx + store_search/featured/categories |
| Slash commands (registration) | **Complete** | CommandBuilder.tsx + commands.rs (global + guild scope) |
| Slash command invocation | **Complete** | SlashCommandPopup.tsx + interactions.rs |
| Interaction callbacks | **Complete** | EphemeralMessage.tsx + interaction_callback |
| Message components (buttons/selects) | **Complete** | MessageComponents.tsx + type=3 interactions |
| Followup messages | **Complete** | create_followup_message API |
| Bot presence updates | **Complete** | bots.rs::update_bot_presence |

#### Webhooks and Emojis

| Feature | Status | Details |
|---------|--------|---------|
| Webhook CRUD | **Complete** | GuildSettings + webhooks.rs |
| Webhook execution | **Complete** | Token-based execution, no auth required |
| GitHub webhook formatting | **Complete** | Formats push/PR/issue/comment/star events |
| Emoji CRUD | **Complete** | GuildSettings emojis section (PNG/GIF, 256KB limit) |
| Emoji picker | **Complete** | EmojiPicker.tsx with custom emoji support |

#### Federation

| Feature | Status | Details |
|---------|--------|---------|
| Server discovery (.well-known) | **Complete** | /.well-known/paracord/server |
| Ed25519 signed envelopes | **Complete** | paracord-federation crate |
| Event ingestion/forwarding | **Complete** | Content validation (1MB limit, 32 depth, 10K collection) |
| Space/channel mapping | **Complete** | federation_space_mappings + federation_channel_mappings |
| Federated file proxy | **Complete** | SSRF-protected file download |
| Media token relay | **Complete** | Cross-server voice via LiveKit tokens |
| Trusted server management | **Backend Only** | No admin UI for managing federated servers |
| Federation invite/join/leave | **Backend Only** | No client-facing UI |

#### Tenor GIF Integration

| Feature | Status | Details |
|---------|--------|---------|
| GIF search proxy | **Complete** | GifPicker.tsx + tenor.rs |
| GIF trending | **Complete** | GifPicker.tsx trending tab |

#### Admin and Infrastructure

| Feature | Status | Details |
|---------|--------|---------|
| Admin dashboard | **Complete** | AdminPage.tsx with stats/users/guilds/settings |
| Security events log | **Complete** | AdminPage security tab |
| Database backup/restore | **Complete** | Full CRUD backup management |
| Rate limiting | **Complete** | Per-route middleware + auth guard |
| Metrics/health endpoints | **Complete** | /metrics + /health |

#### Client UI Features

| Feature | Status | Details |
|---------|--------|---------|
| Theme selector (4 themes) | **Complete** | ThemeSelector.tsx + useTheme.ts |
| Command palette (Ctrl+K) | **Complete** | CommandPalette.tsx |
| Keyboard navigation | **Complete** | useKeyboardNavigation.ts |
| Mobile bottom nav | **Complete** | MobileBottomNav.tsx |
| Onboarding wizard | **Complete** | OnboardingWizard.tsx |
| Multi-server support | **Complete** | serverListStore.ts + ServerConnectPage.tsx |
| Guild folder organization | **Complete** | folderStore.ts |
| Markdown toolbar | **Complete** | MarkdownToolbar.tsx |
| Context menus | **Complete** | ContextMenu.tsx |
| Toast notifications | **Complete** | toastStore.ts |
| Connection status bar | **Complete** | ConnectionStatusBar.tsx |
| Error boundary | **Complete** | ErrorBoundary.tsx |

### 4.2 Partially Implemented Features -- Detailed Breakdown

**1. Stage Channels**
- Server: Full CRUD API in `routes/stage.rs` -- create, update, delete stage instances; invite/remove speakers. channel_type=13 supported throughout.
- Database: `stage_instances` table with channel_id, guild_id, topic, privacy_level.
- Client gap: No dedicated StageView component. ChannelSidebar renders Stage channels but joining shows a standard voice channel view. Missing: audience/speaker separation UI, request-to-speak button, speaker queue display, stage topic banner.
- Effort to complete: **M** (Medium)

**2. Password Reset and Email Verification**
- Server: `auth.rs::forgot_password` generates a reset token stored in `password_reset_tokens` table. `auth.rs::verify_email` handles verification tokens.
- Client: `AccountRecoverPage.tsx` exists with token input flow.
- Gap: No SMTP/email delivery integration. Tokens are stored in DB but never emailed to users. The `forgot_password` endpoint returns success but the token is only accessible via direct DB query or server logs.
- Effort to complete: **S** (Small) -- Add SMTP client (e.g. lettre crate) or transactional email service.

**3. Guild Templates UI**
- Server: Full API in `routes/templates.rs` -- create template from guild, list all, apply, delete.
- Client: `CreateGuildModal` fetches templates during guild creation.
- Gap: No dedicated template management page. Users cannot browse templates, view details, or manage their own templates outside guild creation.
- Effort to complete: **S** (Small)

**4. Channel Follows (Announcement Channels)**
- Server: Full API -- add_channel_follow, remove_channel_follow, list_channel_follows.
- Client: `channelApi` wrappers exist for all three endpoints.
- Gap: No UI component in channel settings to configure follows.
- Effort to complete: **S** (Small)

**5. Message Edit History Viewer**
- Server: `channels.rs::get_edit_history` returns edit history from `message_edit_history` table.
- Client: `channelApi.getEditHistory` wrapper exists.
- Gap: No UI element to view history. MessageList shows "edited" label but no click-to-view.
- Effort to complete: **S** (Small)

**6. Federation Admin UI**
- Server: Full trusted-server management API (add, delete, list servers).
- Gap: No admin panel for managing federated servers. Admins must use REST API directly.
- Effort to complete: **M** (Medium)

**7. Forum Full-Text Search (PostgreSQL)**
- SQLite FTS5 migration exists and works. No PostgreSQL tsvector/tsquery equivalent.
- Effort to complete: **S** (Small)

### 4.3 API-UI Gap Analysis

#### Server Endpoints Without Client UI

| Endpoint | Route File | Gap |
|----------|-----------|-----|
| `POST /api/v1/stage-instances` | stage.rs | No Stage management UI |
| `POST /stage-instances/{id}/speakers/{user_id}` | stage.rs | No speaker invite UI |
| `DELETE /stage-instances/{id}/speakers/{user_id}` | stage.rs | No speaker removal UI |
| `POST /channels/{id}/followers` | channels.rs | No follow management UI |
| `GET /channels/{id}/followers` | channels.rs | No follow list display |
| `DELETE /channels/{id}/followers/{target}` | channels.rs | No unfollow button |
| `GET /channels/{id}/messages/{msg_id}/edits` | channels.rs | No edit history viewer |
| `/_paracord/federation/v1/servers` (CRUD) | federation.rs | No admin federation panel |
| `GET /api/v1/templates` | templates.rs | No template browsing page |
| `DELETE /api/v1/templates/{id}` | templates.rs | No template deletion UI |

#### Client Wrappers Without Visible UI Trigger

- `channelApi.getFollowers` / `addFollower` / `removeFollower` -- wired but not exposed in any settings panel
- `channelApi.getEditHistory` -- wired but not shown in message context menu

#### Types Defined But Not Fully Utilized

| Type | Location | Usage Gap |
|------|----------|-----------|
| `ChannelType.Stage = 13` | types/index.ts | Sidebar renders it; no dedicated Stage view |
| `ChannelType.Announcement = 5` | types/index.ts | Rendered as text channel; no follow/crosspost UI |

### 4.4 TODO/FIXME/Stub Audit

The codebase is remarkably clean of TODO/FIXME markers. Full search results:

**Server (crates/):**
- `paracord-codec/src/video/decoder.rs`: `NullDecoder` described as a "zero-dependency stub" -- intentional fallback when VP9 is not compiled.
- `paracord-codec/src/video/encoder.rs`: `NullEncoder` -- same intentional design.
- No `todo!()`, `unimplemented!()`, `FIXME`, or `HACK` markers found anywhere in the server codebase.

**Client (client/src/):**
- Only `vi.stubEnv` references in test files (test utilities, not incomplete code).
- No `TODO`, `FIXME`, or `HACK` comments found in any client source files.

**Verdict:** Zero outstanding TODO/FIXME items. All stub patterns are intentional codec fallbacks.

### 4.5 Database Schema vs Implementation Gaps

| Migration / Table | DB Module | API Routes | Gap |
|-------------------|-----------|------------|-----|
| `password_reset_tokens` | password_reset.rs | auth.rs forgot/reset | No email delivery mechanism |
| `mfa_totp` | mfa.rs | auth.rs mfa/* | **Fully implemented** |
| `message_edit_history` | messages.rs | channels.rs get_edit_history | No client UI to view |
| `channel_follows` | channel_follows.rs | channels.rs follow endpoints | No client UI |
| `email_verification` | users.rs email_verified | auth.rs verify_email | No email delivery |
| `guild_templates` | guild_templates.rs | templates.rs full CRUD | Partial client UI (creation only) |
| `stage_instances` | stage_instances.rs | stage.rs full CRUD + speakers | No dedicated client UI |
| `forum_fts` | channels.rs (FTS5) | channels.rs search | Postgres not implemented |
| `scheduled_events` | scheduled_events.rs | events.rs CRUD + RSVP | **Fully implemented** |
| `economy` (migration 20260224) | **No DB module** | **No API routes** | **Schema exists, zero implementation** -- tables for currency, shop items, transactions are created but no code references them |

**Notable finding:** The `20260224000001_economy.sql` migration creates economy-related tables but there is no corresponding `economy.rs` module in paracord-db, no API routes, and no client code. This is either a planned feature migrated ahead of implementation or an abandoned experiment.

### 4.6 Feature Completion Priorities

Ranked by impact-to-effort ratio for a polished v1.0:

| Priority | Feature | Effort | Impact | Rationale |
|----------|---------|--------|--------|-----------|
| 1 | Email delivery (SMTP) | S | High | Password reset and email verification are broken without it |
| 2 | Stage channel UI | M | Medium | API is 100% done; needs StageView component |
| 3 | Message edit history viewer | S | Medium | One click handler + modal; API exists |
| 4 | Channel follows UI | S | Medium | Announcement cross-posting is core Discord feature |
| 5 | Template browsing page | S | Low | Nice-to-have for discoverability |
| 6 | Federation admin panel | M | Medium | Critical for self-hosters who federate |
| 7 | Economy system implementation | L | Low | Schema exists but zero code |
| 8 | PostgreSQL forum FTS | S | Low | Only affects Postgres + forums |

### 4.7 Overall Completeness Summary

**By the numbers:**
- Total features inventoried: **118**
- Complete: **103** (87%)
- Partial: **10** (9%)
- Backend Only (no UI): **5** (4%)

This is an exceptionally high completion rate for a platform of this complexity. The core messaging, voice/video, guild management, bot ecosystem, authentication, and social features are all fully functional end-to-end. The gaps are concentrated in three areas: (1) UI polish for backend features that already have complete APIs (stage channels, channel follows, edit history), (2) email delivery infrastructure, and (3) federation administration tooling. None of these gaps affect the core user experience of joining a server, chatting, and using voice.

<!-- END SECTION: feature-completeness -->

---

<!-- SECTION: new-features -->
## 5. New Feature Recommendations

This section presents a comprehensive feature roadmap for Paracord, informed by competitive analysis of Discord, Matrix/Element, Revolt, Guilded, and Rocket.Chat; user sentiment research around Discord's privacy controversies and Nitro paywall complaints; the EU Digital Markets Act interoperability requirements; and a thorough audit of Paracord's current codebase capabilities.

### 5.1 Must-Have Features (Table Stakes)

These are features that users of any modern chat platform expect. Missing any of these creates friction that drives users to competitors.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Full-text message search** | Server-side full-text search across all channels a user has access to, with filters for author, date range, channel, has:file, has:link, has:embed. The `search_messages` endpoint exists in `channels.rs` but needs FTS indexing (forum FTS migration exists at `20260301000006_forum_fts.sql` but general message FTS is absent). | Search is the #1 most-used feature after sending messages. Users cannot find past conversations without it. | M | **High** | **P0** |
| 2 | **Push notifications** | System-level push notifications via Tauri's notification API for desktop, and FCM/APNs for future mobile. Configurable per-channel and per-guild mute/mention-only settings. The `UserSettings.notifications` field exists as an opaque `Record<string, unknown>` but no notification delivery pipeline is implemented. | Users miss messages without notifications. This is non-negotiable for daily-driver usage. | M | **High** | **P0** |
| 3 | **User status and rich presence** | Expand the existing `Presence` and `Activity` types to support custom status text with emoji, Spotify/game detection (via Tauri's native APIs), and "watching"/"listening" activity types. Basic presence (`online`/`idle`/`dnd`/`offline`) and activity structs exist but the client has limited display. | Social presence drives engagement and makes the platform feel alive. Revolt and Guilded both offer rich status. | S | **Medium** | **P1** |
| 4 | **Message threads improvements** | Threads exist (`ChannelType.Thread = 6`, `ThreadPanel.tsx`) but need: thread notification settings, thread auto-archive improvements, thread member list, and sidebar thread browser. | Threads are essential for organized discussion in busy channels. Discord's thread UX is a key differentiator. | M | **Medium** | **P1** |
| 5 | **Scheduled messages** | Allow users to compose a message and schedule it for future delivery. Server-side timer with the existing background task system in `paracord-server`. | Common in Slack and business chat tools. Useful for communities spanning time zones. | S | **Low** | **P2** |
| 6 | **User profile enhancements** | `UserProfile.tsx` exists but needs: profile banner display (the `banner` field exists on `User`), mutual servers/friends display, user-created "About Me" sections with Markdown, pronouns field, linked accounts display. | Rich profiles drive identity investment and community belonging. | S | **Medium** | **P1** |
| 7 | **Stickers and animated emoji** | Extend the existing `GuildEmoji` system to support animated GIF emoji and sticker packs. The `animated` boolean field already exists on `GuildEmoji`. GIF picker via Tenor integration is in progress (`tenor.ts`, `GifPicker.tsx`). | Expressive communication features drive engagement and are expected by users migrating from Discord. | M | **Medium** | **P2** |
| 8 | **Typing indicators in DMs** | The `typing` endpoint exists for guild channels but DM typing indicators need WebSocket gateway support for the DM channel scope. | Basic real-time feedback that users expect in any messenger. | S | **Medium** | **P1** |

### 5.2 Privacy & Security Differentiators

These features leverage Paracord's self-hosted and federated architecture to offer privacy guarantees that centralized platforms structurally cannot match. Discord's 2025/2026 age verification controversy (face scans, government ID uploads) and the resulting mass Nitro cancellations create a massive opportunity here.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **E2EE for group channels** | Extend the existing DM E2EE (`dmE2ee.ts`, Signal prekeys in `20260217000002_signal_prekeys.sql`) to support encrypted group DMs and optionally encrypted guild channels using the Signal Protocol's Sender Keys for group encryption. | The `MessageE2eePayload` type and DM encryption infrastructure already exist. Extending to groups would make Paracord the only Discord-like platform with group E2EE. This directly addresses Discord's biggest privacy criticism. | L | **High** | **P0** |
| 2 | **Zero-knowledge server mode** | A server configuration where the server operator cannot read message content -- all messages are E2EE, metadata is minimized, and the server acts only as a relay. Similar to Signal's sealed sender. | Unique selling point for privacy-conscious communities (journalists, activists, security researchers). No competitor offers this in a Discord-like UX. | XL | **High** | **P1** |
| 3 | **Comprehensive data export and portability** | The `export_my_data` endpoint exists in `users.rs` but should be expanded to include: all messages, DMs, attachments, guild memberships, roles, settings, and encryption keys -- in a standard, documented JSON format. Add import capability. | EU GDPR Article 20 right to data portability. Also a key differentiator: "your data is truly yours." Discord's data export is slow and incomplete. | M | **Medium** | **P1** |
| 4 | **Verifiable identity with public key authentication** | The `crypto_auth_enabled` setting and `pubkey_auth` migration exist. Expand to show verified key fingerprints in the UI, support key rotation with notification, and cross-device key verification (QR code ceremony like Matrix). | Provides cryptographic proof of identity without trusting the server. Critical for high-security use cases. | M | **High** | **P1** |
| 5 | **Disappearing messages** | Per-channel or per-conversation setting for automatic message deletion after a configurable time period (1 hour, 1 day, 1 week, 30 days). | Signal and Telegram both offer this. Important for privacy-conscious users who want to minimize data retention. | S | **Medium** | **P2** |
| 6 | **Tor/I2P support** | Allow the Paracord server to expose a `.onion` hidden service, and allow the client to connect through Tor. Federation over Tor hidden services. | Attracts the most privacy-conscious users. No Discord alternative currently offers seamless onion routing. | L | **Medium** | **P2** |
| 7 | **Audit log for server operators** | Expand the existing `AuditLogEntry` system and `audit.rs` routes to log all administrative actions, permission changes, and data access events. Add retention policies and export. | Server operators need to know what happened on their infrastructure. Required for compliance in regulated environments. | M | **Medium** | **P1** |
| 8 | **Anonymous posting mode** | Allow guild channels to support anonymous posting where messages are attributed to a guild-assigned pseudonym rather than the user's real identity. Server admin can de-anonymize for moderation. | Useful for feedback channels, whistleblowing, and sensitive community discussions. Unique feature no competitor offers. | M | **Medium** | **P2** |

### 5.3 Federation-Unique Features

These features are only possible or significantly enhanced because Paracord supports server-to-server federation. The existing federation system (`paracord-federation` crate) provides Ed25519-signed event envelopes, trusted peer management, outbound queue with retry, and room-scoped event forwarding.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Portable identity across servers** | The `FederatedIdentity` protocol type (`@username:server.domain`) exists. Extend to full portable identity: a user on `server-a.example` can join guilds on `server-b.example` without creating a new account. Use the existing Ed25519 signing infrastructure for cross-server identity verification. | This is the killer feature of federation. Matrix does this well. Without it, federation is just message relay. | XL | **High** | **P0** |
| 2 | **Shared/bridged channels** | Allow a channel to exist simultaneously on multiple federated servers, with messages synced in real-time via the existing event envelope system. The `room_id` concept in federation events already supports this conceptually. | Matrix's most popular federation feature. Enables cross-community collaboration without forcing everyone onto one server. | XL | **High** | **P0** |
| 3 | **Federated server discovery** | Expand `list_discoverable_guilds` (currently single-server) to a federated discovery protocol where servers advertise their public guilds to trusted peers. The `allow_discovery` flag exists in `FederationConfig`. | Users need to find communities across the federation without knowing specific server URLs. Mastodon's relay/discovery model works well here. | L | **High** | **P1** |
| 4 | **Cross-server emoji and sticker federation** | Allow guilds on federated servers to share emoji packs, similar to how Matrix bridges emoji between rooms. Extend the federation event types beyond `m.message` and `m.member.join`. | Small quality-of-life feature that makes federation feel seamless rather than technically bolted on. | M | **Low** | **P2** |
| 5 | **Federation admin dashboard** | A web UI for server operators to manage trusted peers, view delivery queue status, monitor federation health, and diagnose connectivity issues. The outbound queue (`enqueue_outbound_event`, `fetch_due_outbound_events`) provides the data layer. | Federation is complex. Without good admin tooling, operators will not enable it. Matrix's Synapse admin API is a good reference. | M | **Medium** | **P1** |
| 6 | **Protocol bridges** | Bridges to Matrix, XMPP, IRC, and Slack -- allowing Paracord users to communicate with users on other platforms. Build on the existing federation envelope format. | Massively expands Paracord's network effect without requiring everyone to switch. The EU Digital Markets Act (Article 7) mandates messaging interoperability for gatekeepers, creating market demand for bridge-capable platforms. | XL | **Medium** | **P2** |
| 7 | **Federated moderation lists** | Shared blocklists and moderation actions across federated servers. A server can subscribe to a trusted moderation list and automatically block known bad actors. | Mastodon's `#FediBlock` lists demonstrate demand. Essential for federation at scale -- individual server admins cannot moderate the entire network alone. | L | **Medium** | **P1** |
| 8 | **Federation protocol versioning and negotiation** | Add protocol version headers to federation requests, support graceful degradation when peers run different versions, and provide migration paths for protocol changes. | Without this, federation becomes fragile as the protocol evolves. Matrix's room version system is a good model. | M | **Medium** | **P1** |

### 5.4 Community & Social Features

Features that drive engagement, retention, and community growth. These make communities "sticky" and give users reasons to return.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Scheduled events improvements** | The `scheduled_events` migration exists and `EventList.tsx` component is present. Add: recurring events, RSVP with calendar export (iCal), event reminders via notifications, event channels that auto-create before and auto-archive after. | Guilded offered integrated event calendars for free, something Discord gates behind boosts. This is a competitive advantage. | M | **High** | **P1** |
| 2 | **Advanced polls and surveys** | Polls exist (`Poll`, `PollOption` types, `PollMessageCard.tsx`). Add: anonymous polls, poll scheduling, multi-question surveys, poll results export, poll templates. | Polls are already implemented -- extending them is low-effort/high-engagement. | S | **Medium** | **P2** |
| 3 | **Community onboarding flow** | `OnboardingWizard.tsx` exists. Enhance with: customizable welcome screens (guild `GuildWelcomeScreen.tsx` exists), role selection during onboarding, rules acceptance gate, progressive disclosure of channels based on activity. | Reduces new-member drop-off. Discord's onboarding features are Nitro-gated; offering them free is a differentiator. | M | **High** | **P1** |
| 4 | **Reputation and XP system** | The `economy` migration (`20260224000001_economy.sql`) suggests groundwork exists. Build: message-based XP, configurable level roles, leaderboards, activity streaks, achievement badges. | Gamification drives retention. Discord's "Active Developer Badge" program shows demand. Guilded had built-in XP. | M | **Medium** | **P2** |
| 5 | **Wiki/knowledge base channels** | A new channel type for structured, editable wiki pages within a guild. Supports Markdown with revision history, table of contents, and search. | Communities need persistent knowledge storage. Forums (`ForumView.tsx`) are for discussion; wikis are for reference. Notion/Confluence integration is a common Discord pain point. | L | **Medium** | **P2** |
| 6 | **Voice channel text chat** | A text chat panel that appears alongside voice channels, persisted separately from the main text channels. | Discord added this and it immediately became heavily used. Users in voice want to share links and text without switching channels. | S | **Medium** | **P1** |
| 7 | **Community hub/directory** | Expand the existing `hub_settings` on guilds and `ServerHubSettings.tsx` to create a full community directory with categories, descriptions, member counts, and featured communities. | Helps users discover communities. Discord's Server Discovery is limited; an open, federated directory is more powerful. | M | **High** | **P1** |
| 8 | **Clips and highlights** | Allow users to capture short clips of voice/video calls or screen shares, save them to a channel, and share them. Leverage the existing native media stack (`paracord-codec`). | Growing feature in gaming communities. Clips drive content creation and sharing. | L | **Medium** | **P3** |

### 5.5 Developer & Bot Ecosystem

A thriving bot ecosystem is critical for platform adoption. Paracord already has substantial bot infrastructure (`bot_applications`, `bot_commands_and_interactions`, `bot_store`, OAuth2 authorization), but needs to make it developer-friendly.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Bot SDK (TypeScript and Python)** | Official client libraries wrapping Paracord's REST API and WebSocket gateway. Include command registration, event handling, interaction responses, and embed builders. Publish to npm and PyPI. | Discord's massive bot ecosystem exists because of discord.js and discord.py. Without SDKs, bot development requires too much boilerplate. | L | **High** | **P0** |
| 2 | **Interactive API documentation** | Auto-generated OpenAPI/Swagger documentation from the axum route definitions. Include authentication, rate limits, example requests/responses, and a "Try It" sandbox. | Developers will not build on a platform without good API docs. This is table stakes for any developer platform. | M | **High** | **P0** |
| 3 | **Webhook improvements** | Webhooks exist (`webhooks.rs`). Add: webhook message editing and deletion, webhook avatars per-message, webhook rate limit headers, incoming webhook URL format compatible with Discord's format (enables easy migration of existing integrations). | Discord-compatible webhook format would let existing integrations (GitHub, GitLab, CI/CD) work with zero changes. Massive adoption accelerator. | M | **High** | **P1** |
| 4 | **Bot store and marketplace** | `BotStoreSection.tsx`, `BotStoreCard.tsx`, `store_search`, `store_featured`, and `store_categories` exist. Enhance with: user reviews and ratings, install counts, verified developer badges, one-click install, permission review screen. | The infrastructure exists; polishing it into a real marketplace creates a distribution channel for bot developers. | M | **Medium** | **P1** |
| 5 | **Plugin/extension system** | A sandboxed plugin runtime that allows server-side code execution (WASM-based) for custom commands, event handlers, and integrations without running a separate bot process. | Reduces the operational burden of running bots. Cloudflare Workers-style serverless execution for chat bots would be novel and attractive to developers. | XL | **High** | **P2** |
| 6 | **Bot analytics dashboard** | Provide bot developers with usage metrics: command invocations, error rates, response times, user engagement, guild install/uninstall rates. | Developers need to understand how their bots are used. Discord's developer portal provides basic analytics. | M | **Medium** | **P2** |
| 7 | **Slash command auto-discovery** | When a user types `/` in the message input, show a categorized, searchable list of all available commands from installed bots. `SlashCommandPopup.tsx` exists but may need enhancement for multi-bot command namespacing. | Discoverability is the biggest problem with bot commands. Users do not know what commands are available. | S | **Medium** | **P1** |
| 8 | **Event-driven automation (IFTTT-style)** | A no-code automation builder: "When [event] in [channel], do [action]." Events: message posted, user joined, reaction added. Actions: send message, assign role, post to webhook, create thread. | Empowers non-developer server admins to create custom workflows. Guilded had some automation; Discord requires bots for everything. | L | **Medium** | **P2** |

### 5.6 Moderation & Safety

Essential for any community platform. Paracord has basic moderation (bans, role-based permissions, audit logs) but needs advanced tooling to handle the challenges of open, federated communities.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **AutoMod rule engine** | A configurable, server-side content filter with rules for: keyword blocking (regex), link filtering (allowlist/blocklist), spam detection (duplicate message rate), mention spam limits, new account restrictions. Runs before message delivery. | Discord's AutoMod is their most impactful moderation feature. Essential for any server with >100 members. Self-hosted AutoMod means the rules stay private. | L | **High** | **P0** |
| 2 | **Anti-raid protection** | Automatic detection and mitigation of raid attacks: sudden join spike detection, CAPTCHA challenge for new joins during a raid, temporary lockdown mode, auto-ban of raid accounts based on account age and join pattern. | Raids are the #1 operational problem for community servers. Without anti-raid, large communities are unmanageable. | L | **High** | **P0** |
| 3 | **User reporting system** | Allow users to report messages, users, or guilds. Reports go to guild moderators with a review queue. For federated servers, reports can optionally be forwarded to the user's home server. | Users need a way to flag bad behavior. Currently, moderation is entirely reactive -- mods must witness the problem. | M | **High** | **P1** |
| 4 | **Moderation action templates** | Pre-defined moderation actions: verbal warning, mute (timed), kick, ban, with customizable messages and automatic DM notification to the moderated user. | Standardizes moderation across a mod team. Reduces inconsistency and mod burnout. | S | **Medium** | **P2** |
| 5 | **Slow mode improvements** | `rate_limit_per_user` exists on channels. Add: per-role slow mode exemptions, adaptive slow mode that activates during high activity, slow mode for thread creation. | Makes slow mode actually usable for moderation rather than a blunt instrument. | S | **Low** | **P2** |
| 6 | **Quarantine channel** | When AutoMod flags a message, move it to a quarantine channel visible only to moderators for review, rather than silently deleting it. Include approve/reject/ban actions. | Reduces false positives. Moderators can review flagged content and learn from AutoMod's behavior. | M | **Medium** | **P2** |
| 7 | **Mod log channel** | A designated channel that receives formatted messages for all moderation actions (bans, kicks, mutes, message deletions, role changes). Builds on the existing audit log system. | Transparency and accountability for mod teams. Most Discord servers use bots for this; building it in is better. | S | **Medium** | **P1** |
| 8 | **Verification gates** | Require new members to complete a verification step before gaining access to the server: accept rules, solve a CAPTCHA, or answer a question. More sophisticated than Discord's verification levels. | First line of defense against bots and raiders. The existing `OnboardingWizard.tsx` could be extended for this. | M | **High** | **P1** |

### 5.7 AI & Modern Features

AI features should add genuine utility, not gimmicks. Focus on features that are especially valuable in a self-hosted context where the user controls their data and can choose their AI provider.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Channel/thread summarization** | "Catch up" feature that summarizes unread messages in a channel or thread. Runs on the server (or client-side for E2EE channels) using a configurable LLM endpoint (OpenAI, Anthropic, Ollama for self-hosted). | WhatsApp launched message summaries in 2025. Android 16 added AI notification summaries. Users expect this now. Self-hosted AI means summaries never leave the server. | M | **High** | **P1** |
| 2 | **Smart search with semantic understanding** | Beyond keyword FTS, allow natural language queries like "that conversation about the deployment issue last week." Uses embeddings for semantic search. | Transforms search from keyword matching to intent understanding. Particularly valuable for large, active servers. | L | **Medium** | **P2** |
| 3 | **AI-powered AutoMod** | Extend the AutoMod rule engine with LLM-based content classification: detect harassment, toxicity, and scam attempts that bypass keyword filters. Use local models (Ollama/llama.cpp) for privacy. | Modern moderation tools use LLMs to understand context and sarcasm. Keyword filters alone miss too much. Self-hosted AI means moderation rules and training data stay private. | L | **Medium** | **P2** |
| 4 | **Meeting/call transcription** | Automatic transcription of voice channel conversations using Whisper or similar. Transcripts stored in an associated text channel. Optional speaker diarization. | Increasingly expected in professional communication tools. Paracord's native media stack (`paracord-codec` with Opus) provides the audio data. | L | **Medium** | **P2** |
| 5 | **Bot-building AI assistant** | An AI assistant that helps non-developers create simple bots by describing desired behavior in natural language. Generates bot code using the official SDK. | Lowers the barrier to bot creation dramatically. Novel feature no competitor offers. | L | **Low** | **P3** |
| 6 | **Pluggable AI provider** | A server-side configuration for AI endpoints (OpenAI, Anthropic, Ollama, local llama.cpp) so all AI features can use self-hosted models. No data leaves the server unless the admin explicitly configures an external provider. | Critical differentiator: "AI features without the privacy trade-off." Centralized platforms cannot offer this. | M | **High** | **P1** |

### 5.8 Mobile & Cross-Platform

A platform without mobile access is a desktop-only hobby project. Mobile is essential for daily-driver status.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Mobile app (iOS and Android)** | Use Tauri v2's mobile support to build iOS and Android apps from the existing React codebase. Tauri v2 officially supports mobile targets since its October 2024 stable release. The `MobileBottomNav.tsx` component suggests mobile-responsive design is already in progress. | Without mobile, Paracord cannot be anyone's primary communication platform. Tauri v2 mobile support means the existing codebase can be reused. | XL | **High** | **P0** |
| 2 | **Progressive Web App (PWA)** | Package the existing web client as a PWA with service worker for offline message viewing, push notifications via Web Push API, and install-to-home-screen. This provides mobile access before native apps are ready. | PWA is a fast path to mobile that works today with the existing Vite build. Covers the gap until native mobile is ready. | M | **High** | **P0** |
| 3 | **Responsive design audit** | Ensure all UI components work on mobile viewport sizes. `MobileBottomNav.tsx` exists but the main `AppLayout.tsx`, `ChannelSidebar.tsx`, and `MemberList.tsx` need responsive breakpoints. | The web client may already partially work on mobile browsers, but a systematic responsive audit is needed. | M | **High** | **P1** |
| 4 | **Notification sync across devices** | Read state (`ReadState` type, `read_states.rs`) exists. Ensure that marking messages as read on one device syncs to all others via the WebSocket gateway. | Users with multiple devices expect consistent notification state. Without this, they get phantom notifications. | S | **Medium** | **P1** |
| 5 | **Low-bandwidth mode** | A client setting that reduces data usage: compressed images, no auto-play videos/GIFs, text-only mode for voice channels. | Essential for mobile users on cellular data, especially in developing markets. | M | **Medium** | **P2** |
| 6 | **Offline message queue** | Allow composing and queuing messages while offline, with automatic delivery when connectivity is restored. | Mobile users frequently lose connectivity. Messages should not be lost. | S | **Medium** | **P2** |

### 5.9 Monetization & Sustainability

Self-hosted open source software needs a sustainability model. These recommendations avoid vendor lock-in while providing revenue streams for continued development.

| # | Feature | Description | Rationale | Effort | Impact | Priority |
|---|---------|-------------|-----------|--------|--------|----------|
| 1 | **Managed hosting service (Paracord Cloud)** | Offer a hosted Paracord service where users get a pre-configured server with automated backups, updates, and monitoring. Open-core model: the self-hosted version is fully featured, the hosted version adds operational convenience. | The most proven open-source monetization model (GitLab, Discourse, Matrix/Element). Reduces friction for non-technical users while funding development. | XL | **High** | **P1** |
| 2 | **Premium theme/sticker marketplace** | A marketplace where creators sell custom themes, sticker packs, and emoji sets. Platform takes a percentage. Paracord already supports custom CSS (`CustomCSS.tsx`) and theme selection (`ThemeSelector.tsx`). | Revenue sharing incentivizes content creation. Users already pay for Discord Nitro primarily for emoji/stickers. | M | **Medium** | **P2** |
| 3 | **Enterprise features tier** | SSO/SAML integration, advanced audit logging, compliance exports, SLA support, priority bug fixes. These features are valuable only to organizations and do not diminish the community edition. | Enterprise customers pay well for compliance and support features. This is the open-core model that funds GitLab, Mattermost, and Rocket.Chat. | L | **Medium** | **P2** |
| 4 | **Sponsorship and donation infrastructure** | Integrate with GitHub Sponsors, Open Collective, and Patreon. Add an in-app "Support Paracord" link. Transparent funding dashboard. | Many open-source projects sustain on donations alone. Making it easy to contribute financially helps. | S | **Low** | **P2** |
| 5 | **Bot/plugin marketplace revenue sharing** | Allow bot developers to charge for premium bots or plugins through the bot store. Platform takes a percentage (15-30%). | Creates an ecosystem incentive: developers build for Paracord because they can monetize. Discord's app directory is moving this direction. | L | **Medium** | **P3** |
| 6 | **Paracord Pro for server owners** | Optional paid tier for server owners (not end users) that unlocks: higher file upload limits, more emoji slots, priority federation routing, advanced analytics dashboard. Does not restrict core communication features. | Server owners are the most invested users. Charging them (not end users) avoids Discord's Nitro resentment while funding infrastructure. | M | **Medium** | **P2** |

### 5.10 Feature Roadmap

#### Immediate (1-3 months) -- Critical Missing Features and Quick Wins

These items address the most impactful gaps that prevent Paracord from being a daily-driver replacement for Discord.

| Priority | Feature | Effort | Rationale |
|----------|---------|--------|-----------|
| **P0** | Full-text message search with indexing | M | Cannot find past messages. #1 usability gap. |
| **P0** | Push notifications (desktop) | M | Users miss messages without notifications. Non-negotiable. |
| **P0** | AutoMod rule engine | L | Communities >100 members are unmanageable without content filtering. |
| **P0** | Anti-raid protection | L | A single raid can destroy a community's trust. |
| **P0** | Bot SDK (TypeScript) | L | No ecosystem without developer tools. |
| **P0** | Interactive API documentation | M | Developers cannot build without docs. |
| **P0** | PWA packaging | M | Fastest path to mobile access. |
| **P1** | User profile enhancements | S | Quick win for engagement. |
| **P1** | Typing indicators in DMs | S | Quick win for UX polish. |
| **P1** | Slash command auto-discovery | S | Quick win for bot UX. |
| **P1** | Mod log channel | S | Quick win for moderation transparency. |

**Target outcomes:** Paracord becomes viable as a primary communication platform for small-to-medium communities. Bot developers can start building. Basic moderation is automated.

#### Short-term (3-6 months) -- Differentiating Features

These items start to distinguish Paracord from both Discord and other alternatives.

| Priority | Feature | Effort | Rationale |
|----------|---------|--------|-----------|
| **P0** | E2EE for group channels | L | Signature differentiator leveraging existing E2EE infrastructure. |
| **P0** | Portable federated identity | XL | The killer feature that makes federation real. |
| **P0** | Shared/bridged channels | XL | Most requested federation feature. |
| **P0** | Mobile app (Tauri v2) | XL | Required for daily-driver usage. |
| **P1** | Channel/thread summarization (AI) | M | High-demand modern feature with privacy advantage. |
| **P1** | Pluggable AI provider config | M | Enables all AI features with self-hosted models. |
| **P1** | Scheduled events improvements | M | Competitive advantage over Discord's boosted-only features. |
| **P1** | Community onboarding flow | M | Reduces new-member drop-off. |
| **P1** | Webhook Discord-compatibility | M | Zero-effort migration of existing integrations. |
| **P1** | Federation admin dashboard | M | Required for operators to enable federation confidently. |
| **P1** | Verification gates | M | Essential moderation defense. |
| **P1** | User reporting system | M | Users need a way to flag problems. |

**Target outcomes:** Paracord has a unique value proposition (federated + encrypted + Discord UX). Mobile users can participate. Federation is usable by non-experts. AI features with privacy become a talking point.

#### Medium-term (6-12 months) -- Platform Maturity

These items build Paracord into a mature platform with a self-sustaining ecosystem.

| Priority | Feature | Effort | Rationale |
|----------|---------|--------|-----------|
| **P1** | Managed hosting service | XL | Revenue and growth engine. |
| **P1** | Federated server discovery | L | Makes the federation network navigable. |
| **P1** | Federated moderation lists | L | Required for federation at scale. |
| **P1** | Zero-knowledge server mode | XL | Ultimate privacy differentiator. |
| **P1** | Comprehensive data export/import | M | GDPR compliance and user trust. |
| **P2** | Plugin/extension system (WASM) | XL | Reduces operational burden of running bots. |
| **P2** | Protocol bridges (Matrix, IRC) | XL | Network effect expansion. |
| **P2** | Enterprise SSO/SAML tier | L | Enterprise revenue. |
| **P2** | Reputation and XP system | M | Gamification for retention. |
| **P2** | AI-powered AutoMod | L | Next-generation moderation. |
| **P2** | Bot analytics dashboard | M | Developer ecosystem maturity. |
| **P2** | Premium marketplace | M | Creator economy and revenue. |

**Target outcomes:** Paracord has a sustainable business model. Federation operates at scale. The platform is mature enough for enterprise adoption. A creator/developer economy emerges.

#### Long-term (12+ months) -- Vision Features

These items represent the ambitious, long-term vision for Paracord as the definitive open, federated communication platform.

| Priority | Feature | Effort | Rationale |
|----------|---------|--------|-----------|
| **P2** | Wiki/knowledge base channels | L | Transform guilds from chat rooms into knowledge hubs. |
| **P2** | Meeting/call transcription | L | Professional communication parity. |
| **P2** | Semantic AI search | L | Next-generation information retrieval. |
| **P2** | Event-driven automation (no-code) | L | Empower non-developer server admins. |
| **P3** | Tor/I2P support | L | Maximum privacy for at-risk users. |
| **P3** | Bot-building AI assistant | L | Democratize bot creation. |
| **P3** | Clips and highlights | L | Content creation features. |
| **P3** | Bot/plugin marketplace revenue sharing | L | Ecosystem monetization. |

**Target outcomes:** Paracord is the reference implementation for open, federated, private communication. The platform is self-sustaining with multiple revenue streams. The federation network rivals Matrix in reach while offering Discord-level UX.

### 5.11 Strategic Summary

Paracord's unique advantage is the combination of **Discord-level UX + Matrix-level federation + Signal-level privacy** in a single, self-hosted platform. The feature roadmap is designed to:

1. **Close table-stakes gaps first** (search, notifications, moderation, mobile) so Paracord can be a daily driver
2. **Double down on differentiators** (E2EE groups, federated identity, self-hosted AI) that no competitor can match
3. **Build ecosystem and sustainability** (bot SDKs, marketplace, managed hosting) for long-term viability
4. **Leverage regulatory tailwinds** (EU DMA interoperability mandates, GDPR data portability) that favor federated, open platforms

The biggest risk is trying to do everything at once. The P0 items in the Immediate phase should be the sole focus until they ship -- they represent the minimum viable feature set for Paracord to graduate from "interesting project" to "usable platform."

<!-- END SECTION: new-features -->

---

<!-- SECTION: security -->
## 6. Security Hardening

### Security Posture Summary

Paracord demonstrates a **mature, defense-in-depth security posture** for a self-hosted platform at this stage of development. The codebase shows deliberate attention to authentication hardening, input validation, rate limiting, and network security headers. No critical vulnerabilities were found. The most significant issues are medium-severity items related to SSRF in the OpenGraph fetcher and a `dangerouslySetInnerHTML` usage in the code block renderer.

| Severity | Count | Summary |
|----------|-------|---------|
| Critical | 0 | None found |
| High | 2 | SSRF in OpenGraph fetcher; code highlighting XSS surface |
| Medium | 5 | Refresh token in localStorage; V1 E2EE fallback weakness; challenge store memory bounds; CSP connect-src permissiveness; missing password complexity enforcement |
| Low | 5 | JWT HS256 symmetric signing; cookie Secure flag conditionally omitted; metrics endpoint timing oracle; no CSRF token on state-changing POSTs; MFA backup code generation details |
| Info | 4 | Strong dependency choices; good test coverage patterns; config secret validation; federation content validation |

---

### Authentication & Session Security

**Password Hashing (Strong):** Argon2id with OS-sourced random salt (`crates/paracord-core/src/auth.rs:63-70`). This is the current best-practice KDF. The `Argon2::default()` configuration uses reasonable parameters.

**JWT Implementation:**
- HS256 symmetric signing (`crates/paracord-core/src/auth.rs:55,111`). While functional, asymmetric signing (RS256/ES256) would be preferable for multi-server deployments.
- **[Info]** Token includes `sub`, `sid` (session ID), `jti` (unique token ID), `exp`, `iat` claims -- proper session binding.
- Access token expiry defaults to 900s (15 min) (`crates/paracord-server/src/config.rs:506`), a reasonable short-lived window.
- Minimum JWT secret length of 32 chars enforced at startup (`crates/paracord-server/src/config.rs:630`), with placeholder secret detection.

**Session Management (Strong):**
- Refresh token rotation on each use (`crates/paracord-api/src/routes/auth.rs:665-718`): old hash replaced atomically, preventing token replay.
- Refresh tokens are SHA-256 hashed before DB storage (`auth.rs:621,669`), so DB compromise does not yield usable tokens.
- Session revocation with `revoked_at` timestamp check and expiry check (`auth.rs:675-676`).
- Max session TTL configurable and clamped to 1-365 days (`auth.rs:230-234`).
- Per-user session listing and individual revocation via API (`crates/paracord-api/src/lib.rs:110-113`).

**Cookie Security:**
- HttpOnly, SameSite=Lax, path-scoped cookies for both access and refresh tokens (`auth.rs:503-547`).
- **[Low]** Secure flag is conditional on `PARACORD_COOKIE_SECURE`, `PARACORD_TLS_ENABLED`, or HTTPS public_url (`auth.rs:380-406`). In dev environments without TLS, cookies are sent without Secure flag. This is expected but operators should be aware.

**Auth Guard (Brute-Force Protection):**
- Multi-key rate limiting on login/register keyed by IP, device ID/user-agent, and account hint (`auth.rs:115-144`).
- Failure counting with lockout stored in DB (`auth.rs:179-227`).
- Constant-time comparison for challenge bypass token (`auth.rs:60-71`).
- Periodic cleanup of expired guard entries (`auth.rs:160-177`).

**MFA (TOTP):**
- TOTP implementation via `totp-rs` crate with QR code generation, setup/verify/disable flow (`crates/paracord-api/src/lib.rs:127-131`).
- MFA-gated login flow with ticket-based two-step process.
- **[Low]** Backup code generation and storage details should be reviewed for sufficient entropy.

**[Medium] Missing Password Complexity Enforcement:**
No minimum password length or complexity requirements were found in the registration handler (`auth.rs:823+`). The handler validates username and email but does not enforce password strength. Recommendation: Add minimum length (8+ chars) and consider basic complexity checks.

**[Medium] Refresh Token in localStorage:**
The client stores refresh tokens in `localStorage` (`client/src/lib/authToken.ts:16-19`). While the server also sends `HttpOnly` cookies, the localStorage copy is accessible to any XSS in the same origin. This is a deliberate design choice for Tauri/cross-origin compatibility, but it increases the blast radius of any XSS. Recommendation: Document this tradeoff; consider using Tauri's secure storage for desktop clients.

---

### Authorization & Permissions

**Permission Model (Strong):**
- Bitflag-based permissions (server uses `bitflags`, client uses BigInt) with channel-level overwrites.
- `compute_channel_permissions` and `compute_channel_permissions_cached` with Moka LRU cache (5-min TTL, 10k entries).
- Guild owner bypass correctly grants all permissions.
- `ensure_guild_member` checks membership before any guild-scoped operation (`crates/paracord-api/src/routes/channels.rs:262-292`).

**IDOR Protection:**
- Channel access requires `VIEW_CHANNEL` permission check per channel-event (`crates/paracord-ws/src/handler.rs:582-607`).
- Message operations check channel permissions before allowing read/write.
- DM access verified via `is_dm_recipient` check.
- Admin endpoints use `AdminUser` extractor that verifies admin flags (`crates/paracord-api/src/middleware.rs:163-189`).

**WebSocket Authorization:**
- Gateway IDENTIFY requires valid JWT with active session (`handler.rs:1131-1249`).
- Per-user connection limit (default 5) prevents session flooding (`handler.rs:344-352`).
- Guild membership checked before delivering guild events to sessions (`handler.rs:578-580`).
- Resume validates that the cached session belongs to the same user (`handler.rs:1186`).

---

### Input Validation & Injection Prevention

**SQL Injection (Strong - Not Vulnerable):**
All database queries use SQLx parameterized queries (`$1`, `$2`, etc.). No string interpolation into SQL was found. The one `format!` usage in `application_commands.rs:84` constructs a column list constant, not user input. All 80+ DB modules consistently use bind parameters.

**XSS Prevention:**
- **[High] `dangerouslySetInnerHTML` in CodeBlock.tsx** (`client/src/components/message/CodeBlock.tsx:177`): The `highlight.js` output is inserted via `dangerouslySetInnerHTML={{ __html: highlightedHtml }}`. While `highlight.js` performs its own sanitization of language tokens, this is a trust boundary. A bug in highlight.js's grammar definitions could potentially inject HTML. Recommendation: Wrap the output through a DOM sanitizer (e.g., DOMPurify) before insertion, or validate that highlight.js's output contains only `<span>` tags with class attributes.
- The markdown parser (`client/src/lib/markdown.ts`) uses React's `createElement` API throughout, which auto-escapes content. Links are rendered with `rel="noopener noreferrer"` and `target="_blank"`.
- The `contains_dangerous_markup` function (`crates/paracord-api/src/routes/channels.rs:51-58`) checks for `<script`, `javascript:`, `onerror=`, `onload=`, `<iframe` patterns in channel topics/names.

**Content Type Validation (Strong):**
- File uploads detect and reject active content types (HTML, SVG, JS) at the file system level (`crates/paracord-api/src/routes/files.rs:38-63`).
- Content sniffing compares both file extension and body magic bytes.
- Active content is force-downgraded to `application/octet-stream`.
- `X-Content-Type-Options: nosniff` header applied globally.

**Path Traversal Protection:**
- `sanitize_filename_for_path` (`files.rs:160-174`) strips all characters except alphanumeric, `.`, `-`, `_`, replacing everything else with `_`.
- Filenames are never used to construct paths from user input -- attachment IDs (snowflake integers) are used as storage keys.

---

### Network Security

**CORS Configuration (Good):**
- Explicit allowlist of origins including Tauri and localhost development origins (`crates/paracord-api/src/lib.rs:754-814`).
- Wildcard `*` origin explicitly disables `allow_credentials` for safety.
- `PARACORD_CORS_ALLOWED_ORIGINS` env var allows operator customization.
- Credentials enabled only for specific origins.

**Security Headers (Strong):**
Applied globally via middleware (`crates/paracord-api/src/lib.rs:1222-1280`):
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- HSTS with `max-age=31536000; includeSubDomains` when HTTPS detected.

**Content Security Policy:**
- API routes: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` -- excellent lockdown.
- **[Medium]** Frontend CSP: `connect-src 'self' ws: wss: http: https:` is overly permissive. The `http: https:` allows connections to any origin. Recommendation: Restrict `connect-src` to the server's own origin and any known third-party endpoints (e.g., Tenor API).
- Frontend allows `img-src 'self' data: blob: https: http:` which is reasonable for a chat app with external image embeds.

**[High] SSRF in OpenGraph Fetcher:**
`crates/paracord-api/src/opengraph.rs:43-76` -- The `fetch_og` function fetches user-provided URLs for link previews with `reqwest::Client`. While it only processes `http://` and `https://` URLs and limits response size to 512KB, it does **not** validate that the target IP is not a private/internal address. An attacker could post a message containing `http://169.254.169.254/latest/meta-data/` (AWS metadata) or `http://127.0.0.1:8080/api/v1/admin/stats` (internal admin endpoint) and the server would fetch it. The redirect policy allows up to 3 hops, which could redirect from a public URL to an internal one.

Recommendation: Implement IP address validation before making requests. Resolve the hostname, check that the IP is not in RFC 1918/loopback/link-local ranges, and re-validate after each redirect. Note that the federation file download proxy already has SSRF protection (per recent PR #26), but the OpenGraph fetcher does not.

**WebSocket Security:**
- 30-second IDENTIFY timeout (`handler.rs:657`).
- Global connection cap (default 2,000) with atomic CAS (`handler.rs:325-342`).
- Per-user connection limit (default 5) (`handler.rs:344-352`).
- Per-user rate limiting for messages (240/min), presence (60/min), typing (120/min), voice (60/min) using `governor` crate (`handler.rs:356-437`).
- Rate limiter cleanup every 5 minutes to prevent memory growth (`handler.rs:387-407`).

**Proxy Trust Model:**
- `PARACORD_TRUST_PROXY` + `PARACORD_TRUSTED_PROXY_IPS` whitelist (`auth.rs:73-98`). X-Forwarded-For headers are only trusted from explicitly configured proxy IPs. Good defense against header spoofing.

---

### Encryption & Data Protection

**E2EE for DMs (V2 - Signal Protocol):**
- X3DH key agreement + Double Ratchet implementation (`client/src/lib/dmE2ee.ts`).
- Uses `@noble/curves` for Ed25519 and X25519 operations -- a well-audited pure-JS crypto library.
- Prekey bundle fetched from server; one-time prekeys consumed on use with local store update.
- Session state persisted per-peer for ratchet continuity.
- Forward secrecy achieved through ratcheting.

**[Medium] V1 Legacy ECDH Fallback:**
The `DM_E2EE_ALLOW_V1_FALLBACK` environment variable (`dmE2ee.ts:31`) allows falling back to a static ECDH-based scheme (V1) when no Signal session exists. V1 uses a single `sha256(context || shared_secret)` derived key for all messages in a conversation, providing no forward secrecy. If the V1 fallback is enabled and a long-term identity key is compromised, all past V1 messages can be decrypted. Recommendation: Default this to `false` and eventually remove V1 support.

**At-Rest Encryption:**
- AES-256-GCM for file encryption with configurable key from environment variable (`crates/paracord-server/src/config.rs:384-408`).
- Optional SQLCipher support for SQLite encryption.
- Config file permissions hardened to 0600 on Unix, restricted ACLs on Windows (`config.rs:7-33`).

**Secrets Management:**
- JWT secret auto-generated with 64 random hex chars on first run.
- LiveKit secrets auto-generated similarly.
- Federation signing keys stored in separate hex file.
- Placeholder secret detection prevents startup with weak/default values (`config.rs:614-645`).

---

### Federation Security

**Ed25519 Signature Verification:**
- All federation events are wrapped in signed HTTP envelopes.
- Federation content validated for size (1MB max), depth (32 levels), and collection length (10,000 items) (`crates/paracord-api/src/routes/federation.rs:76-100`).
- Admin-only management of federation server trust (`federation.rs` routes require `AdminUser`).

**SSRF in Federation File Downloads:**
- Recent PR #26 (`fix(federation): harden SSRF protection for federated file downloads`) addresses SSRF in the federation file proxy. This was a known vulnerability that has been fixed.

**Per-Peer Rate Limiting:**
- Configurable limits: `max_events_per_peer_per_minute` (default 120), `max_user_creates_per_peer_per_hour` (default 100) (`config.rs:419-422`).

---

### Rate Limiting & DoS Protection

**HTTP Rate Limiting:**
- Global: 120 requests/second per IP (`crates/paracord-api/src/lib.rs:1106`).
- Auth endpoints: 60 requests/minute per IP (`lib.rs:1107`).
- Bot tokens: 300 requests/minute total, 5 writes/second (`lib.rs:1108-1109`).
- DashMap-based in-memory rate limiter with 60-second cleanup interval (`lib.rs:940-990,1089-1103`).
- Preflight OPTIONS requests bypass rate limiting (`lib.rs:1111-1113`).

**WebSocket Rate Limiting:**
- User-keyed rate limiters shared across all connections for the same user, preventing bypass via multiple tabs (`handler.rs:354-365`).
- High-frequency events (presence, typing, voice) silently dropped when rate-limited (`handler.rs:1291-1299`).

**Request Body Limits:**
- Default: 2MB (`lib.rs:24`).
- Attachment uploads: 64MB (`lib.rs:25`).

**[Medium] Challenge Store Memory Bounds:**
The in-memory challenge nonce store (`auth.rs:36`) uses a `HashMap` capped at 10,000 entries with 120-second TTL cleanup. Under sustained attack, this cap is enforced by `cap_oldest_challenges` which sorts and evicts. However, the cleanup only runs when the store is accessed, and the lock is held during cleanup. Recommendation: Consider using a bounded concurrent structure (like moka cache) instead of a manually-capped HashMap to avoid contention under load.

---

### File Upload Security

**Path Traversal:** Fully mitigated via `sanitize_filename_for_path` (`files.rs:160-174`). All special characters stripped.

**Content Type Validation:** Multi-layer defense:
1. Extension check for active types (HTML, SVG, JS) (`files.rs:38-54`).
2. Body magic byte sniffing for HTML/SVG content (`files.rs:56-63`).
3. Content-Type normalization with active type override to `application/octet-stream` (`files.rs:115-126`).
4. Inline display restricted to known-safe types (images, audio, video, PDF, plaintext) (`files.rs:84-100`).

**Malware Scanning:** Pluggable via `PARACORD_MALWARE_SCAN_BIN` environment variable (`files.rs:20-24`). Configurable exit codes, fail-closed mode, and quarantine directory. Well-designed integration point.

**Size Limits:** Configurable `max_upload_size` (default 50MB), enforced at both axum body limit and application level.

---

### Dependency Security

**Rust Dependencies (Good):**
- `argon2 0.5` -- current, uses the RustCrypto implementation.
- `jsonwebtoken 9` -- actively maintained JWT library.
- `sqlx 0.8` -- compile-time checked queries with parameterized statements.
- `ed25519-dalek 2` -- audited Ed25519 implementation.
- `aes-gcm 0.10`, `sha2 0.10`, `hkdf 0.12` -- RustCrypto suite, well-maintained.
- `reqwest 0.12` with `rustls-tls` -- avoids OpenSSL dependency chain.
- `governor 0.10` -- production-quality rate limiter.

**Client Dependencies (Good):**
- `@noble/curves`, `@noble/hashes` -- audited pure-JS crypto by Paul Miller, used by major projects.
- `axios 1.7` -- well-maintained HTTP client.
- `react 19`, `zustand 5` -- current versions.
- `highlight.js 11.11` -- syntax highlighter (see XSS note above).
- `livekit-client 2.17` -- official LiveKit SDK.

No known critical CVEs in the dependency versions listed. The project uses recent versions of all major dependencies.

---

### Security Recommendations (Prioritized)

**High Priority:**

1. **Implement SSRF protection for OpenGraph fetcher** (`crates/paracord-api/src/opengraph.rs`): Add IP address validation after DNS resolution. Reject private, loopback, and link-local addresses. Re-validate after redirects. Model this on the SSRF fix already applied to federation file downloads.

2. **Sanitize highlight.js output** (`client/src/components/message/CodeBlock.tsx:177`): Wrap the `dangerouslySetInnerHTML` output through DOMPurify or use a `<code>` element with textContent fallback. Even though highlight.js sanitizes internally, the `dangerouslySetInnerHTML` bypass of React's escape layer is a high-risk trust boundary.

**Medium Priority:**

3. **Add password complexity requirements** in the registration handler. Enforce minimum length (8 characters) and consider rejecting common passwords.

4. **Restrict CSP connect-src** from `ws: wss: http: https:` to the server's actual origin and known third-party endpoints.

5. **Disable V1 E2EE fallback by default** in production builds. Set `VITE_DM_E2EE_ALLOW_V1_FALLBACK` to `false` in the build configuration and add a deprecation timeline for V1.

6. **Replace in-memory challenge store** with a moka cache for automatic TTL-based eviction, bounded capacity, and lock-free concurrent access.

7. **Move refresh token storage** from `localStorage` to Tauri's secure credential storage for desktop clients (using `@tauri-apps/plugin-store` with encryption).

**Low Priority:**

8. **Consider RSA/EC asymmetric JWT signing** for deployments where the JWT secret needs to be rotated without downtime or shared across multiple services.

9. **Add CSRF tokens** for state-changing POST endpoints called from browser contexts (though SameSite=Lax cookies mitigate most CSRF vectors).

10. **Add security event audit logging** for all authentication operations (successful logins, failed attempts, session revocations, MFA changes) -- some of this appears to exist via the `security` module reference but should be verified for completeness.

11. **Document security configuration** for operators: recommended TLS settings, proxy configuration, rate limit tuning, and production hardening checklist.

<!-- END SECTION: security -->

---

<!-- SECTION: performance -->
## 7. Performance Analysis

### Performance Posture Summary

Paracord's performance architecture is **well-considered for a self-hosted platform** targeting small-to-medium communities (hundreds of concurrent users). The server uses async Rust (tokio + axum) for high throughput, in-memory caches and indexes to avoid hot-path DB queries, and cursor-based pagination for efficient data access. The client employs virtualized rendering, optimistic updates, and abort-controller-based fetch deduplication. However, several patterns introduce bottlenecks that will become significant under heavier load: N+1 query patterns, RwLock contention on shared state, sequential DB updates for batch operations, and application-layer filtering instead of SQL WHERE clauses.

| Area | Rating | Key Finding |
|------|--------|-------------|
| Server DB Queries | Good with gaps | Cursor-based pagination is efficient; N+1 and app-layer filtering are not |
| Caching | Strong | Moka permission cache, DashMap session cache, in-memory member index |
| Connection Handling | Strong | Atomic CAS connection limits, per-user rate limiting, bounded concurrency |
| Event Fan-out | Good with limits | MemberIndex avoids DB queries; RwLock on presence limits write throughput |
| Client Rendering | Strong | TanStack Virtual for message list, optimistic updates, fetch deduplication |
| Client State | Good | Zustand stores are lightweight; some unnecessary re-renders possible |
| WebSocket/Real-time | Strong | Compressed payloads, resume/replay, bounded event buffer |
| Media Pipeline | Good | Multi-candidate LiveKit connection; extensive audio diagnostics |
| Scalability | Moderate | Single-process architecture; SQLite WAL limits write concurrency |

---

### 7.1 Server Performance

#### Database Query Patterns

**Efficient Patterns:**

- **Cursor-based message pagination** (`crates/paracord-db/src/messages.rs:175-217`): Messages are paginated using snowflake ID ordering (`WHERE id < $before ORDER BY id DESC LIMIT $limit`), which is O(log n) with an index. This avoids the performance cliff of OFFSET-based pagination.

- **Snowflake ID ordering** eliminates the need for separate `created_at` indexes for chronological queries, since snowflake IDs embed timestamps.

- **CTE-based authorized operations** (`messages.rs:242-302`): Permission checks are performed inline with the data operation in a single round-trip, avoiding separate permission queries.

- **Nonce-based deduplication** (`messages.rs:103-115`): Message creation uses a unique constraint on `(channel_id, nonce)` to prevent duplicates, catching the error rather than requiring a separate SELECT.

- **Bulk delete with IN clause** (`messages.rs:396-424`): Bulk message deletion uses a dynamic IN clause (capped at 500 IDs) rather than individual deletes.

**Problematic Patterns:**

- **N+1 query in `get_user_guilds`** (`crates/paracord-db/src/guilds.rs:192-240`): For each guild with `visibility = 'roles'`, a separate query fetches member roles to check access. A user in 20 guilds with role-based visibility triggers 20+ additional queries. This is called on every READY payload and guild list fetch.

  *Recommendation:* Batch the role visibility check into a single query using a JOIN or lateral subquery that resolves visibility for all guilds at once.

- **Application-layer thread filtering** (`crates/paracord-db/src/channels.rs:320-357`): `get_channel_threads` fetches ALL threads for a channel from the database, then filters archived/active status in Rust via `thread_is_archived()`. For channels with hundreds of threads, this transfers unnecessary data.

  *Recommendation:* Add a WHERE clause filtering on `thread_metadata` archived status and `auto_archive_duration` directly in SQL.

- **Sequential channel reordering** (`channels.rs:215-226`): `reorder_channels` issues one UPDATE per channel. Reordering 30 channels in a category fires 30 sequential queries.

  *Recommendation:* Use a CASE expression in a single UPDATE: `UPDATE channels SET position = CASE id WHEN $1 THEN $2 WHEN $3 THEN $4 ... END WHERE id IN (...)`.

- **OFFSET-based user pagination** (`crates/paracord-db/src/users.rs:336-352`): `list_users_paginated` uses `OFFSET $offset LIMIT $limit`, which degrades linearly as offset increases. For 100,000 users at offset 50,000, the database must scan and discard 50,000 rows.

  *Recommendation:* Switch to cursor-based pagination using `WHERE id > $last_id ORDER BY id ASC LIMIT $limit`.

- **LIKE-based member search** (`crates/paracord-db/src/members.rs:268-291`): `search_guild_members` uses `LOWER(u.username) LIKE $pattern`, which cannot use standard B-tree indexes. For guilds with thousands of members, this results in a full table scan.

  *Recommendation:* Consider adding a trigram index (PostgreSQL `pg_trgm`) or an application-level index for member search.

#### Caching Strategy

**Permission Cache** (`crates/paracord-core/src/lib.rs:70-75`): Moka LRU cache with 10,000 entries and 5-minute TTL. Keyed by `(user_id, channel_id)`. This is well-sized for small-to-medium deployments. However, for a server with 1,000 users across 100 channels, the working set is 100,000 -- 10x the cache size. Cache hit rates will degrade at scale.

*Recommendation:* Make cache size configurable (via `config.toml`) and consider guild-level permission caching with channel-level override computation, which would reduce the key space dramatically.

**Session Cache** (`crates/paracord-ws/src/handler.rs:73-74`): Moka cache with 20,000 entries and 1-hour TTL for validated session data. This avoids repeated DB lookups for session validation on every WebSocket message. Well-sized for the connection limit of 2,000.

**MemberIndex** (`handler.rs:532-551`): In-memory index mapping guild IDs to member user IDs, used for presence fan-out. This eliminates DB queries for the most frequent operation (dispatching presence updates to guild members). Excellent design choice.

#### Connection Handling

**Global connection limit**: 2,000 concurrent WebSocket connections via atomic CAS (`handler.rs:325-342`). The atomic operation is lock-free and correct.

**Per-user connection limit**: 5 connections per user (`handler.rs:344-352`), stored in a DashMap. This prevents a single user from exhausting the connection pool.

**Bounded READY concurrency**: The READY payload (sent on WebSocket identify) fetches guild data with a `Semaphore(10)` bound (`handler.rs:609+`), preventing thundering-herd effects when many users connect simultaneously (e.g., after a server restart).

**Rate limiting**: Governor-based per-user rate limiting with keyed rate limiters (`handler.rs:356-437`). Cleanup runs every 300 seconds to prevent memory growth from departed users. The rate limits (240 msgs/min, 60 presence/min, 120 typing/min, 60 voice/min) are reasonable for normal usage.

#### Event Fan-out

**Event Bus**: Tokio broadcast channel with guild/user scoping (`paracord-core/src/events.rs`). Events carry `guild_id` and optional `target_user_ids` for efficient fan-out. Sessions are indexed by guild and user via DashMap, so dispatching to guild members is O(members) without database involvement.

**Per-event permission filtering** (`handler.rs:1364-1375`): Every channel event dispatched to a WebSocket session triggers `can_receive_channel_event`, which calls `compute_channel_permissions_cached`. This is mitigated by the Moka cache, but under high message volume with cache misses (e.g., many channels with unique permission overwrites), this becomes a bottleneck.

**Presence state contention** (`crates/paracord-core/src/lib.rs:89-90`): `online_users: Arc<RwLock<HashSet<i64>>>` and `user_presences: Arc<RwLock<HashMap<i64, Presence>>>` use tokio RwLock. Write operations (user goes online/offline, presence update) acquire exclusive locks. With hundreds of concurrent presence updates, this serialization point limits throughput.

*Recommendation:* Replace RwLock<HashMap> with DashMap for presence state, matching the pattern already used for connection tracking. DashMap provides shard-level locking, reducing contention by ~16x (default shard count).

---

### 7.2 Client Performance

#### Rendering

**Virtualized message list** (`client/src/components/message/MessageList.tsx:414-431`): Uses `@tanstack/react-virtual` with dynamic measurement (`measureElement`) and an overscan of 10 rows. This is the correct approach for long message histories -- only visible messages plus overscan are rendered in the DOM.

**Estimated row sizes** (`MessageList.tsx:417-425`): Row height estimates (28px grouped, 60px ungrouped, 48px date separator) feed the virtualizer for initial layout. Actual heights are measured via `measureElement` for accuracy. This dual approach provides fast initial render with correct final layout.

**Reply depth computation** (`MessageList.tsx:295-345`): `replyLayoutById` memoizes reply chain resolution with cycle detection and a max depth of 6. The memoization via `useMemo` keyed on `messages` prevents recomputation on unrelated re-renders.

**Potential re-render concerns:**

- `activeChannel` lookup (`MessageList.tsx:193`): `Object.values(channelsByGuild).flat().find(...)` runs on every render. This iterates all channels across all guilds to find the active one. For a user in 20 guilds with 50 channels each, this scans 1,000 entries per render.

  *Recommendation:* Add a `getChannel(channelId)` selector to the channel store that uses a Map lookup.

- `linkedThreadsByStarterMessageId` memo (`MessageList.tsx:204-224`): Iterates all channels in the active guild on every `activeGuildChannels` or `channelId` change. Acceptable since guild channel counts are typically <100.

- `mentionMap` memo (`MessageList.tsx:264-273`): Iterates all guild members. For guilds with thousands of members, this creates a large Map on every member store change. Consider using `useMemo` with a more stable dependency (member count hash) or a store-level selector.

**Excessive useState hooks** (`MessageList.tsx:227-257`): The component maintains 25+ state variables. While React batches state updates, each `setX` call still triggers re-render evaluation. Consider consolidating related state (e.g., edit state, bulk delete state, popup state) into reducer-style objects.

#### State Management

**Zustand stores** are lightweight and performant. The `useMessageStore` correctly uses:
- **Fetch deduplication** (`messageStore.ts:214`): `if (get().loading[channelId]) return` prevents concurrent fetches for the same channel.
- **AbortController per channel** (`messageStore.ts:217-222`): Aborts in-flight fetches when switching channels.
- **Optimistic updates with rollback** (`messageStore.ts:384-428`): Reactions use optimistic UI with snapshot-based rollback on failure.
- **Deduplication on add** (`messageStore.ts:558`): `if (existing.some((m) => m.id === message.id)) return state` prevents duplicate messages from gateway + REST race conditions.

**E2EE decryption overhead** (`messageStore.ts:249,565-582`): Every encrypted DM message is decrypted individually via `Promise.all(messages.map(decryptMessageForChannel))`. For bulk fetch of 50 encrypted messages, this spawns 50 concurrent crypto operations. The X25519 key derivation is CPU-intensive.

*Recommendation:* Consider batching decryption with a concurrency limit (e.g., 5 at a time) to avoid blocking the main thread. Web Workers would be ideal for offloading crypto operations.

**UI Store persistence** (`client/src/stores/uiStore.ts:103-114`): Uses `zustand/middleware/persist` with `partialize` to only persist 8 properties. This is correctly minimal -- transient state like `connectionStatus` is not persisted.

#### Bundle and Loading

**Abort-on-switch pattern** (`messageStore.ts:217-222`): When navigating between channels, the previous channel's in-flight message fetch is aborted. This prevents stale data from appearing and reduces unnecessary network traffic.

**Retry with backoff** (`messageStore.ts:229-231`): Message fetches retry up to 2 times with 300ms * attempt delay and a 5-second timeout. This handles transient network issues without overwhelming the server.

**Thread hydration caching** (`MessageList.tsx:50-51`): Thread data is cached for 5 minutes per channel via module-level `_threadHydratedAt` Map. This avoids refetching thread data on every channel visit.

---

### 7.3 WebSocket / Real-time Performance

**Compression**: The gateway supports zlib-compressed messages via `fflate` (`client/src/lib/connectionManager.ts:13`). Binary WebSocket frames are inflated client-side. This reduces bandwidth for the verbose JSON event payloads.

**Resume/Replay** (`crates/paracord-ws/src/handler.rs:79-80`): Event replay buffer holds 100 events with 5-minute max age. On reconnect, missed events are replayed from the sequence number, avoiding a full READY re-sync. Buffer sweep runs every 300 seconds.

**Heartbeat mechanism**: Server sends heartbeat requests at configurable intervals (`heartbeatInterval`). Client tracks `lastHeartbeatSent` and `missedAcks` (`connectionManager.ts:38-39`). After too many missed ACKs, the connection is considered dead and triggers reconnection.

**Reconnection with exponential backoff** (`connectionManager.ts:106-123`): Disconnected connections use exponential backoff (`5000 * 2^attempts`, max 60 seconds) for automatic recovery. The `connectAll()` method re-establishes all server connections on network recovery or tab visibility change.

**Message batching**: The `pendingMessages` buffer (`connectionManager.ts:41,47`) queues up to 200 messages when the WebSocket is not yet connected, delivering them once the connection is established.

**Latency tracking**: Round-trip latency is measured per heartbeat and exposed via `connectionLatency` in the UI store, displayed in the `ConnectionStatusBar` component.

---

### 7.4 Media Pipeline Performance

**LiveKit connection strategy** (`client/src/stores/voiceStore.ts:310-352`): The client builds a prioritized list of LiveKit endpoint candidates (server-provided URLs, env vars, proxy paths, window origin) and probes them in parallel with `Promise.any()` (`voiceStore.ts:621-630`). The first reachable endpoint wins. This is resilient to misconfigured servers and reduces connection time.

**Platform-specific connect tuning** (`voiceStore.ts:447-462`): Tauri desktop clients use more aggressive timeouts (10s WebSocket, 12s PeerConnection, 0 retries) compared to browser clients (45s, 50s, 4 retries). This accounts for WebView2's longer DNS resolution stalls while avoiding unnecessary waiting.

**Audio diagnostics** (`voiceStore.ts:834-960`): The `startLocalAudioUplinkMonitor` polls WebRTC sender stats every 2 seconds, detecting stalled mic uplinks (bytes_sent not increasing). If speech is detected locally but bytes are flat for ~8 seconds, the mic track is automatically republished. This self-healing mechanism addresses a common WebRTC failure mode.

**Remote audio reconciliation** (`voiceStore.ts:823-832`): A 1.5-second interval reconciles remote audio track attachments, catching tracks that were missed during rapid participant join/leave events.

**Voice suppression for streaming** (`voiceStore.ts:649-680`): When screen sharing with system audio, voice chat audio elements are muted/disabled to prevent echo. On Windows (Tauri), the WASAPI Process Loopback Exclusion API is used instead, which is more reliable.

**LiveKit heartbeat tuning** (`voiceStore.ts:510-522`): The client detects overly aggressive LiveKit signal ping timeouts (where `pingTimeout <= pingInterval + 1`) and adjusts them to `max(pingTimeout, pingInterval * 3, 15)` to prevent false disconnects under minor timer jitter.

**Server-side voice state** (`crates/paracord-media/src/voice.rs:54-477`): `VoiceManager` uses `RwLock<HashMap>` for room state. The `join_channel` method acquires the write lock twice in sequence -- once for `active_livekit_rooms` (line 79) and once for `rooms` (line 88). Under concurrent joins to the same channel, this creates lock contention.

*Recommendation:* Consider combining both maps into a single structure to reduce lock acquisitions, or use DashMap for shard-level locking.

---

### 7.5 Database Performance

#### SQLite Tuning (`crates/paracord-db/src/lib.rs`)

The SQLite configuration is well-optimized for a single-server deployment:
- **WAL mode**: Enables concurrent reads during writes. Essential for a multi-threaded async server.
- **busy_timeout = 5000ms**: Allows queries to wait up to 5 seconds for locks, preventing immediate SQLITE_BUSY errors.
- **synchronous = NORMAL**: Trades a small durability risk for ~2x write throughput vs. FULL. Acceptable for a chat application.
- **cache_size = -8000** (8MB): Reasonable for moderate workloads.
- **mmap_size = 67108864** (64MB): Memory-mapped I/O for faster reads on large databases.

**Missing tuning:**
- No `journal_size_limit` PRAGMA: WAL files can grow unbounded under sustained write pressure. Consider `PRAGMA journal_size_limit = 67108864` (64MB).
- No `wal_autocheckpoint` tuning: The default (1000 pages) may cause periodic latency spikes during checkpointing under high write volume.

#### PostgreSQL Tuning (`crates/paracord-db/src/lib.rs`)

- **statement_timeout**: Configurable via `PARACORD_DB_STATEMENT_TIMEOUT_MS` or config. Prevents runaway queries.
- **lock_timeout = 10s**: Prevents indefinite lock waits.
- **idle_in_transaction_session_timeout**: Configurable, prevents abandoned transactions from holding locks.

**Missing:** No `work_mem` or `maintenance_work_mem` tuning. For complex queries (FTS, JOINs with ORDER BY), PostgreSQL's default `work_mem` (4MB) may cause disk-based sorts.

#### Connection Pool

Default `max_connections = 20` (`crates/paracord-server/src/config.rs:502`). For SQLite (which serializes writes), this is reasonable. For PostgreSQL, 20 connections may be insufficient under load with 2,000 WebSocket connections. Each WebSocket READY payload triggers multiple DB queries, and the bounded concurrency semaphore of 10 means up to 10 concurrent READY sequences.

*Recommendation:* For PostgreSQL deployments, document that `max_connections` should be increased to 50-100, and consider a read-replica configuration for read-heavy operations like message history.

#### Indexing Concerns

**Full-text search** (`messages.rs:433-509`): SQLite uses FTS5, PostgreSQL uses `tsvector`. Both are well-optimized for text search. The LIKE fallback (`messages.rs:491-509`) is only used when FTS is unavailable, which is reasonable.

**Email lookup** (`users.rs:190-200`): `WHERE lower(email) = lower($1)` cannot use a standard B-tree index on the `email` column. For PostgreSQL, a functional index `CREATE INDEX idx_users_email_lower ON users (lower(email))` would help. For SQLite, the `COLLATE NOCASE` option on the column definition would enable case-insensitive lookups with index usage.

---

### 7.6 Scalability Bottlenecks

#### 1. Single-Process Architecture (High Impact)

The server runs as a single process with in-memory state (event bus, presence, voice rooms, member index, permission cache). This cannot be horizontally scaled across multiple server instances without significant architectural changes.

**Impact:** Limits deployment to a single machine. Vertical scaling caps at the machine's CPU/memory limits.

**Mitigation path:** For horizontal scaling, the in-memory state would need to be externalized to Redis (presence, sessions, rate limits) and the event bus to a message broker (NATS, Redis Pub/Sub). The current architecture is appropriate for the target audience (self-hosted communities), but limits aspirational growth.

#### 2. SQLite Write Serialization (Medium Impact)

SQLite WAL mode allows concurrent reads but serializes writes. Under high write load (many concurrent message sends, reactions, presence updates), write operations queue behind a single writer.

**Impact:** Write throughput caps at ~10,000-50,000 simple INSERTs/second on modern SSDs. This is sufficient for most self-hosted deployments but may bottleneck large communities.

**Mitigation:** PostgreSQL support is already available as a scale-up path. Document the threshold at which operators should migrate from SQLite to PostgreSQL.

#### 3. RwLock Contention on Shared State (Medium Impact)

Three critical state structures use `RwLock`:
- `online_users: Arc<RwLock<HashSet<i64>>>` (`lib.rs:89`)
- `user_presences: Arc<RwLock<HashMap<i64, Presence>>>` (`lib.rs:90`)
- Voice rooms: `RwLock<HashMap<i64, VoiceRoom>>` (`voice.rs:35`)

Every presence update and voice state change acquires a write lock, serializing all concurrent updates. With 1,000 online users and frequent presence changes, this becomes a contention hotspot.

**Mitigation:** Replace with DashMap, which uses shard-level locking (16 shards by default). This is already the pattern used for connection tracking (`DashMap<String, Vec<WsSender>>` in the event bus).

#### 4. N+1 Query Patterns (Medium Impact)

The `get_user_guilds` N+1 pattern fires on every WebSocket READY and guild list API call. A user in 20 role-restricted guilds triggers 21 queries. During a server restart with 200 concurrent reconnections (via resume), this becomes 4,200 queries in a short burst.

**Mitigation:** Batch the role check into a single query using a JOIN, reducing 21 queries to 1.

#### 5. Permission Cache Working Set (Low-Medium Impact)

The 10,000-entry permission cache may be undersized for deployments with many users and channels. A cache miss triggers a DB query to recompute permissions (involving role lookups, channel overwrites, and guild membership checks).

**Mitigation:** Make cache size configurable and add cache hit rate metrics. Consider hierarchical caching (guild-level base permissions + channel-level overwrites).

#### 6. Event Buffer Memory (Low Impact)

The event replay buffer stores 100 events per session with a 5-minute TTL. With 2,000 connections, worst case is 200,000 buffered events. At ~1KB per event, this is ~200MB -- significant but manageable.

The buffer sweep runs every 300 seconds, meaning stale entries can accumulate between sweeps. Under bursty workloads, memory usage may spike.

---

### 7.7 Prioritized Performance Recommendations

#### High Priority

1. **Fix N+1 in `get_user_guilds`** (`crates/paracord-db/src/guilds.rs:192-240`): Replace the per-guild role visibility query loop with a single JOIN query. This directly impacts every user login and reconnection. Estimated improvement: 20x fewer queries for the READY payload of users in role-restricted guilds.

2. **Replace RwLock with DashMap for presence state** (`crates/paracord-core/src/lib.rs:89-90`): The `online_users` and `user_presences` RwLock-based structures are write-contention bottlenecks. DashMap provides shard-level locking with minimal API change. Estimated improvement: ~16x reduction in lock contention for concurrent presence updates.

3. **Move thread filtering to SQL** (`crates/paracord-db/src/channels.rs:320-357`): Add WHERE clause for archived status in `get_channel_threads` and `get_archived_threads` instead of fetching all threads and filtering in Rust. Reduces data transfer and memory allocation for channels with many threads.

#### Medium Priority

4. **Batch channel reordering** (`channels.rs:215-226`): Replace sequential per-channel UPDATE with a single CASE-based UPDATE statement. Reduces query count from N to 1 when reordering channels.

5. **Replace OFFSET pagination with cursor pagination** (`users.rs:336-352`): Admin user listing degrades at large offsets. Switch to `WHERE id > $cursor` pattern already used for messages.

6. **Make permission cache size configurable**: Add `permission_cache_max_entries` to `config.toml`. The current 10,000 hard-coded limit may be too small for larger deployments.

7. **Add channel lookup by ID** in the client channel store: The `Object.values(channelsByGuild).flat().find()` pattern in `MessageList.tsx:193` scans all channels on every render. Add a `channelById: Map<string, Channel>` index to the store.

8. **Offload E2EE decryption to Web Worker** (`messageStore.ts:249`): Bulk decryption of 50 encrypted messages blocks the main thread with CPU-intensive X25519 operations. A Web Worker would keep the UI responsive during decryption.

#### Low Priority

9. **Add SQLite WAL size limit**: Set `PRAGMA journal_size_limit = 67108864` to prevent unbounded WAL growth under sustained write pressure.

10. **Add PostgreSQL `work_mem` tuning**: For complex queries (FTS, JOINs with ORDER BY), increase `work_mem` from the default 4MB to 16-32MB per connection to avoid disk-based sorts.

11. **Document SQLite-to-PostgreSQL migration threshold**: Provide guidance on when operators should migrate (e.g., >500 concurrent users, >1M messages, or observed busy_timeout warnings in logs).

12. **Consolidate MessageList state**: The 25+ `useState` hooks in `MessageList.tsx` could be consolidated into 3-4 `useReducer` calls (edit state, bulk delete state, popup state), reducing re-render evaluation overhead.

13. **Add cache hit rate metrics** for the permission cache and session cache. This would help operators identify when cache sizes need to be increased.

14. **Consider DashMap for VoiceManager rooms** (`crates/paracord-media/src/voice.rs:35`): The `join_channel` method acquires the rooms write lock twice. DashMap would allow per-shard locking and reduce contention during concurrent voice joins.

<!-- END SECTION: performance -->

---

<!-- SECTION: code-quality -->
## 8. Code Quality & Architecture

### 8.1 Code Organization

**Rust Workspace Structure (13 crates)**

The server is split into 13 workspace crates under `crates/`, following a layered architecture:

| Layer | Crates | Role |
|-------|--------|------|
| Leaf (no workspace deps) | `paracord-models`, `paracord-util` | Shared types, snowflake IDs, validation, encryption |
| Data | `paracord-db` | SQLx database layer (dual SQLite/PostgreSQL) |
| Infrastructure | `paracord-media`, `paracord-federation`, `paracord-codec`, `paracord-transport`, `paracord-relay` | Storage, voice, federation, media encoding, QUIC transport |
| Business Logic | `paracord-core` | Event bus, permissions, presence, AppState |
| HTTP | `paracord-api`, `paracord-ws` | REST routes, WebSocket gateway |
| Entry Point | `paracord-server` | Config, startup, background tasks |
| Dev Tooling | `paracord-media-dev` | Standalone media transport test server |

Dependency flow is generally clean: `models/util` -> `db` -> `core` -> `api/ws` -> `server`. However, `paracord-core` acts as a "god crate" with **8 workspace dependencies** (db, federation, media, models, util, relay, transport, codec indirectly), making it a convergence point that could become a bottleneck for compilation and refactoring.

**Client Organization**

The Tauri v2 client under `client/` follows a standard React SPA layout:
- `src/api/` -- API client modules (auth, channels, guilds, dms, voice, tenor)
- `src/stores/` -- Zustand v5 stores, one per domain (auth, guild, message, channel, voice, ui, folder)
- `src/components/` -- React components organized by feature (layout, message, guild, voice, channel, user, customization)
- `src/hooks/` -- Custom hooks (useVoice, useTheme, useKeyboardNavigation, useActivityPresence, useVoiceKeybinds)
- `src/lib/` -- Utilities (markdown, auth token, connection manager, DM E2EE, media engine)
- `src/pages/` -- Top-level page components (AppLayout, GuildPage, DMPage, LoginPage, ServerConnectPage)
- `src/types/index.ts` -- Single 533-line file with all shared interfaces and enums
- `src/gateway/` -- WebSocket gateway client with resume/replay support

The single `types/index.ts` file (533 lines) is a minor concern -- splitting into domain-specific type files would improve maintainability.

### 8.2 Error Handling

**Rust: Three-Layer Error Hierarchy**

The server uses a clean, layered error propagation pattern:

1. **`DbError`** (`crates/paracord-db/src/lib.rs`): Database-level errors -- `NotFound`, `Conflict(String)`, `Internal(String)`, plus `#[from] sqlx::Error`.

2. **`CoreError`** (`crates/paracord-core/src/error.rs`): Business logic errors -- `NotFound`, `Forbidden`, `MissingPermission`, `BadRequest(String)`, `Conflict(String)`, `RateLimited(i64)`, `Internal(String)`, plus `#[from] DbError`.

3. **`ApiError`** (`crates/paracord-api/src/error.rs`): HTTP response errors implementing `IntoResponse`. Maps each variant to appropriate HTTP status codes with machine-readable error codes (e.g., `"FORBIDDEN"`, `"RATE_LIMITED"`). Includes `From<CoreError>` and `From<DbError>` conversions.

Strengths:
- Internal errors are logged via `tracing::error!` and return generic messages to clients (no information leakage).
- The `?` operator propagates errors ergonomically through all layers.
- Machine-readable error codes enable programmatic client-side handling.
- `RateLimited` variant carries retry-after seconds for slowmode channels.

**Client Error Handling**

The client API layer (`client/src/api/client.ts`) uses axios interceptors for:
- Automatic 401 handling with token refresh
- Per-server API client factory pattern
- Connection state tracking

Error handling in stores is generally try/catch with console.error logging. There is no centralized error reporting or user-facing error toast system beyond the `ConnectionStatusBar` component.

### 8.3 Test Coverage & Quality

**Rust Integration Tests**

Five integration test files in `crates/paracord-api/tests/`:

| File | Tests | Coverage Area |
|------|-------|---------------|
| `channel_message_routes.rs` | 4 | Guild/channel/message/thread CRUD |
| `bot_system_routes.rs` | ~20 | Full bot lifecycle, command registration, interactions |
| `security_federation_regressions.rs` | 5 | Federation security (SSRF, path traversal, origin validation) |
| `voice_routes.rs` | 6 | Voice channel join/leave, token generation |
| `rate_limit_regressions.rs` | 1 | Auth endpoint rate limiting |

All integration tests use an in-memory SQLite `TestContext` pattern with Tower's `oneshot()` for request dispatch -- no actual HTTP server needed. This is fast and deterministic.

**Coverage Gaps:**
- No integration tests for DM routes, user settings, emoji management, webhooks, audit logs, or guild template routes.
- Only 1 rate limit test despite the server having multiple rate limit tiers (global 120/s, auth 60/min, bot 300/min).
- No tests for WebSocket gateway behavior (connect, disconnect, resume, event dispatch).
- No tests for permission-denied scenarios across routes.

**Rust Unit Tests**

58 files contain `#[cfg(test)]` modules, primarily in the `paracord-db` crate for inline database operation tests. The `paracord-models` crate has permission flag tests.

**Client Tests**

23 test files (`*.test.ts` / `*.test.tsx`) covering stores and some components. Notable: `authStore.test.ts` (302 lines, 14 tests) demonstrates the established pattern -- `vi.mock()` for API modules, store state reset in `beforeEach`, assertions via `useStore.getState()`.

1 E2E spec file (`client/e2e/smoke.spec.ts`) using Playwright for basic smoke testing.

**CI Test Infrastructure**

- Rust tests run in CI (`cargo test --workspace`) with SQLite only -- PostgreSQL tests are not run in CI.
- Client tests: typecheck + Vitest unit tests + Playwright E2E.
- **No code coverage reporting** in any CI workflow. No coverage thresholds or tracking.

### 8.4 Type Safety

**Rust**

- **`unsafe` blocks**: 17 occurrences, **all confined to `paracord-codec`** for FFI with libvpx (VP9 encoding/decoding) and `Send`/`Sync` impl for FFI pointer wrappers. This is appropriate -- FFI requires unsafe, and it is properly isolated in a single crate.
- **`todo!()` / `unimplemented!()`**: 0 occurrences. No incomplete code paths.
- **`.unwrap()` calls**: **549 total across 38 files**. Distribution:
  - `paracord-db`: **331 calls** -- primarily in `sqlx::Row::get()` column extraction. These will panic on schema mismatches. Using `try_get()` with proper error propagation would be safer.
  - `paracord-api` routes: 4 calls (mostly in test helpers).
  - `paracord-core`: 0 calls -- the business logic layer is unwrap-free.
  - `paracord-server`: Moderate usage in config parsing and startup (acceptable for fail-fast initialization).
  - `paracord-codec`: FFI wrappers with unwrap on CString creation (acceptable).

- **Snowflake IDs**: Used as bare `i64` throughout. No newtype wrapper (e.g., `UserId(i64)`, `GuildId(i64)`) to prevent accidentally passing a user ID where a guild ID is expected. This is a common source of subtle bugs in large codebases.

**TypeScript**

- **`: any` annotations**: 35+ occurrences across client code. Notable locations:
  - `client/src/types/index.ts` line 37: `[key: string]: any` on Guild interface
  - `client/src/types/index.ts` line 57: `bot_settings?: any`
  - Multiple `any` in gateway event handlers, voice hooks, and message components
  - Several store files use `any` for event payloads from the WebSocket gateway
- **`as any` type assertions**: Only 2 occurrences -- relatively disciplined.
- The `types/index.ts` file defines proper interfaces for most entities, but the `any` escape hatches undermine type safety for guild metadata and bot settings.

### 8.5 Code Duplication

**Test Context Duplication**

Each of the 5 integration test files in `crates/paracord-api/tests/` contains its own `TestContext` struct and setup code (~100 lines each, ~500 lines total). This includes:
- In-memory SQLite pool creation
- Migration execution
- Temp directory setup for storage
- AppState construction with all 18 fields
- Helper methods for creating test users, guilds, channels
- JWT token generation

This should be extracted into a shared `test-utils` crate or a `tests/common/mod.rs` module.

**Database Query Patterns**

The `paracord-db` crate has repetitive patterns for SQLite vs PostgreSQL query branching. Each function checks `db_engine()` and runs nearly identical queries with minor syntax differences (e.g., `RETURNING` clauses, `?` vs `$1` placeholders). This is an inherent cost of dual-database support but could be reduced with a query builder or macro.

### 8.6 Dependency Management

**Rust (Cargo.toml)**

- Workspace-level dependency declarations in root `Cargo.toml` with 40+ shared dependencies -- good practice for version consistency.
- Version: 0.9.0, Rust 1.88+ (MSRV), edition 2021.
- Key dependencies are at current versions: axum 0.8, tokio 1, sqlx 0.8, serde 1, quinn 0.11.
- `moka` for caching, `dashmap` for concurrent maps, `jsonwebtoken` for JWT -- all well-maintained crates.
- `paracord-relay` and `paracord-transport` use path dependencies (`{ path = "../..." }`) rather than workspace references in some Cargo.toml files -- inconsistent but functional.

**Client (package.json)**

- 24 production dependencies, 14 dev dependencies.
- React 19, Zustand 5, Vite 6, Tailwind CSS 4 -- all latest major versions.
- `@tauri-apps/api` and `@tauri-apps/plugin-*` for native integration.
- `axios` for HTTP, `emoji-mart` for emoji picker, `katex` for math rendering, `highlight.js` for syntax highlighting.
- Uses exact versions (no `^` ranges visible) for some deps, workspace protocol for Tauri plugins.
- No `package-lock.json` issues noted; lockfile is present.

### 8.7 Documentation Quality

- **`CLAUDE.md`**: Comprehensive project guide covering build commands, architecture, testing patterns, configuration, and code style. Well-maintained and accurate.
- **Inline comments**: Sparse but present where needed. Struct fields in `AppState` and `AppConfig` have doc comments. Route handlers generally lack doc comments.
- **`TODO` / `FIXME` / `HACK` comments**: Only 2 `TODO` markers found (in Tauri native media module) and 1 formatting comment. The codebase is remarkably clean of abandoned notes.
- **No API documentation**: No OpenAPI/Swagger spec, no auto-generated API docs. The 150+ REST endpoints are documented only by reading route handler code.
- **No README.md**: The repository lacks a user-facing README (CLAUDE.md serves as developer documentation but is not a substitute).

### 8.8 CI/CD Assessment

Four GitHub Actions workflows:

1. **`ci.yml`** (main CI): Security gate (cargo-audit, npm audit) -> Rust (check, clippy, fmt, test) -> Client (typecheck, unit tests) -> E2E (Playwright). Runs on push to main and PRs. Uses `cargo clippy -- -D warnings` (warnings as errors). Matrix strategy not used (single OS).

2. **`security-audit.yml`**: Weekly cron + manual trigger. Runs `cargo audit` and `npm audit`. Separate from main CI to avoid blocking PRs on upstream vulnerability disclosures.

3. **`security-dast-fuzz.yml`**: DAST testing against a live server instance. Runs fuzzing and security scanning. Triggered manually.

4. **`release.yml`**: Tag-triggered multi-platform release build. Builds for Windows, macOS, and Linux. Produces Tauri installer bundles.

**CI Gaps:**
- **No code coverage** reporting or enforcement.
- **No PostgreSQL CI tests** -- only SQLite is tested. PostgreSQL-specific query bugs would not be caught.
- **No Docker build** step in CI. No container image publishing.
- **No dependency caching** optimization visible (Rust builds are slow without cached target dirs).
- **No performance/benchmark** tests in CI.
- **Single-OS testing** -- the main CI does not test across Windows/macOS/Linux despite being a cross-platform desktop app.

### 8.9 Architecture Improvements

**Recommended Refactorings:**

1. **Extract shared test utilities**: Create a `paracord-test-utils` crate (or `tests/common/`) to eliminate ~500 lines of duplicated `TestContext` code across 5 integration test files.

2. **Introduce newtype wrappers for IDs**: Replace bare `i64` snowflake IDs with `UserId(i64)`, `GuildId(i64)`, `ChannelId(i64)`, etc. This provides compile-time protection against ID type confusion at minimal runtime cost.

3. **Reduce `paracord-core` dependencies**: The core crate depends on 8 workspace crates. Extract `AppState` construction and `NativeMediaState` into `paracord-server` (where they are consumed), leaving `paracord-core` focused on business logic, events, and permissions.

4. **Replace `.unwrap()` in `paracord-db`**: The 331 `.unwrap()` calls on `sqlx::Row::get()` should use `try_get()` with `?` to produce proper `DbError::Internal` instead of panicking on schema mismatches.

5. **Split `types/index.ts`**: Break the 533-line monolithic type file into domain-specific modules (`guild.types.ts`, `message.types.ts`, `channel.types.ts`, etc.).

6. **Eliminate TypeScript `any` types**: Replace the 35+ `: any` annotations with proper types, especially in `types/index.ts` (Guild metadata, bot settings) and gateway event handlers.

7. **Add API documentation**: Generate OpenAPI spec from route definitions (e.g., using `utoipa` crate) for client SDK generation and developer documentation.

### 8.10 Prioritized Recommendations

| Priority | Item | Impact | Effort |
|----------|------|--------|--------|
| **High** | Replace 331 `.unwrap()` in `paracord-db` with `try_get()` | Prevents panics on schema mismatches; improves server stability | Medium |
| **High** | Extract shared test context into reusable module | Unblocks faster test development; reduces 500 lines of duplication | Low |
| **High** | Add PostgreSQL CI testing | Catches DB-engine-specific bugs before production | Low |
| **Medium** | Add code coverage to CI | Tracks test coverage trends; identifies untested code paths | Low |
| **Medium** | Introduce snowflake ID newtypes | Compile-time safety for entity ID parameters | Medium |
| **Medium** | Eliminate TypeScript `any` annotations | Improves client type safety; catches bugs at compile time | Low |
| **Medium** | Add integration tests for DMs, webhooks, audit, permissions | Closes major coverage gaps in API testing | Medium |
| **Low** | Split `types/index.ts` into domain modules | Improves client code organization | Low |
| **Low** | Reduce `paracord-core` dependency fan-out | Faster incremental compilation; cleaner architecture | High |
| **Low** | Generate OpenAPI documentation | Enables client SDK generation; improves developer onboarding | Medium |

<!-- END SECTION: code-quality -->

---

*Report generated by Paracord Analysis Team*
