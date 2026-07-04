# Paracord Layout Spec — "Rooms + Unified Stream" (v1.0 overhaul)

> **This file is the IA law.** The whole client-layout overhaul is graded against it.
> It resolves the three verified research slices (ia-routing, attention/ranking data,
> rooms/presence surfaces) into one implementable plan. Where a slice and this file
> disagree, this file wins. Where this file and a component disagree, the component is
> wrong. Visual law remains `docs/design-spec.md` ("Emerald Commons"): **consume tokens
> from `client/src/styles/tokens.css`, never hard-code hex.** The anti-AI-slop kill-list
> stays enforceable.
>
> **Scope guard:** CLIENT-ONLY. No server changes. Every datum the new IA needs (unreads,
> mentions, voice occupancy/speaking/streams, presence, members, DMs) already flows through
> existing stores + gateway dispatch and is reused. The single non-trivial data lift —
> loading background servers' read-state/DMs — is done client-side with the per-server
> `connectionManager` API clients that already exist. Anything that would require a server
> change is **flagged, not built** (see §9).

---

## 0. Verified baseline (green tree `959b107a`)

- **Router** `client/src/App.tsx`: public routes outside the shell; `/app` = `ProtectedRoute → AppLayout` with an `<Outlet/>`; children `index=HomePage`, `guilds/:guildId=GuildHub`,
  `guilds/:guildId/settings=GuildSettingsPage`, `guilds/:guildId/channels/:channelId=GuildPage`,
  `dms`, `dms/:channelId=DMPage`, `friends`, `admin`, `discovery`, `templates`,
  `oauth2/authorize=BotAuthorizePage`, `developers`; `*→/app`. Dev-only `/media-test`.
- **Frame** `client/src/pages/AppLayout.tsx`: guild rail (`Sidebar`) + channel column (`ChannelSidebar`) + main `<Outlet/>` + docked `MemberList` (guild-channel route only) + mobile `MiniVoiceBar` + `MobileBottomNav` + `CommandPalette` + `ConfirmDialog` + user/guild-settings modal overlays.
- **App chrome** `client/src/lib/AppProviders.tsx` (OUTSIDE the router): `ConnectionStatusBar`, `RestartBanner`, `UpdateNotification`, `ToastContainer`, `ImageLightbox`; gateway/session/theme init. **Untouched by this overhaul.**
- **Data verified present + multi-server capable:** `guildStore.guilds` (each stamped `server_url`), `channelStore.channelsByGuild` (`''`=DMs), `readStateStore.readStates` (`{last_message_id, mention_count}`), `useUnreadCounts` (`computeGuildUnread` pure primitive), `voiceStore.channelParticipants: Map<channelId, VoiceState[]>` + `speakingUsers: Set<userId>` + `watchedStreamerId`/`setWatchedStreamer` (global, populated for every server via READY `loadVoiceStates`), `presenceStore.getPresence(userId, scope)` (serverId-scoped w/ drift fallback), `serverListStore.servers[]` (`{id,url,name,…}`) + `connectionManager.getApiClient(serverId)`/`getConnection(serverId)` + `dispatch(serverId,event,data)`.
- **ChannelType** (`types/channel.types.ts`): `GuildText=0, DM=1, Voice=2, GroupDM=3, Category=4, Announcement=5, Thread=6, Forum=7, Stage=13`.
- **Reusable primitives:** `lib/features/channelGroups.ts#buildChannelGroups`, `hooks/useVoice.ts#joinChannel`, `stores/folderStore.ts` (zustand-persist template), `hooks/useMobile.ts`, `hooks/useSwipeGesture.ts`, `components/voice/MiniVoiceBar.tsx`.

---

## 1. The new frame + component tree (exact paths)

The Discord skeleton (guild rail + channel column + docked member list) is replaced by a
two-zone shell: **one Unified Sidebar** (left, ~300px, collapsible) and **one full-width
content pane** (`<Outlet/>`), with a **contextual right panel** that is toggleable, not docked.

```
client/src/pages/AppShell.tsx                         ← replaces AppLayout.tsx
├─ <UnifiedSidebar/>            components/layout/sidebar/UnifiedSidebar.tsx   (~300px; collapsible → 64px rail desktop / overlay mobile)
│   ├─ <SidebarSearch/>         components/layout/sidebar/SidebarSearch.tsx    (search field + ⌘K command-palette opener)
│   ├─ <NeedsYou/>              components/layout/sidebar/NeedsYou.tsx         (attention-ranked, capped 6; emerald badges)
│   ├─ <PinnedRail/>            components/layout/sidebar/PinnedRail.tsx       (pinned conversations, floats above Recent)
│   ├─ <RecentList/>            components/layout/sidebar/RecentList.tsx       (heterogeneous rows, MERGED across all servers)
│   ├─ <SpacesList/>            components/layout/sidebar/SpacesList.tsx       (joined guilds → guild Home; absorbs folders/ctx-menu)
│   └─ (footer)
│       ├─ <CallDock/>          components/layout/sidebar/CallDock.tsx         (persistent call dock — reuses MiniVoiceBar; only when voice connected)
│       └─ <UserPanel/>         components/layout/UserPanel.tsx                (MOVED here — avatar/presence/mute/deafen/settings)
│   └─ <ConversationRow/>       components/layout/sidebar/ConversationRow.tsx  (shared heterogeneous row used by NeedsYou/Recent/Pinned)
│
├─ <main id="main-content"><Outlet/></main>           full-width content pane (bg-primary)
│
├─ <ContextPanel/>              components/layout/ContextPanel.tsx             (right; toggleable; closed on narrow) — modes below
│   ├─ members  → wraps existing components/layout/MemberList.tsx
│   ├─ threads  → existing components/message/ThreadPanel.tsx (+ thread list)
│   ├─ pins     → existing pins panel surface (from TopBar pins overlay)
│   ├─ search   → existing search results surface (from TopBar search overlay)
│   └─ economy  → existing components/guild/GuildEconomyPanel.tsx
│
├─ <MiniVoiceBar/>              components/voice/MiniVoiceBar.tsx              (MOBILE bottom dock only — sidebar CallDock covers desktop)
├─ <MobileBottomNav/>           components/layout/MobileBottomNav.tsx          (narrow only)
├─ <CommandPalette/>            components/layout/CommandPalette.tsx           (⌘K — unchanged, first-class nav)
├─ <ConfirmDialog/>             components/ui/ConfirmDialog.tsx
└─ settings overlays: <SettingsPage/> (userSettingsOpen), <GuildSettingsPage/> (guildSettingsId)
```

### Guild Home = Rooms view (replaces GuildHub)

```
client/src/pages/GuildHomePage.tsx                    ← renamed from GuildHub.tsx; route element for guilds/:guildId
└─ <RoomsView guildId>          components/rooms/RoomsView.tsx
    ├─ <GuildHomeHeader/>       components/rooms/GuildHomeHeader.tsx   (Fraunces name, who's-around summary, invite + admin/settings entry)
    ├─ <LiveRoomsGrid/>         components/rooms/LiveRoomsGrid.tsx     (voice+stage channels → RoomCards; live first, quiet compact)
    │   └─ <RoomCard/>          components/rooms/RoomCard.tsx          (live | quiet | stage | stream states)
    │       └─ <OccupantStack/> components/rooms/OccupantStack.tsx     (overlapping avatars, speaking ring, +N)
    ├─ <AroundNowStrip/>        components/rooms/AroundNowStrip.tsx    (online-member strip → "View all" opens ContextPanel members)
    └─ <TextChannelList/>       components/rooms/TextChannelList.tsx   (buildChannelGroups categories, unread/mention badges → chat route)
```

### Chat view (full-width single pane) — GuildPage / DMPage

`GuildPage.tsx` (guild channel) and `DMPage.tsx` (DM) are the **ChatView**. They keep all
message internals (`MessageList`, `MessageInput`, threads, files) — reused, never rebuilt.
They render a reworked **`TopBar`** (`components/layout/TopBar.tsx`): breadcrumb chip
`GuildName /` (→ guild Home) + `#channel` + topic (DMs: avatar + name), and a context
toggle cluster that drives `contextPanelMode`. The right panel is `ContextPanel`, not a
docked `MemberList`.

### App Home (no guild selected) — HomePage

`client/src/pages/HomePage.tsx` (reworked): DM/friends presence-first analog —
**live DM/group calls first** (new `LiveDmCallSection`, reuses `RoomCard` + `voiceStore`),
then friends-around-now (already present), then recent DMs. "Global Happening Now" done right.

### Attention data layer (new)

```
client/src/lib/attention/conversationModel.ts   (types + pure builders + snowflakeToMs)
client/src/lib/attention/scoreConversation.ts    (pure scoreEntry — Needs-you ranking)
client/src/hooks/useUnifiedConversations.ts       (the single memoized cross-server selector)
client/src/stores/pinnedStore.ts                  (zustand+persist — pinned conversation keys)
```

---

## 2. Surface map — every old surface → new home (nothing orphaned)

| Old surface (path) | Fate | New home |
|---|---|---|
| `components/layout/Sidebar.tsx` (guild rail) | **DIES** | `SpacesList` (guild chips); folder/context-menu logic absorbed into `SpacesList` |
| `components/layout/ChannelSidebar.tsx` (router shim) | **DIES** | `UnifiedSidebar` owns all left-rail routing |
| `components/layout/GuildChannelList.tsx` (channel column) | **DIES** | text-channel logic (`buildChannelGroups`, unread/mention rows, inline-create) → `components/rooms/TextChannelList.tsx`; footer `VoiceControls` → `CallDock`; `UserPanel` → sidebar footer |
| `components/layout/DMList.tsx` (Home DM list) | **DIES** | rows → `RecentList`/`NeedsYou`; DM-picker → **extracted** `components/message/DmPickerModal.tsx`; `UserPanel` → sidebar footer |
| `components/layout/UserPanel.tsx` | **MOVES** (survives) | `UnifiedSidebar` footer |
| `components/voice/VoiceControls.tsx` (channel-column footer) | **DIES** | `components/layout/sidebar/CallDock.tsx` (reuses `MiniVoiceBar`; port any richer affordance before deleting) |
| `components/voice/MiniVoiceBar.tsx` | **SURVIVES / promoted** | shared voice-dock primitive: `CallDock` (desktop sidebar footer) + mobile bottom dock in `AppShell` |
| `components/layout/MemberList.tsx` | **SURVIVES** | `ContextPanel` `members` mode |
| `components/layout/TopBar.tsx` | **REWORKED** (survives) | ChatView topbar: breadcrumb chip + `#channel`/topic + context toggles → `contextPanelMode`; keeps Summary/Follows/Inbox/Help as anchored popovers |
| `components/guild/GuildEconomyPanel.tsx` | **SURVIVES** | `ContextPanel` `economy` mode |
| TopBar Search overlay | **MOVES** | `ContextPanel` `search` mode |
| TopBar Pins overlay | **MOVES** | `ContextPanel` `pins` mode |
| `components/message/ThreadPanel.tsx` | **SURVIVES** | `ContextPanel` `threads` mode (active thread panel) |
| TopBar Summary / Follows / Inbox / Help overlays | **SURVIVE** | remain TopBar-anchored popovers (Inbox is *complemented* — not replaced — by sidebar `NeedsYou`) |
| `pages/AppLayout.tsx` | **DIES** | `pages/AppShell.tsx` |
| `pages/GuildHub.tsx` | **RENAMED + REWORKED** | `pages/GuildHomePage.tsx` → `RoomsView` |
| `pages/HomePage.tsx` | **REWORKED** (survives) | live-DM-calls-first Home |
| `pages/GuildPage.tsx` | **REWORKED** (survives) | ChatView (breadcrumb + ContextPanel) |
| `pages/DMPage.tsx` | **REWORKED** (survives) | ChatView for DMs |
| `pages/GuildSettingsPage.tsx` | **SURVIVES** | overlay (`guildSettingsId`) **and** route `guilds/:id/settings`; entry moves to `GuildHomeHeader` |
| `components/layout/MobileBottomNav.tsx` | **SURVIVES** | narrow-only bottom nav (Home/DMs/Server/Friends/Settings) |
| `components/layout/CommandPalette.tsx` | **SURVIVES** | ⌘K, first-class nav; opened by `SidebarSearch` too |
| `components/ui/ConfirmDialog.tsx` | **SURVIVES** | `AppShell` |
| Settings (`SettingsPage`, `GuildSettingsPage`) | **SURVIVE** | windowed overlays in `AppShell` (unchanged behavior) |
| `pages/FriendsPage`, `DiscoveryPage`, `TemplateGalleryPage`, `DeveloperPage`, `AdminPage`, `BotAuthorizePage`, `InvitePage` | **UNCHANGED** | full-page routes; reachable via `SpacesList`/Home quick-actions/⌘K |
| Onboarding / welcome (`ServerConnectPage` `/connect`) | **UNCHANGED** | outside shell |
| Legal (`Terms`,`Privacy`), auth (`Login`,`Register`,`AccountSetup`,`Unlock`,`Recover`) | **UNCHANGED** | outside shell |
| Stage channels (`VoiceStageChannel`, `VoiceLobby`, `VoiceControlBar`) | **SURVIVE** | reached via `RoomCard` stage state → channel route (the real room view) |
| Streams / watch (`StreamViewer`, `VoiceParticipants`) | **SURVIVE** | `RoomCard` stream state → `setWatchedStreamer(id)` + navigate to channel |
| Scheduled messages, file uploads (`MessageInput`, `FilePreview`) | **UNCHANGED** | live in the ChatView composer |
| Developer surfaces (`DeveloperPage`) | **UNCHANGED** | route `/app/developers` + ⌘K |
| App chrome (`ConnectionStatusBar`, `RestartBanner`, `UpdateNotification`, `ToastContainer`, `ImageLightbox`) | **UNCHANGED** | `AppProviders`, outside the router |

**Files DELETED at cleanup:** `Sidebar.tsx`, `ChannelSidebar.tsx`, `GuildChannelList.tsx`,
`DMList.tsx`, `VoiceControls.tsx`, `pages/AppLayout.tsx`. Their `*.test.tsx` are **rewritten**
against the new components (Sidebar→SpacesList, DMList→RecentList/NeedsYou, GuildHub→RoomsView,
etc.) — **never deleted to pass**.

---

## 3. Unified-list data model + Needs-you scoring

### 3.1 `ConversationEntry` (`lib/attention/conversationModel.ts`)

```ts
type ConversationKind = 'dm' | 'group_dm' | 'guild_text' | 'thread' | 'voice' | 'guild_home';

interface ConversationEntry {
  key: string;              // `${serverId}:${channelId}` — collision-safe across servers
  serverId: string;         // resolved from guild.server_url→serverId map, or the DM's owning server
  channelId: string;
  guildId: string | null;   // null for DMs / group DMs
  kind: ConversationKind;
  title: string;            // channel name / DM recipient / thread name / guild name
  contextLabel: string | null;   // small guild-context label for guild rows ("in Emerald HQ")
  lastActivityId: string | null; // channel.last_message_id snowflake → time-sortable
  unread: boolean;
  mentionCount: number;     // direct + role + @everyone (see 3.3 note)
  isDMUnread: boolean;
  isThreadReply: boolean;
  hasVoiceActivity: boolean;// channelParticipants.get(channelId).length > 0
  pinned: boolean;
}

// Snowflake → ms. EPOCH = 2024-01-01 custom epoch. Used for recency sort + decay.
function snowflakeToMs(id: string): number;   // Number((BigInt(id) >> 22n)) + EPOCH_MS
```

**Key rule (resolves slice-2 gap #2):** entries are keyed by `${serverId}:${channelId}`,
not the bare snowflake — two servers can mint the same channel id, and read-state must not
collide. All maps (read-state, pins) use the composite key.

### 3.2 The single selector — `useUnifiedConversations()`

One memoized hook is the only place the cross-server list is built. It subscribes to:
`channelStore.channelsByGuild` + the new per-server DM index, `readStateStore` (composite),
`voiceStore.channelParticipants` + `speakingUsers` (membership-only), `serverListStore.servers`,
`guildStore.guilds`, `pinnedStore`, and the muted-guild set. It returns:

```ts
{ needsYou: ConversationEntry[];   // scored, !pinned, capped 6
  recent:   ConversationEntry[];   // remaining, sorted by lastActivityId desc
  pinned:   ConversationEntry[];   // in user pin order
  spaces:   GuildSummary[] }       // joined guilds for SpacesList
```

Build is **O(channels)**: iterate `channelsByGuild` → resolve `serverId`
(guild channels via a `guild.server_url → serverId` map built from `serverListStore.servers`;
DMs via the per-server DM index) → attach unread/mention from the composite read-state map →
attach `hasVoiceActivity` from `channelParticipants`. It **reuses `computeGuildUnread`
primitives**, never forks them. Presence dots are looked up **per row** with a
`usePresenceStore` selector so a presence tick does not re-run the whole memo.

**Invalidation = the memo deps.** No polling, no new gateway events: `MESSAGE_CREATE`
already bumps `last_message_id` + `mention_count` live, `VOICE_STATE_UPDATE` already updates
`channelParticipants`, presence is already scoped. `speakingUsers` is included but the store
already bails when Set membership is unchanged, so a speaking tick that flips no membership
does not recompute.

### 3.3 Needs-you scoring (`lib/attention/scoreConversation.ts`)

`scoreEntry(e: ConversationEntry, nowMs: number): number`. Pinned entries are pulled out
**before** scoring (they float above Recent, never compete for the Needs-you cap).

| Signal | Weight | Notes |
|---|---|---|
| direct/role mention | `1000 * min(mentionCount, 9)` | top tier |
| @everyone mention | `250` *(deferred)* | **v1: folds into the mention tier** — see note |
| DM unread | `400` | |
| thread reply | `120` | `isThreadReply` |
| plain unread | `40` | |
| voice activity | `30` | `hasVoiceActivity` |
| recency boost | `+ 60 * exp(-ageHours/12)` | **tie-shaper only** — never overtakes a higher tier |

`ageHours` from `snowflakeToMs(lastActivityId)`. Final:
`needsYou = entries.filter(e => !e.pinned && scoreEntry(e) > 0).sort(desc).slice(0, 6)`;
everything else → `recent`, sorted by `lastActivityId` desc.

**Spec ideal order:** direct mentions > DM unreads > @everyone/role > thread replies.
**v1 realized order:** *mentions (direct+role+@everyone, by count)* > DM unreads > thread
replies > plain unread > voice. The middle `@everyone`-below-DM tier collapses because the
current data does not distinguish `@everyone` from a direct mention: `dispatch.ts` merges
both into `mention_count` at ingest, and the REST read-state snapshot carries only the
merged count. **FLAG (§9):** a true `@everyone` tier needs an additive, durable
`everyone_count` on the read-state model (server-side) — a client-only `mention_everyone`
flag is live-accurate but lost on refresh, so it is deferred, not faked.

### 3.4 Pinning persistence — `stores/pinnedStore.ts`

`zustand` + `persist` (folderStore pattern), storage key `paracord:pinned-conversations`.
State: `{ pinnedKeys: string[]; pin(key); unpin(key); reorder(keys) }`. Keys are the composite
`${serverId}:${channelId}` so pins survive across servers and reconnects. `PinnedRail` renders
in `pinnedKeys` order.

### 3.5 Store augments (additive, reuse per-server clients)

- **`readStateStore`** becomes serverId-scoped: `byServer: Record<serverId, Record<channelId, ReadState>>`, single source of truth. `refresh()` **fans out** over `connectionManager`-connected servers, each `getApiClient(serverId).get('/users/@me/read-states')` (endpoint already exists per server). Accessors: `getReadStateMap(serverId)` (returns the per-server `Record`, used by `computeGuildUnread`), `getReadState(serverId, channelId)`. `incrementMention(serverId, channelId)` / `markRead(serverId, channelId, lastMessageId)` take the serverId their call site already has (`dispatch(serverId,…)`; ChatView knows its active server). `computeGuildUnread(channels, readStateMap)` stays **pure and unchanged** — callers resolve the right per-server map. Update `readStateStore.test.ts` + `useUnreadCounts` (pass the guild's serverId) to the new IA.
- **DM fan-out:** extend `channelStore` with a per-server DM index `dmChannelsByServer: Record<serverId, Channel[]>` + `setDmChannels(serverId, channels)`. `dmApi.list()` moves out of `DMList` into a per-server fan-out over connected servers. `channelsByGuild['']` (active server DMs) stays populated for back-compat until cleanup migrates its readers.

---

## 4. Route table

Routes are **preserved and only re-skinned** — no new paths (⌘K + sidebar cover navigation).

| Path | Element (module) | Meaning after overhaul |
|---|---|---|
| `/app` (index) | `HomePage` | App Home — live DM calls, friends around, recent DMs |
| `/app/guilds/:guildId` | `GuildHomePage` *(was GuildHub)* | **Guild Home = Rooms view** |
| `/app/guilds/:guildId/settings` | `GuildSettingsPage` | guild settings (also reachable as overlay via `guildSettingsId`) |
| `/app/guilds/:guildId/channels/:channelId` | `GuildPage` | **ChatView** (text) / room view (voice/stage) |
| `/app/dms`, `/app/dms/:channelId` | `DMPage` | **ChatView** for DMs |
| `/app/friends` | `FriendsPage` | unchanged |
| `/app/discovery` | `DiscoveryPage` | unchanged |
| `/app/templates` | `TemplateGalleryPage` | unchanged |
| `/app/developers` | `DeveloperPage` | unchanged |
| `/app/admin` | `AdminPage` | unchanged |
| `/app/oauth2/authorize` | `BotAuthorizePage` | unchanged (bot store / authorize) |
| `/app/*` | `Navigate → /app` | unchanged |
| Public: `/setup /unlock /recover /connect /login /register /invite/:code /terms /privacy` | as today | outside shell; `/media-test` dev-only |

Shell change in `App.tsx`: the `/app` element `AppLayout` → **`AppShell`** (lazy import
updated); `GuildHub` lazy import → **`GuildHomePage`**. No route entries added or removed.

---

## 5. Keyboard model

Extend `hooks/useKeyboardNavigation.ts`; add roving-tabindex arrow-nav to the sidebar list.

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Toggle Command Palette (canonical move affordance; `SidebarSearch` opens the same) |
| `↑` / `↓` (sidebar focused) | Roving-tabindex move within the flattened sidebar list (Needs-you → Pinned → Recent → Spaces) |
| `Enter` / `Space` (row focused) | Open the focused conversation / space |
| `Home` / `End` (sidebar focused) | Jump to first / last row |
| `Alt+↑` / `Alt+↓` | Prev / next **channel** within the current guild (kept) |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | Prev / next **Space** (guild) (kept) |
| `Ctrl+,` | User settings overlay (kept) |
| `Ctrl+Shift+,` | Current guild settings overlay (kept) |
| `Ctrl+B` | **Toggle sidebar collapse** *(repurposed from the dead `dockPinned`)* |
| `Esc` | Precedence: close Command Palette → else close `ContextPanel` (`contextPanelMode=null`) → else (narrow) close the sidebar overlay. Settings overlays keep their own Esc handler. |

`focus-visible` ring (`--focus-ring`) on every interactive element; every hover-revealed
action also reachable on focus (`focus-within`) — design-spec §8, non-negotiable.

---

## 6. Narrow / mobile rules

Breakpoint via `useMobile()` (≤768px); gestures via `useSwipeGesture`. On mount when mobile,
`sidebarCollapsed` is forced true (existing effect preserved).

- **Unified sidebar → left overlay.** Swipe-right from the left edge opens; backdrop tap or `Esc` closes. Desktop-collapsed (64px rail) is *not* used on mobile — it is full overlay or hidden.
- **ContextPanel → right overlay.** Swipe-left opens it in `members` mode (matches today's `setMemberPanelOpen(true)` gesture); default closed.
- **Guild Home (`RoomsView`) stacks to one column:** header → live rooms → around-now → text channels.
- **ChatView topbar compact;** breadcrumb collapses to the channel chip; ContextPanel default closed.
- **`MobileBottomNav` retained** (Home / DMs / Server / Friends / Settings).
- **`MiniVoiceBar` mobile dock** stays in `AppShell` main (the sidebar CallDock is unreachable while the overlay sidebar is closed, so the mobile bottom dock remains the persistent call surface).

Desktop collapse (`Ctrl+B` / footer control): `sidebarCollapsed=true` → 64px **icon rail**
(Space avatars with attention dots + a mini CallDock + the user avatar) so navigation survives
collapse; expanded width = `sidebarWidth` (user-resizable within `--sidebar-min`…`--sidebar-max`).

---

## 7. Rooms recipes (Emerald Commons tokens)

All values reference tokens; no hard-coded hex. Kill-list enforced (no gradient hero #1,
line icons not emoji #3, left-aligned empty states #4, dividers not tiled cards #5).

### 7.1 `RoomCard` states (`components/rooms/RoomCard.tsx`)
Props `{ channel, participants: VoiceState[], speakingUsers: Set<string>, guildId, onJoin, onWatch, compact }`. Derive from `channelParticipants.get(channel.id)`.

- **(a) Live** — `bg-bg-secondary`, `border-border-subtle`, `--radius-md`, `--shadow-sm`.
  `OccupantStack` of occupants; **speaking ring** on `speakingUsers.has(id)`:
  `ring-2 ring-accent-primary` + glow `shadow-[0_0_8px_rgba(var(--accent-primary-rgb),0.55)]`.
  Listener count as a `--success-tint`/`--accent-success` badge. One-click **Join** =
  primary button (§7 Button) → `useVoice().joinChannel(channel.id, guildId)`.
- **(b) Quiet / empty** — **compact single-line row**, not a dead card: `#`/`Volume2` icon +
  name + muted `--text-muted` "Empty — start the room" + subtle **Join** (outline). Never an
  icon-in-a-circle dead tile.
- **(c) Stage** (`channel.type === 13`) — `Radio` icon, speakers vs audience split (the
  `suppress` flag), "Live" + listener count. Enter → channel route (`VoiceStageChannel`).
- **(d) Stream** — per-occupant `--status-streaming` (`#9B7BFF`) dot on the avatar + **Watch**
  → `voiceStore.setWatchedStreamer(id)` then navigate to the channel route (mirrors
  `VoiceParticipants` handoff). 

### 7.2 `OccupantStack` (`components/rooms/OccupantStack.tsx`)
Overlapping avatar chips, `-8px` overlap, each ringed in the surface color behind it
(`--bg-secondary`). Speaking ring = teal→emerald duotone per design-spec §Avatar. `+N`
overflow chip on `--bg-mod-strong` / `--text-secondary`. Mute + streaming badges.

### 7.3 `AroundNowStrip` (`components/rooms/AroundNowStrip.tsx`)
Presence-first online-member strip: `memberStore.getMembersForGuild(guildId)` filtered by
`presenceStore.getPresence(id, scope).status !== 'offline'`. Avatar + presence dot
(`--status-online|idle|dnd|streaming`, ring in the panel surface). **"View all"** opens the
full member list via `ContextPanel` `members` mode.

### 7.4 `TextChannelList` (`components/rooms/TextChannelList.tsx`)
Categories via `buildChannelGroups`; unread/mention via `useUnreadCounts(serverId, muted)`.
Row = **Nav item recipe** (design-spec §7): 34px, `--radius-sm`, text `--text-secondary`,
icon 18px `--channel-icon`. **Active:** `--accent-tint` + 3px left bar `--accent-secondary`
(teal) + icon `--accent-primary` (never a full emerald fill). **Unread:** 8px `--accent-primary`
dot. **Mention badge:** `--accent-primary` bg + `--text-on-accent`. Forum/announcement keep
their affordances. Click → `guilds/:guildId/channels/:channelId`.

### 7.5 `GuildHomeHeader` (`components/rooms/GuildHomeHeader.tsx`)
Solid raised surface (`--bg-secondary` + `--border-subtle` divider — **no gradient hero**).
Guild name in Fraunces (`font-display`, Title/Display step). "Who's around now" summary
(online count + live-room count). **Admin/settings entry** (gear) gated by
`usePermissions(MANAGE_GUILD)` → `setGuildSettingsId(guildId)` — this is where the old
`GuildChannelList` dropdown entry now lives. Invite affordance alongside.

### 7.6 Sidebar `ConversationRow` recipe (`components/layout/sidebar/ConversationRow.tsx`)
Nav-item base (§7). **Active:** `--accent-tint` fill + 3px teal left edge bar + `--text-primary`.
Heterogeneous leading element by `kind`: guild channel = `#`/type icon + small
`--text-muted` guild-context label; DM/group = avatar + presence dot; thread = thread icon;
guild home = guild avatar. **Emerald mention badge** (`--accent-primary` + `--text-on-accent`);
8px `--accent-primary` unread dot. Voice-active rows show a small live indicator.

---

## 8. Migration plan (lanes: data → shell → rooms/chat/pages → cleanup)

Each wave lands green (TS strict + `clippy -D warnings` + all tests). Compatibility seams keep
old pages working while the new shell renders new components.

### Wave 1 — Data layer (no visible UI change)
1. Add `lib/attention/conversationModel.ts`, `scoreConversation.ts`, `stores/pinnedStore.ts` (pure/isolated; covered by new unit tests).
2. Make `readStateStore` serverId-scoped (`byServer` single source, `getReadStateMap`/`getReadState`, `refresh()` per-server fan-out). Update `dispatch` (`incrementMention(serverId, …)`), mark-read call sites, `useUnreadCounts` (pass serverId), and their tests to the new IA — `computeGuildUnread` stays pure.
3. Extend `channelStore` with `dmChannelsByServer` + `setDmChannels(serverId,…)`; add a per-server DM fan-out. Keep `channelsByGuild['']` populated (active server) for back-compat.
4. Add `hooks/useUnifiedConversations.ts` building `ConversationEntry[]` from the above.
   **Seam:** the hook can run active-server-only first (matches today) and widen to all
   connected servers as fan-out lights up — either state is correct and green.

### Wave 2 — Shell (frame swap; old page bodies still work)
5. Add `pages/AppShell.tsx` + `components/layout/sidebar/*` (`UnifiedSidebar`, `SidebarSearch`, `NeedsYou`, `PinnedRail`, `RecentList`, `SpacesList`, `ConversationRow`, `CallDock`) consuming `useUnifiedConversations`; move `UserPanel` into the footer.
6. Add `components/layout/ContextPanel.tsx` wrapping existing `MemberList`/`ThreadPanel`/pins/search/`GuildEconomyPanel`.
7. `uiStore`: add `contextPanelMode` (single source of truth) + `sidebarWidth`; repurpose `sidebarCollapsed`. **Seam:** keep `setMemberPanelOpen`/`setSearchPanelOpen`/`setEconomyPanelOpen`/`memberPanelOpen`(read) as thin adapters that route to/read from `contextPanelMode`, so un-migrated `TopBar`/`TextChannelView` keep compiling and passing. `Ctrl+B` → `toggleSidebarCollapsed`.
8. Point `App.tsx` `/app` element at `AppShell`. **The shell renders the new sidebar while the still-original `HomePage`/`GuildHub`/`GuildPage` bodies render unchanged in the `<Outlet/>`** — app stays fully usable between waves.

### Wave 3 — Rooms / Chat / Pages (page bodies)
9. `components/rooms/*` + rename `GuildHub.tsx` → `GuildHomePage.tsx` (`RoomsView`); update `App.tsx` import + rename `GuildHub.test.tsx` → `GuildHomePage.test.tsx` asserting the room-card IA (speaking ring, quiet vs live, stream watch, around-now, text grouping, admin entry).
10. Rework `HomePage` (live-DM-calls-first) — reuse `RoomCard`; update `HomePage.test.tsx` to the new IA.
11. Rework `GuildPage`/`DMPage` ChatView: reworked `TopBar` (breadcrumb chip + context toggles → `contextPanelMode`); migrate its Search/Pins/Members/Economy/Threads toggles off the legacy setters onto `setContextPanelMode`. Update `TopBar.*.test.tsx`.
12. Extract `DmPickerModal` from `DMList`; wire it to `SidebarSearch`/Home "new DM".
13. Extend `useKeyboardNavigation` (roving sidebar arrows, Esc precedence, `Ctrl+B`).

### Wave 4 — Cleanup (no dead code left)
14. Delete `Sidebar.tsx`, `ChannelSidebar.tsx`, `GuildChannelList.tsx`, `DMList.tsx`, `VoiceControls.tsx`, `pages/AppLayout.tsx`; rewrite their tests against the successor components.
15. Remove the `uiStore` back-compat adapters + dead flags (`sidebarOpen`, `dockPinned`, `memberPanelOpen`, `economyPanelOpen`, `searchPanelOpen`) and their persistence once all readers are migrated; converge DM reads onto `dmChannelsByServer` and drop the legacy `channelsByGuild['']` back-compat if no longer read.
16. Full `npm run typecheck` + `npm run test:unit` + `cargo clippy` green; verify no orphaned surface (§2 checklist).

---

## 9. Flags — server-side or scope-adjacent (NOT built here)

1. **`@everyone` ranking tier.** True "@everyone/role below DM unreads" needs an additive,
   durable `everyone_count` on the read-state model (server). v1 folds `@everyone` into the
   mention tier (§3.3). Client-only `mention_everyone` is live-only (lost on REST refresh).
2. **Background-server data freshness.** Read-state/DM fan-out uses existing per-server API
   clients; unreachable background servers degrade gracefully (last snapshot kept, row still
   renders from `channelsByGuild`). No server change.
3. **Guild `server_url` attribution.** `guildStore.addGuild` stamps
   `server_url: resolveApiBaseUrl()` (active) for guilds arriving via a *background* server's
   READY — latent mis-attribution adjacent to the merge. The `server_url→serverId` map should
   be built defensively; a proper fix (tag guilds with the originating serverId at ingest) is
   a small additive client change, flagged for its own PR — not required for v1 ranking.

No server changes are required for the v1 layout, rooms, or ranking.
