# README Screenshot Plan — v1.0.0

> Inventory of every user-facing UI surface in the Paracord client for recapturing
> README screenshots under `assets/readme/`. Replaces pre–Emerald Commons captures in
> `docs/screenshots/`. **Do not edit README.md in this pass** — capture only.

**Routing source:** `client/src/App.tsx`  
**Layout IA:** `docs/layout-spec.md` (AppShell + UnifiedSidebar + ContextPanel + RoomsView)  
**Visual law:** `docs/design-spec.md` (Emerald Commons, dark theme default)

---

## Capture defaults

| Setting | Value |
|---|---|
| Theme | Dark (default) |
| Accent | Emerald (default preset) |
| Desktop viewport | 1440×900 (or 1280×800 minimum) |
| Mobile viewport | 390×844 (iPhone 14 class; triggers `useMobile()` ≤768px) |
| Browser | Chromium-based; Tauri desktop optional for native-media voice shots |
| Density | Default (`data-density` unset) |

Clear `localStorage` keys `paracord:layout-tour:*` before shell/guild-home tour shots if you need a clean chrome (or dismiss tours first).

---

## Demo seed prerequisites

Use a single “showcase” server with rich content. Suggested minimum:

| Requirement | Why |
|---|---|
| Logged-in user with display name + avatar | Home greeting, sidebar UserPanel, chat author rows |
| ≥1 guild joined, user is owner or has `MANAGE_GUILD` | Guild settings, Rooms admin gear, economy panel |
| Guild has: 2+ text channels (1 with messages, 1 with @mention unread), 1 forum, 1 voice, 1 stage | Text chat, forum, voice lobby, stage surfaces |
| ≥2 members online (or fake via second account) | Member list, Around Now strip, speaking rings |
| ≥1 friend + 1 pending friend request | Friends page tabs |
| ≥1 DM + 1 group DM with messages | DM list + group members panel |
| Voice channel with 1–2 occupants (second client) | Live RoomCard, voice lobby, optional stream |
| Pinned messages + active thread in a text channel | Context panel pins/threads |
| Server admin flag (`isAdmin`) for control plane | Admin page |
| ≥1 bot application created | Developer portal |
| Discovery enabled on server (if operator feature) | Discovery page populated |

**Quick paths**

- User settings overlay: `Ctrl+,` or UserPanel → Settings; mobile: bottom-nav Settings tab
- Guild settings overlay: Guild Home header gear or `Ctrl+Shift+,`
- Command palette: `Ctrl+K` / `⌘K` or SidebarSearch field
- Context panel: TopBar icon cluster (members / threads / pins / search / economy)

---

## 1. Public & auth routes (outside AppShell)

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/connect` | `server-connect.png` | Server URL connect card on auth canvas; optional demo-server hint visible | Logged out; clear stored server URL or use fresh profile |
| **Must-have** | `/login` | `login.png` | “Welcome back” login form with email/username + password fields | Logged out; server connected (`/health` OK) |
| **Must-have** | `/register` | `register.png` | Registration form (username, display name, password, terms checkbox) | Logged out; server connected |
| Nice-to-have | `/setup` | `account-setup.png` | Device crypto identity setup (create + recovery phrase step) | `crypto_auth_enabled` flow or navigate directly; logged out |
| Nice-to-have | `/unlock` | `account-unlock.png` | Device key unlock prompt | Crypto-auth account exists, locked |
| Nice-to-have | `/recover` | `account-recover.png` | Recovery phrase entry | Crypto-auth account |
| Nice-to-have | `/invite/:code` | `invite-preview.png` | Invite preview card (guild icon, name, member count, Accept CTA) | Valid invite code; logged in or logged out variant |
| Nice-to-have | `/terms` | `terms.png` | Legal document page | None |
| Nice-to-have | `/privacy` | `privacy.png` | Privacy policy page | None |

---

## 2. App Home & unified sidebar

| Priority | Route / action | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/app` | `home.png` | App Home: greeting, live DM calls section (or empty state), friends-around strip, recent DMs, quick actions (Create server, Discovery) | Logged in; DM + friend data seeded |
| **Must-have** | `/app` (sidebar expanded) | `sidebar-unified.png` | Full UnifiedSidebar: SidebarSearch, NeedsYou (with ≥1 attention row), PinnedRail (optional), RecentList, SpacesList, UserPanel footer | Unreads/mentions on at least one row; sidebar not collapsed |
| Nice-to-have | `/app` (`Ctrl+B` collapse) | `sidebar-collapsed.png` | 64px icon rail: space avatars, mini CallDock if in call, user avatar | Desktop width; collapse sidebar |
| Nice-to-have | `/app` (first visit) | `layout-tour-shell.png` | LayoutTour coach-mark on sidebar or ⌘K search anchor | Clear `paracord:layout-tour:shell` storage key |

---

## 3. Friends & DMs

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/app/friends` | `friends-online.png` | Friends page, **Online** tab with friend rows + presence dots | ≥1 online friend |
| Nice-to-have | `/app/friends` (tab) | `friends-requests.png` | **Pending** tab with incoming request actions | Pending inbound request |
| Nice-to-have | `/app/friends` (tab) | `friends-all.png` | **All** tab | Several friends |
| **Must-have** | `/app/dms` | `dms-empty.png` | DM hub empty/landing state with “Start a conversation” CTA | No DM selected (`/app/dms` without `:channelId`) |
| **Must-have** | `/app/dms/:channelId` | `dm-chat.png` | 1:1 DM ChatView: TopBar (avatar + name), MessageList with grouped messages, MessageInput | Active DM with message history |
| Nice-to-have | `/app/dms/:groupChannelId` | `group-dm-chat.png` | Group DM chat with multiple authors | Group DM channel |
| Nice-to-have | DM TopBar → members toggle | `context-panel-group-members.png` | ContextPanel **members** mode for group DM | Group DM open; toggle members |

---

## 4. Guild Home (Rooms view)

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/app/guilds/:guildId` | `guild-rooms.png` | RoomsView: GuildHomeHeader (Fraunces guild name, who’s-around summary), LiveRoomsGrid with ≥1 **live** RoomCard (OccupantStack + speaking ring), AroundNowStrip, TextChannelList with categories/unread dots | Voice channel occupied; guild selected |
| Nice-to-have | `/app/guilds/:guildId` | `guild-rooms-quiet.png` | Quiet/empty voice room compact row (“Empty — start the room”) | Voice channel with 0 occupants |
| Nice-to-have | `/app/guilds/:guildId` | `guild-rooms-stream.png` | RoomCard **stream** state with Watch affordance | User streaming in voice channel |
| Nice-to-have | `/app/guilds/:guildId` (first visit) | `layout-tour-guild-home.png` | LayoutTour coach-mark on live-rooms region | Clear `paracord:layout-tour:guild` key |
| Nice-to-have | Guild Home → Create guild modal | `create-guild-modal.png` | CreateGuildModal over Rooms/home | Click “Create server” from Home or SpacesList |

---

## 5. Guild text & forum channels (ChatView)

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/app/guilds/:guildId/channels/:textChannelId` | `guild-text-channel.png` | Text channel ChatView: TopBar breadcrumb (`Guild / #channel`), message feed with author grouping, mention styling, MessageInput + markdown toolbar visible on hover/focus | `#general` or similar with 10+ messages, 1 @mention |
| Nice-to-have | Same route | `guild-text-channel-hover-toolbar.png` | Message hover action toolbar (react, reply, pin, …) | Hover a message row |
| Nice-to-have | Same route | `message-lightbox.png` | Image lightbox over chat (zoom/pan chrome) | Message with image attachment; click to open (`AppProviders` ImageLightbox) |
| **Must-have** | `/app/guilds/:guildId/channels/:forumChannelId` | `guild-forum.png` | ForumView: tag filters, grid/list layout toggle, thread cards | Forum channel (type 7) with ≥2 posts |
| Nice-to-have | Forum → new post modal | `forum-create-post.png` | Create-thread modal in forum | Click “New post” |

---

## 6. Voice, stage & streaming

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/app/guilds/:guildId/channels/:voiceChannelId` (not joined) | `voice-lobby.png` | VoiceLobby: channel name, participant avatars, Join button, VoiceControlBar absent pre-join | Navigate to voice channel before joining |
| Nice-to-have | Same route (joined) | `voice-channel.png` | Connected voice UI: VideoGrid and/or participant tiles, VoiceControlBar (mute/deafen/screen share), optional VoiceChatSidebar | Join voice with 2+ clients |
| **Must-have** | `/app/guilds/:guildId/channels/:stageChannelId` | `stage-channel.png` | Stage channel: stage topic, speaker vs audience layout, stage controls (if mod) | Stage channel (type 13); stage instance live |
| Nice-to-have | Voice channel (stream active) | `stream-viewer.png` | StreamViewer with quality selector, volume, fullscreen; or SplitPane layout | Screen share from second client; click Watch from RoomCard |
| Nice-to-have | `/app` or guild (in call) | `call-dock.png` | Sidebar CallDock (desktop) or MiniVoiceBar (mobile) while connected | Join any voice channel |

---

## 7. Context panel (right panel — not standalone routes)

Toggle from TopBar while in a guild text channel unless noted.

| Priority | Action | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | Members toggle | `context-panel-members.png` | ContextPanel **members** mode: grouped member list with presence, roles | Guild text channel; ≥5 members |
| **Must-have** | Threads toggle | `context-panel-threads.png` | ContextPanel **threads** mode: thread list + active thread panel | Channel with threads; open one thread |
| **Must-have** | Pins toggle | `context-panel-pins.png` | Pinned messages list in panel | ≥2 pinned messages in channel |
| Nice-to-have | Search toggle | `context-panel-search.png` | In-channel search results panel | Search query with hits |
| Nice-to-have | Economy toggle | `context-panel-economy.png` | GuildEconomyPanel (balances, shop) | Economy enabled; `MANAGE_GUILD` or participant with balance |

---

## 8. TopBar overlays (popovers — not routes)

| Priority | Action | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | Inbox icon | `inbox.png` | InboxOverlay with ≥1 unread mention/item | Mentions or inbox items seeded |
| Nice-to-have | Help icon (desktop) | `help-shortcuts.png` | HelpOverlay keyboard shortcut reference | Any chat view |
| Nice-to-have | Summary icon | `channel-summary.png` | AI Catch Up Summary overlay | Channel with messages; summary provider configured |
| Nice-to-have | Follows icon | `channel-follows.png` | Channel Follows overlay | Followed threads/channels configured |

---

## 9. Command palette

| Priority | Action | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `Ctrl+K` / `⌘K` | `command-palette.png` | Command palette open with placeholder “Jump to a channel, space, or setting…” and categorized results (channels, spaces, navigation) | Any authenticated shell view; type partial query e.g. `gen` |

---

## 10. User settings (overlay)

Opened via `Ctrl+,`, UserPanel, or mobile bottom-nav **Settings**. Not a dedicated route.

| Priority | Section | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | Account | `user-settings-account.png` | My Account: public profile fields, security section visible | Default open section |
| **Must-have** | Appearance | `user-settings-appearance.png` | Theme picker (dark/light/amoled/high-contrast), accent presets, density | Switch to Appearance section |
| Nice-to-have | Voice & Video | `user-settings-voice.png` | Input/output device selectors, noise suppression toggles | Mic devices available |
| Nice-to-have | Notifications | `user-settings-notifications.png` | Notification preference toggles | — |
| Nice-to-have | Keybinds | `user-settings-keybinds.png` | Keybind editor | — |
| Nice-to-have | Identity | `user-settings-identity.png` | Identity portability / crypto auth settings | — |
| Nice-to-have | About | `user-settings-about.png` | Version info, links | — |

---

## 11. Guild settings (overlay or route)

Opened via Guild Home gear, `Ctrl+Shift+,`, or route `/app/guilds/:guildId/settings`. Prefer **overlay** for README consistency with shell chrome.

| Priority | Section | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | Overview | `guild-settings-overview.png` | Server name/icon, moderation level, default notification settings | `MANAGE_GUILD` permission |
| **Must-have** | Channels | `guild-settings-channels.png` | Channel list editor with categories | Several channels |
| Nice-to-have | Roles | `guild-settings-roles.png` | Role list + permission toggles | ≥2 roles |
| Nice-to-have | Members | `guild-settings-members.png` | Member management table | Several members |
| Nice-to-have | Invites | `guild-settings-invites.png` | Invite link list | Active invite |
| Nice-to-have | Bot Store | `guild-settings-bot-store.png` | BotStoreSection marketplace | Bot store entries on server |
| Nice-to-have | Economy | `guild-settings-economy.png` | EconomySettingsSection | Economy feature on |
| Nice-to-have | Audit Log | `guild-settings-audit-log.png` | Recent audit entries | Admin actions logged |

---

## 12. Discovery, templates & developer surfaces

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| Nice-to-have | `/app/discovery` | `discovery.png` | Discoverable guild grid with search + category chips | Server discovery API populated |
| Nice-to-have | `/app/templates` | `templates.png` | Template gallery with template detail + apply form | ≥1 guild template on server |
| Nice-to-have | `/app/developers` | `developer-portal.png` | DeveloperPage: bot app list + CreateBotForm | ≥1 bot application owned |
| Nice-to-have | `/app/developers` (expanded) | `developer-bot-detail.png` | BotAppCard expanded: token, installs, commands/intents tabs | Expand an app |
| Nice-to-have | `/app/oauth2/authorize?client_id=…&guild_id=…&scope=…` | `bot-authorize.png` | OAuth consent screen with scoped permissions grouped by risk | Valid bot OAuth URL params |

---

## 13. Admin control plane

| Priority | Route | Filename | What to show | Setup |
|---|---|---|---|---|
| Nice-to-have | `/app/admin` | `admin-overview.png` | Admin OverviewPanel stats dashboard | User has admin flag |
| Nice-to-have | `/app/admin` (tab) | `admin-users.png` | Users panel | Admin access |
| Nice-to-have | `/app/admin` (tab) | `admin-guilds.png` | Guilds panel | Admin access |
| Nice-to-have | `/app/admin` (tab) | `admin-security.png` | Security panel | Admin access |

> Skip admin captures if demo user is not a server administrator — the page shows “Access denied”.

---

## 14. Mobile layout (≤768px)

Re-capture key must-haves at mobile viewport. Bottom nav: Home / DMs / Server / Friends / Settings.

| Priority | Route / action | Filename | What to show | Setup |
|---|---|---|---|---|
| **Must-have** | `/app` | `mobile-home.png` | Home stacked layout + MobileBottomNav; sidebar hidden | Mobile viewport |
| **Must-have** | `/app` (swipe right or hamburger) | `mobile-sidebar-overlay.png` | UnifiedSidebar as left overlay over content | Open sidebar overlay |
| **Must-have** | `/app/guilds/:guildId/channels/:textChannelId` | `mobile-chat.png` | Compact TopBar, full-width chat, bottom nav; ContextPanel closed | Mobile viewport |
| Nice-to-have | `/app/guilds/:guildId` | `mobile-guild-rooms.png` | RoomsView single-column stack | Mobile viewport |
| Nice-to-have | In voice (mobile) | `mobile-voice-bar.png` | MiniVoiceBar docked at bottom over nav | Join voice on mobile |
| Nice-to-have | Swipe left | `mobile-context-panel.png` | ContextPanel members overlay from right | Mobile chat view |

---

## 15. Ephemeral UI (nice-to-have polish)

| Priority | Trigger | Filename | What to show | Setup |
|---|---|---|---|---|
| Nice-to-have | Click author in chat | `user-profile-popup.png` | UserProfilePopup card (avatar, roles, message/DM actions) | Guild channel message |
| Nice-to-have | First guild join | `guild-welcome.png` | GuildWelcomeScreen overlay | Clear `guild-welcomed:{guildId}` storage |
| Nice-to-have | Onboarding gate | `guild-onboarding.png` | GuildOnboardingGate checklist | Guild with incomplete onboarding |
| Nice-to-have | Sidebar → new DM | `dm-picker-modal.png` | DmPickerModal user search | Open from Home or SidebarSearch |
| Nice-to-have | Toast | `toast-notification.png` | ToastContainer success/info toast | Trigger any toast action |

---

## Priority summary

### Must-have (25 captures)

`server-connect`, `login`, `register`, `home`, `sidebar-unified`, `friends-online`, `dms-empty`, `dm-chat`, `guild-rooms`, `guild-text-channel`, `guild-forum`, `voice-lobby`, `stage-channel`, `context-panel-members`, `context-panel-threads`, `context-panel-pins`, `inbox`, `command-palette`, `user-settings-account`, `user-settings-appearance`, `guild-settings-overview`, `guild-settings-channels`, `mobile-home`, `mobile-sidebar-overlay`, `mobile-chat`

### Nice-to-have (everything else in tables above)

---

## Complete route table (from `client/src/App.tsx`)

| Path | Element | Screenshot section |
|---|---|---|
| `/setup` | `AccountSetupPage` | §1 |
| `/unlock` | `AccountUnlockPage` | §1 |
| `/recover` | `AccountRecoverPage` | §1 |
| `/connect` | `ServerConnectPage` | §1 |
| `/login` | `LoginPage` | §1 |
| `/register` | `RegisterPage` | §1 |
| `/invite/:code` | `InvitePage` | §1 |
| `/terms` | `TermsPage` | §1 |
| `/privacy` | `PrivacyPage` | §1 |
| `/app` | `HomePage` | §2 |
| `/app/guilds/:guildId` | `GuildHomePage` → `RoomsView` | §4 |
| `/app/guilds/:guildId/settings` | `GuildSettingsPage` | §11 |
| `/app/guilds/:guildId/channels/:channelId` | `GuildPage` (text / forum / voice / stage) | §5–6 |
| `/app/dms` | `DMPage` | §3 |
| `/app/dms/:channelId` | `DMPage` | §3 |
| `/app/friends` | `FriendsPage` | §3 |
| `/app/admin` | `AdminPage` | §13 |
| `/app/discovery` | `DiscoveryPage` | §12 |
| `/app/templates` | `TemplateGalleryPage` | §12 |
| `/app/oauth2/authorize` | `BotAuthorizePage` | §12 |
| `/app/developers` | `DeveloperPage` | §12 |
| `/media-test` | `MediaTest` (dev only) | Out of scope |

**Shell overlays (not routes):** CommandPalette (§9), ContextPanel modes (§7), UserSettings overlay (§10), GuildSettings overlay (§11), TopBar popovers (§8), LayoutTour (§2/§4), MobileBottomNav + MiniVoiceBar (§14).

---

## Filename convention

- All paths relative to repo root: `assets/readme/<filename>.png`
- Lowercase, hyphen-separated, feature-first
- PNG; 2× retina export optional (README can scale down)
- No tokens/secrets visible (bot tokens, recovery phrases, MFA codes)

---

## Out of scope

| Surface | Reason |
|---|---|
| `/media-test` | Dev-only route (`import.meta.env.DEV`); stripped from production |
| BrandedSplash / LazyFallback | Transient loading states |
| Access-denied / error-only screens | Not marketing material unless demonstrating security |
| `docs/screenshots/*` | Legacy path; new captures go to `assets/readme/` per this plan |

---

## Suggested capture order

1. Auth flow (`/connect` → `/register` or seed account → `/login`)
2. Shell + Home + sidebar
3. Guild Rooms → text channel → context panels → inbox → command palette
4. Forum, voice lobby, stage
5. Friends + DMs
6. Settings overlays (user, guild)
7. Mobile variants of steps 2–4
8. Admin / developer / discovery (if demo server supports)
