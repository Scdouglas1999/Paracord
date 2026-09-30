# Glass: implementation plan

The architect's plan for building `docs/glass-spec.md` in the `design/glass`
worktree (`~/Documents/Paracord-glass`, based on `main` at `c10eb4da`). It maps
the spec onto the current client and server, proposes what happens to the looks,
lists the server work that §10 actually implies, and splits the build into work
packages (WP-G0 … WP-G23) small enough for one agent session each.

Findings are from the code, with paths. Where the spec's §10 is wrong about
what exists, this plan says so (§3).

> **Before any agent starts:** `CLAUDE.md` is untracked in the main checkout and
> therefore missing from this worktree. Copy it in (untracked) so briefs that say
> "read CLAUDE.md" work: `cp ~/Documents/Paracord/CLAUDE.md ~/Documents/Paracord-glass/`.
> The worktree also has no `client/node_modules`; run `cd client && npm ci` once.
> Do not symlink `node_modules` to the main checkout (a Devin session is live there).

---

## 1. How Glass maps onto the current client

### 1.1 The frame

| Today (Lantern) | Glass | Verdict |
|---|---|---|
| `pages/AppShell.tsx`: `UnifiedSidebar` + `<main>` plate + toggleable `ContextPanel`, `MobileBottomNav`, `OnAirDock` | Two floating panes (Places 316px, Conversation) on a room backdrop, plus a Stage that grows out of the call pill | **Replaced** (WP-G7) |
| `components/layout/sidebar/*` (`UnifiedSidebar`, `BuildingsColumn`, `BuildingSection`, `RoomRow`, `CollapsedRail`, `SidebarSearch`, `AccountPlate`, `CallDock`) | Places panel: server row, server title, channel rows with previews, live voice row, Coming up | **Replaced** (WP-G9). Data hooks (`useBuildingLights`, `useBuildingRosters`, `useUnreadCounts`, `useMutedGuilds`, `useRoomMenu`) are **reused** as data |
| `components/layout/TopBar.tsx` (902 lines), `ConversationHeaderActions.tsx` | 76px header: title + topic at the column's left edge, call pill at its right edge, search / people / avatar at the pane's right edge | **Replaced** (WP-G11). Its menu items move to sheets and menus (WP-G18) |
| `components/layout/ContextPanel.tsx` (search, pins, threads, media, economy, group-DM recipients) | No docked right panel (spec §1.7) | **Replaced** by sheets over the conversation column (WP-G18) |
| `components/message/MessageList.tsx` (4,019 lines, virtualized rows), `TimelineParts.tsx`, `messageLight.ts` | Bubbles: avatar at the bottom of a group, name/time above the first bubble, own messages right-aligned and light, joined corners, reactions biting media, hover actions beside the name, typing bubble, catch-up divider | **Restyled in place** (WP-G10, WP-G13). Keep virtualization, keyboard nav, edit/delete/reply/thread logic; change row markup and CSS. Needs `isLastInGroup` (look at the next message) |
| `data-message-style='bubbles'` in `styles/looks.css` (CSS-only bubbles for Slate/Aubergine) | Glass bubbles are the only shape | **Replaced**; the rows/bubbles switch goes |
| `components/message/MessageInput.tsx` (1,916 lines) | 52px glass capsule, column width, reply chip, send turns cream with text | **Restyled in place** (WP-G11) |
| `components/message/PollMessageCard.tsx`, `guild/EventList.tsx` | Plan card style (`--raise`, joined corner, text decision) | **Restyled** (WP-G13) |
| `components/voice/*`: `VoiceStageChannel` (1,097 lines), `StreamViewer` (1,060), `SplitPane`, `VoiceControlBar`, `StageSpeakers`, `stage/*`, `FocusedWebcamView`, `CameraSurface` | Call pill (compact/expanded), Stage side by side / theater / browse, camera tiles and people chips, centered glass controls | **Replaced** (WP-G12, WP-G14, WP-G15). Reuse the video tile internals (`CanvasRenderer`, `NativeVideoTile`, `useWebcamTiles`, `useScreenShareSubscriptions`, `useStream`) |
| `components/light/*` (`LitAvatar`, `AvatarStack`, `WindowMap`, `BuildingPlate`, `OnAirPill`, `HereNowStrip`, `RoomThumbnail`, `LiveDot`) | Faces, amber live rings, waveform | **Retired** after replacement (WP-G22). `lib/attention/*` stays as the data layer (who is here, who talks, unread) |
| `components/rooms/lobby/*` (server home: `ServerHome`, `LiveNow`, `ServerFeed`, widgets, `HomePageSettings`) | Not in the spec | **Flag** (see 1.3) |
| `components/home/*`, `pages/HomePage.tsx` (Needs you, Pick up, Around now, Coming up) | "Home/DMs" tray in the server row | **Flag** (see 1.3) |
| `styles/tokens.css` (1,601 lines), `primitives.css`, `layout.css`, `components.css` | Glass tokens (§2), room-tinted variables | **Extended then pruned** (WP-G0, WP-G1). Lantern semantic tokens (`--bg-plate`, `--text-primary`…) are remapped to Glass values so the long tail (settings, modals, admin) turns Glass without edits |
| `.pc-pressable` 0.96 press scale | "Nothing scales on press" (§9) | **Changed** (WP-G0 for new primitives, WP-G21 for the rest) |
| `lib/motion/*` (FLIP, View Transitions, springs, presence) | Pill → stage shared-element, 600–650ms springs, 120ms hover | **Reused**. `sharedElement.ts` already does View Transitions with a FLIP path |

### 1.2 New components

All new code lives under `client/src/components/glass/` and `client/src/lib/room/`,
so parallel packages own directories, not lines in shared files.

```
components/glass/primitives/   G0   GlassButton, TextButton, JoinButton, IconCircle, Capsule,
                                    Kicker, CountBadge, MentionChip, Glyph (listen/watch/clip/
                                    flame/theater/split), Waveform, Face/FaceStack, FocusRing
components/glass/room/         G8   RoomBackdrop (one canvas), useRoomLight
components/glass/shell/        G7   GlassShell, pane geometry, overlay for < 860px
components/glass/places/       G9   PlacesPanel, ServerRow, ServerTitle, ChannelRow (text / live /
                                    quiet), ComingUp, HomePlaces (DM rows)
components/glass/conversation/ G11  ConversationPane, ConversationHeader, CallPillSlot
components/glass/pill/         G12  CallPill (compact, expanded, collapse order)
components/glass/stage/        G14  Stage, StreamSurface, CameraTiles, PeopleChips, StageControls
                               G15  Theater, Browse, SurfacingMessages, pill↔stage transition
                               G16  ClipToast        G17  StreamReactionsLayer
components/glass/sheets/       G18  SearchSheet, PeopleSheet, AccountMenu, ChannelMenu, ServerMenu
lib/room/                      G8   sampler, clamps, easing, token writer, source selection
lib/media/clips/               G16  ring buffer, muxer, useClip
stores/glassStore.ts           G7   layout state (below)
```

**`stores/glassStore.ts` contract** (created by WP-G7, consumed by everyone):

```ts
type StageMode = 'none' | 'side' | 'theater';
interface GlassState {
  stage: { mode: StageMode; guildId: string | null; channelId: string | null; streamerId: string | null };
  browseOpen: boolean;          // S
  chatHidden: boolean;          // H (theater only)
  pillExpanded: boolean;
  placesOverlayOpen: boolean;   // window < 860px
  sheet: null | 'search' | 'people' | 'account' | 'channel' | 'server';
  openStage(t: { guildId: string; channelId: string; streamerId: string }, mode?: StageMode): void;
  closeStage(): void;           // Esc, "Stop watching"; never leaves a call
  setStageMode(m: Exclude<StageMode, 'none'>): void;
  toggleBrowse(): void; toggleChatHidden(): void;
  setPillExpanded(v: boolean): void; openSheet(s: GlassState['sheet']): void; closeSheet(): void;
}
```

Watching is store state, not a route: browsing channels while the stream plays
(§6.3) only works if the stage outlives navigation. Routes stay as they are
(`/app/guilds/:g/channels/:c`, `/app/dms/:c`); a voice channel route shows that
channel's conversation (its text chat) with the pill for it.

**Media contract** (added to `voiceStore` by WP-G6, consumed by G8/G12/G14):
`listen(channelId)`, `joinFromListen()`, `openView(channelId, streamerId, 'watch' | 'ambient')`,
`closeView(viewId)`, plus selectors `useLiveChannel(guildId)` (busiest live channel)
and `useStreamFrameTap(channelId, streamerId)` (≤ 4 Hz `ImageBitmap`s, extending
`lib/media/roomFrameTap.ts`).

**Frame source contract** (`lib/room/frameSource.ts`, written by WP-G2 so the
fixture and the real sources share it; WP-G8 owns it afterwards):
`interface FrameSource { subscribe(onFrame: (f: ImageBitmap) => void, hz: number): () => void }`.
Implementations: stream (G6's tap), image (banner/icon), fixture (DEV only).

### 1.3 Features with no place in Glass (owner must decide; nothing is dropped silently)

| Feature (where it lives now) | Proposed home in Glass |
|---|---|
| **Server home** with admin-configured widgets (`rooms/lobby/*`, `HomePageSettings`; the approved "server home as a place" pillar) | A first row "Overview" in the places panel above the channels, opening the server home inside the conversation pane, restyled. Alternative: open it from the server title menu |
| **App Home** (Needs you, Pick up, Around now, Coming up across servers) | Selecting the tray shows DMs as channel-style rows in the places panel; the conversation pane, with no DM selected, shows a restyled "For you" (Needs you + Pick up) |
| **Friends**, Discovery, Templates, Admin, Developer pages | Friends as a row at the top of Home's places list; Discovery/Templates behind `+`; Admin/Developer in the avatar menu |
| **Inbox, reminders, saved messages** (TopBar overflow, `overlays/InboxOverlay`, `RemindersPane`) | Home places list ("Mentions", "Saved") rows; reminders in the avatar menu |
| **Pins, threads list, media gallery, catch-up summary, follows, leaderboard, notification settings** (TopBar, ContextPanel) | Channel menu opened by clicking the channel title; each opens as a sheet over the column. A thread opens as a pushed conversation (title + back) in the same 720px column |
| **Soundboard, Watch/Listen together, device menu, invite, connection check** (VoiceStageChannel, VoiceControlBar) | The stage controls have no overflow. Proposal: one icon-only "More" glass circle after the divider, only when joined; device menu also on right-click/long-press of mic |
| **Split pane (two streams), layout modes** (Focus/Split/PiP/Share only) | Retire Split and PiP; switching streams is a click on a streamer's tile/chip. Flag: owner may want to keep Split |
| **Deafen** (AccountPlate, VoiceControlBar) | Not in any Glass control set. Proposal: in the expanded pill and the mic's device menu |
| **Stage channels** (type 13: audience, request to speak) | Treat as live voice channels; audience = Listen (receive-only already, via `suppress`); "Request to speak" as a text decision in the pill |
| **Voice channel text chat** (`pages/guild/RoomChat.tsx`) | The live row opens the stage, so the chat needs another door. Proposal: "Open Lounge chat" in the expanded pill; a voice channel with nothing live opens its chat from its row |
| **Add-on rows** (Sports, Daily word, Game servers, feeds) in the sidebar | Channel rows with a glyph tile, same 64px row |
| **Account plate** (status, custom status, mute/deafen, settings) | Avatar at the pane's right edge opens the account menu |
| **Layout tour / coach marks** (`onboarding/LayoutTour.tsx`) | Retire; the anchors it points at are gone. Rewrite later if wanted |
| **Mobile bottom nav** (Home/Messages/Server/Friends/Settings) | Spec §8: places panel is its own screen, no rail. Back chevron in the header; avatar opens settings |
| **Red/green** (danger buttons, DND presence, error states, success toasts) | §1.3 bans them in chrome. Proposal: keep one restrained danger ink only inside destructive confirm dialogs and error text; DND/idle presence as ink-level dots, not colors |
| **Many servers** in the 316px server row (fits about 5) | Horizontal scroll with edge fades, current server kept in view |

---

## 2. The looks: recommendation

**Recommendation: Glass becomes the only layout and the only look. Retire Dusk,
Paper, Slate, Aubergine, Daylight (light), AMOLED, the accent presets, the
base-hue/tint controls and the rows/bubbles switch. Keep, as accessibility
settings rather than looks: High contrast (re-derived for Glass: opaque panes,
ink-2/ink-3 raised, visible hairlines), Reduced transparency (spec §4), Reduced
motion (exists), and Custom CSS.**

Reasons:

1. **The layout changes, not only the colors.** Every look is a token palette on
   Lantern's street/plate skeleton (`tokens.css` §1.8, `looks.css`). Keeping them
   means either keeping the Lantern shell beside Glass (two code paths for every
   surface) or redesigning four looks for Glass that nobody has reviewed.
2. **No-fallbacks.** One deterministic path per capability. Two shells or five
   palettes are five ways for a surface to be subtly wrong, and every one of them
   is a contrast audit and a screenshot set.
3. **Glass's color is dynamic by design.** "What's live supplies the color"
   (§1.2): the room tint *is* the variation. A user-picked accent or ground fights
   that rule and the amber/white semantics.
4. **Cost.** `scripts/contrast-audit.mjs` sweeps hue × tint × theme; it would
   have to sweep room samples × looks too.

**Risk to raise with the owner:** on 2026-09-20 the owner asked for several looks
to ship as options and said they want choice kept in Settings. This
recommendation reverses that. If they want a choice, offer a Glass-native light
variant later, designed and reviewed first, not the old palettes remapped.

**Migration (WP-G1):** the server stores the theme as an opaque string
(`crates/paracord-api/src/routes/users.rs:37`, `DEFAULT_THEME = "slate"`).
New ids: `glass` (default) and `glass-contrast`. `asThemeId()` already collapses
unknown values to the default, so stored `slate`/`paper`/… become `glass` on
read; change `DEFAULT_THEME` in both places and add a unit test for the
collapse.

---

## 3. Spec §10 against the code

| Spec item | What exists (evidence) | New work |
|---|---|---|
| **Room light**: "nothing server-side" | Frame sampling exists **only inside a joined call**: `lib/media/roomFrameTap.ts` (≤ 2 Hz `ImageBitmap`s) returns `reason: 'not-joined'` otherwise. On the Linux native-surface route frames never reach JS (`src-tauri/src/native_media/video_pipeline.rs:714-724`). Banner: `GuildSummary.banner_hash`, `resolveBannerUrl` (`lib/userAvatar.ts:44`) | **Spec is wrong here.** Screen 01 lights the room with Lounge's stream while not joined. Needs a receive-only, video-only, lowest-simulcast-layer **view session** (WP-G5, WP-G6), and a Rust command that hands a 32×18 downscale to JS on the native-surface route (WP-G8) |
| **Watch without joining** (§6: "watching never joins the call") | **Missing.** `watchedStreamerId`/`previewStreamerId` only work in a joined call (`ServerHome.tsx:241-253` joins before watching) | Same view session, `quality: 'watch'` (WP-G5, WP-G6) |
| **Listen in** | Partial. Relay already supports receive-only participants: `MediaParticipant::with_can_publish(false)` (`crates/paracord-relay/src/participant.rs:61-89`, tests at `:319`, `relay.rs:3697`); stage flips it live (`routes/stage.rs:117`). No listen-only voice state; join is REST-only (`POST /api/v2/voice/{id}/join`, `routes/voice.rs:414`). Per-channel settings table exists: `channel_feature_settings` + `GET/PATCH /api/v1/channels/{id}/features` | `voice_states.mode` (`full`/`listen`), join with `mode`, in-place upgrade (flip `can_publish`, update state, dispatch), `listen_in_enabled` feature flag (default on), roster "Listening in" (WP-G5) |
| **"LIVE 42 MIN", "live for 42 min"** | Not on the wire. `lib/attention/litHistory.ts` only knows what this client observed (a lower bound) | `voice_states.self_stream_started_at TEXT` set when `self_stream` flips on (WP-G5) |
| **"2 watching"** (phone) | Missing | Watcher count per stream from view sessions, dispatched on change (WP-G5). Lowest priority; phone only |
| **Talking waveform for non-joined viewers** | Exists: `VOICE_SPEAKING` fans out to guild members who can view the channel (`paracord-core/src/voice_speaking.rs:8`) | None |
| **Clips** ("nothing new beyond attachments") | Encoded frames reach JS on the canvas routes: `MediaVideoDecoder.decode(data, ts, isKey)` (`lib/media/video/videoDecoder.ts:320`), `ParsedPulledVideoFrame` carries codec vp9/h264/av1 (`pulledVideoFrame.ts:17-27`). No ring buffer, no muxer, no `MediaRecorder`. Attachments: `fileApi.upload` (`api/files.ts:360`), limit `min(max_upload_size, guild max_file_size)`, default 50 MB; `video/webm`, `video/mp4` inline-safe (`routes/files.rs:193`) | Correct that the server needs nothing, **given** a view session to watch without joining. Client: ring buffer at decoder intake (JS) and in Rust for the native-surface route; a WebM/MP4 muxer (none in `package.json`) (WP-G16) |
| **Reactions on the stream** | No such event. Template: `SOUNDBOARD_PLAY` (`routes/soundboard.rs:~535-620`: checks voice state, cooldown in `DashMap`, recipients from `get_channel_voice_states`, `dispatch_to_users`) | `POST /api/v2/voice/{id}/stream-reactions` → `STREAM_REACTIONS`, recipients = members + watch viewers, 1/s/user, coalesced per channel every 250ms (WP-G17) |
| **Channel row previews** | `last_message_id` on channels; read states (`GET /users/@me/read-states`, `read_states.mention_count`); badges from `hooks/useUnreadCounts.ts`. **No preview content**: Home fetches `GET /channels/{id}/messages?limit=1` per conversation (`components/home/useHomeMessagePreview.ts:128`) | Batch endpoint `GET /api/v1/guilds/{id}/channel-previews` → per viewable channel `{channel_id, message_id, author_id, content (≤ 140 chars), created_at, media?: {attachment_id, content_type}}`; E2EE content omitted (WP-G4) |
| **Faces on rows, "8 online, 3 in Lounge"** | Exists client-side: READY presences (`gateway/dispatch.ts:227`), voice states in READY, `countLightsOn` (`lib/attention/personLight.ts:80`) | None |
| **Plan card, "Take the spot", "1 spot left"** | Events with RSVP exist (`scheduled_events`, `event_rsvps`; routes `lib.rs:568-587`; `EventList.tsx`, `useUpcomingEvents.ts`). Polls exist (`polls`, `poll_options`, `poll_votes`; `PollMessageCard.tsx`). **No capacity, no slots, no event-in-message embed** | Per spec: render events (RSVP = "Take the spot" / "You're in", faces of RSVPs) and polls in plan-card style; plans later. An event card in the timeline needs a message that links the event (portable link unfurl). "1 spot left" needs an event `capacity` column: optional, owner decides |
| Channel topic | `channels.topic`, `channel.types.ts:27` | None |

**Backend total:** WP-G4 (previews), WP-G5 (listen mode, view sessions, stream
start time, watcher count, listen-in setting), WP-G17 (stream reactions). All
touch `crates/paracord-api/src/lib.rs`, `paracord-models/src/gateway.rs`,
`contracts/api-contracts.json` and the generated client types, so they run one
after another. Every migration goes in both `migrations/` and `migrations_pg/`,
timestamps as `TEXT`, booleans bound as `bool` (CLAUDE.md).

**View-session design constraints for WP-G5/G6** (the hard part):

- The relay requires a room membership with a matching session, and today that
  only comes from a join that writes `voice_states`. Add a membership kind that is
  receive-only, is not a voice state, is not in presence, and (for `ambient`) is
  pinned to simulcast layer 0 at a capped frame rate. The relay already selects
  layers per viewer (`paracord-relay/src/relay.rs:870`).
- A user may hold one call membership and one view session at a time (in a call
  in server A while the room of server B is lit by its stream). The media engines
  (`browserMediaEngine.ts`, `tauriMediaEngine.ts`) must hold a second, lightweight
  session. If a user is already joined or listening in the same channel, the view
  subscribes through that membership instead: deterministic, not a fallback.
- Permission: VIEW_CHANNEL + CONNECT for `watch`/`listen`; VIEW_CHANNEL for
  `ambient`. Ambient viewers are not counted as watching.

---

## 4. Work packages

Tiers per the owner's rule: **Sonnet** for well-defined, mostly UI work; **Opus**
for cross-cutting, media, backend or tricky state. Size: S ≈ half a session,
M ≈ one session, L ≈ a full session. Every package writes
`docs/design/glass-gN-checkpoint.md` (what changed, screenshots, what is left),
does not commit (the orchestrator commits, staging paths by name), and updates or
deletes the tests of whatever it replaces in the same package (no skipped tests).

Common acceptance for every client package: `npm run typecheck`,
`npm run test:unit`, `npm run test:tokens`, `npm run test:motion-lint`,
`npm run lint`, and its own Glass screenshots (§5) at 1440×900 and 390×844 held
against the named reference.

| WP | Goal | File scope (may edit) | Depends on | Tier | Size |
|---|---|---|---|---|---|
| **G0** Foundation | §2 tokens: Glass block in `tokens.css` with neutral steps derived so both reference tints reproduce (warm and cool, ΔE < 2) from `--room-rgb` at 5% (cap 6%) via `color-mix()`; fixed colors; ink ramp; shapes, shadows; remap Lantern semantic tokens (`--bg-*`, `--text-*`, `--accent-primary` → cream) onto Glass. Self-host Instrument Sans variable with `wdth` (`@fontsource-variable/instrument-sans/wdth.css`, verified to ship `wdth` files). Type utilities incl. the instrument cut. Glyphs (§2.5) and the Waveform (real voice level when given, reduced-motion still). Glass primitives. A Glass section on `/design-tokens`. Contrast audit covers Glass ink on every surface at both reference tints and at the clamp extremes WP-G8 will use | `styles/tokens.css`, `styles/glass.css` (new), `styles/globals.css` (import only), `main.tsx` (font import), `package.json`, `package-lock.json`, `components/glass/primitives/**`, `pages/DesignTokensPage.tsx`, `scripts/contrast-audit.mjs` | none | Sonnet | M |
| **G1** Retire the looks | Per §2 (after owner confirms): `THEME_IDS` → `glass`, `glass-contrast`; delete look blocks and `looks.css`; accent presets, base hue/tint, message-style switch out of `uiStore`, `useTheme`, Settings › Appearance (add Reduced transparency); server `DEFAULT_THEME = "glass"` | `lib/themes.ts`, `hooks/useTheme.ts`, `stores/uiStore.ts` (theme fields only), `styles/looks.css`, `styles/tokens.css` (theme blocks only), `components/customization/ThemeSelector.tsx`, `components/user/UserSettings.tsx` (appearance section), `scripts/contrast-audit.mjs`, `crates/paracord-api/src/routes/users.rs`, their tests | G0, owner | Sonnet | M |
| **G2** Mocked review harness | `e2e/glass-review.spec.ts` + a `PARACORD_E2E_GLASS=1` project in `playwright.config.ts`, modeled on `design-review.spec.ts` (READY over SSE carrying voice states and presences). The reference scene as fixtures: Game Night (General, Lounge live, Clips, LFG, quiet Patch notes; Haz 5 run event; Movie night; poll), Basecamp (Trips/General/Photos/Gear, banner), cast Sean (self), Vincent (streaming), Brendan (camera, talking), Nick (muted), Jeremy, Luke, Eric; read states for the badges; the 41:07 image; a mention; typing. Named states `01-conversation` … `07-phone` driven by clicks/keys once they exist. A **dev-only fixture frame source** (a looping canvas scene, stripped from production like `/design-stage`) so stream, stage and room light can be shot without a media server | `client/e2e/glass-review.spec.ts`, `client/e2e/fixtures/glass/**`, `client/playwright.config.ts`, `client/src/lib/room/frameSource.ts` + `fixtureFrameSource.ts` (new, DEV only) | none | Sonnet | M |
| **G3** Live scene driver | `client/scripts/glass-scene.mjs` against `scripts/live-env.mjs` (or `pc-lab.sh`): registers the cast, creates both servers with icons and banner, channels, messages (incl. image, reply, mention), event, poll; joins three Chromium accounts to Lounge with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (as `e2e/real-server.voice-join.spec.ts` does), overrides `getDisplayMedia` with a `canvas.captureStream()` warm/teal scene for Vincent's share, and holds the call until killed. `--shot <state>` captures Sean's view. Real stream = the only way to verify room light, watch, clips on real frames | `client/scripts/glass-scene.mjs`, `client/scripts/glass-scene/**` | none | Opus | M |
| **G4** Backend: channel previews | Batch previews endpoint (§3), SQLite + PG query with an index check, permission filtering (VIEW_CHANNEL), E2EE omitted, contract export, client `api/channels.ts` method + generated types, route tests on both engines | `crates/paracord-api/src/routes/channels/**`, `crates/paracord-api/src/lib.rs` (route line), `crates/paracord-db/src/**` (new query module), `crates/paracord-api/tests/channel_previews.rs`, `contracts/api-contracts.json`, `client/src/api/channels.ts`, `client/src/api/generated/**` | none | Opus | M |
| **G5** Backend: listen and view sessions | `voice_states.mode`, `self_stream_started_at` (migrations both engines, constant default then backfill); join with `mode`; `POST /api/v2/voice/{id}/mode` in-place upgrade (flip `can_publish`, no reconnect); `POST/DELETE /api/v2/voice/{id}/view` (ambient/watch) with relay membership kind, layer-0 pin for ambient; watcher count event; `listen_in_enabled` in `channel_feature_settings` (default true; 403 `listen_in_disabled`); READY and `VOICE_STATE_UPDATE` carry the new fields; tests incl. relay unit tests and PG route smoke | `crates/paracord-api/src/routes/voice.rs`, `routes/channel_features*`, `lib.rs` (route lines), `crates/paracord-db/**` (voice_states, channel_features, migrations, migrations_pg), `crates/paracord-relay/**`, `crates/paracord-transport/**` (claims only), `crates/paracord-models/**`, `crates/paracord-ws/src/handler.rs` (READY fields), `crates/paracord-api/tests/**` (new files), contracts + generated types | G4 (serial on shared files) | Opus | L |
| **G6** Client media sessions | `voiceStore` actions of the media contract (§1.2); second lightweight session in `browserMediaEngine` and `tauriMediaEngine`; `roomFrameTap` works for view sessions; gateway handling of the new voice fields and watcher counts; `api/voice.ts`; listen-in toggle in channel settings. Unit tests per action; live check with G3 | `client/src/stores/voiceStore.ts`, `stores/voice/**`, `lib/media/**` (except `lib/media/clips`), `api/voice.ts`, `gateway/dispatch.ts` + `gateway/events.ts` (voice events only), `types/voice.types.ts`, `components/guild/ChannelManager.tsx` (one toggle), `client/src-tauri/src/native_media/**` (session plumbing) | G5 | Opus | L |
| **G7** Shell | Replace `AppShell` with the Glass frame: two panes, 16px gutters, radius 28, full height; conversation column 720px centered, fluid < 1100px, places overlay < 860px; slots for RoomBackdrop, PlacesPanel, ConversationPane, Stage, sheets (stubs with fixed props for the owners below); `glassStore`; `GuildPage`/`DMPage`/`TextChannelView` render `ConversationPane`; settings dialogs, command palette, focus traps and skip link kept. Phone path left working (G20 replaces it) | `pages/AppShell.tsx`, `pages/GuildPage.tsx`, `pages/guild/TextChannelView.tsx`, `pages/DMPage.tsx` (frame only), `stores/glassStore.ts`, `components/glass/shell/**`, stubs in `components/glass/{room,places,conversation,pill,stage,sheets}/index.ts`, `styles/glass-layout.css`, `pages/AppShell.test.tsx` | G0 | Opus | M |
| **G8** Room light | §4: one canvas backdrop at 32×18, blur and grading done in the canvas pixels (no CSS `filter`, no `backdrop-filter` on panes), scaled up; source = busiest live channel of the current server via an ambient view, else banner, else icon; sample 2–4 Hz, ease 1–2s, clamp S/L; write only `--room-rgb` (channel numbers, so the token lint passes) at ≤ 4 Hz with CSS color transitions doing the blend; 1.2s crossfade on server switch (two canvases, opacity); reduced transparency; Rust `native_render_sample` command for the native-surface route. Budget test: no style recalc storms (a unit test on write rate) | `lib/room/**` (except fixture), `components/glass/room/**`, `styles/glass-room.css`, `client/src-tauri/src/native_media/**` (sample command only) | G6, G7 | Opus | M |
| **G9** Places panel | §3.1 exactly: server row (tray + badge, hairline, 40px circles, white 14×3 bar, amber ring when live, `+`), server title + line + menu trigger, channel rows (text 64px with faces/media/glyph lead, preview, time, badge; live 92px with stream or room tint, LIVE kicker, faces, waveform, "Vincent is streaming"; quiet 44px), selected/hover, Coming up; Home mode lists DMs; add-on rows; keyboard roving; overflow scroll of the server row. Previews from G4 kept live by `MESSAGE_CREATE` | `components/glass/places/**`, `hooks/useChannelPreviews.ts` (new), `styles/glass-places.css` | G7, G4 | Sonnet | L |
| **G10** Timeline bubbles | §3.2 messages: bubble markup and CSS, grouping with joined corners (first/middle/last, mirrored for own), avatar at the bottom of the group, name/time above the first bubble, own right-aligned light, mention bubble `--raise` + white chip, hover actions (react/reply/more 26×22) beside name and time and on focus-within, typing bubble, 28px fade under the header, bottom-anchored. Keep virtualization, keyboard nav, edit, reply, threads, bulk delete. Rewrite the MessageList tests that assert Lantern markup | `components/message/MessageList.tsx`, `TimelineParts.tsx`, `messageLight.ts`, `styles/glass-timeline.css`, `components/message/MessageList*.test.*` | G7 | Opus | L |
| **G11** Header and composer | 76px header (title/topic at the column edge, pill slot right-aligned to the column, search/people/avatar with presence dot at the pane edge, opening G18's sheets via `glassStore`); the channel title opens the channel menu; composer capsule (52px, column width, `+`, reply chip "Jeremy ×", emoji, send quiet→cream), keeping drafts, slash commands, mentions, uploads | `components/glass/conversation/**`, `components/message/MessageInput.tsx`, `MarkdownToolbar.tsx`, `SlashCommandPopup.tsx`, `MessageInput*.test.*`, `styles/glass-conversation.css` | G7 | Sonnet | M |
| **G12** Call pill | §5: compact (faces, name / cross-server name, waveform, not-joined: Listen, Watch, mute preference default muted, Join; joined: mic, Watch, Leave), expanded to column width ~222px with 256×144 preview (ambient view) and roster states incl. "Listening in" and the listening notice, spring 550ms via transform; collapse order when short; near-solid popovers; phone two-row variant (§8). Wired to G6 actions; Watch calls `glassStore.openStage` | `components/glass/pill/**`, `styles/glass-pill.css` | G6, G7 | Sonnet | M |
| **G13** Timeline cards | Media with joined corner and soft shadow; reactions as one chip biting the media's top-right (`#34353a`, 3px `--solid` ring); catch-up divider "6 new since 8:58" + Mark read; inline live-channel chip and event chip in message content; plan card for events (RSVP as Take the spot / You're in, faces, names hide under 340px) and polls; event link unfurl | `components/message/MessageList.tsx` (reaction and attachment render only), `PollMessageCard.tsx`, `components/file/MediaPreview.tsx`, `lib/markdown.ts` (chip rendering), `components/glass/cards/**`, `styles/glass-cards.css` | G10 | Sonnet | M |
| **G14** Stage: side by side | §6.1: stage pane (radius 28, `--deep`, stream-sampled side glow), stream 16:9 radius 18 with top overlay, camera tiles (talker amber edge + glow), people chips column, controls row (not joined / joined sets), "More" per §1.3, stream switching, Esc/Stop watching, conversation narrows to 420px and keeps working; watch without joining via G6; stubs for `useClip()` and `StreamReactionsLayer`. Reuse `CanvasRenderer`/`NativeVideoTile`, `useWebcamTiles`. Replaces `VoiceStageChannel` for the watching path | `components/glass/stage/**` (except the G15–G17 files), `lib/media/clips/useClip.ts` (stub signature only), `styles/glass-stage.css` | G12, G6 | Opus | L |
| **G15** Theater, browse, transitions | §6.2 theater (stream fills window, 380px chat column, talker tile + 52px faces, centered controls capsule, H hides chat, surfacing messages with mention edge), §6.3 browse (S: places slides in, stage grows to 1076px, picking a channel closes it and brings that conversation back), pill↔stage shared element (650ms, View Transitions with FLIP path in `lib/motion/sharedElement.ts`), keyboard S/T/H; reduced motion = 150ms crossfades; native underlay handled (§6) | `components/glass/stage/Theater*.tsx`, `Browse*.tsx`, `SurfacingMessages.tsx`, `stageTransition.ts`, `lib/motion/sharedElement.ts`, `hooks/useGlassKeybinds.ts` (new), `styles/glass-stage-modes.css`, `scripts/motion-lint.mjs` (named allowances only) | G14, G9 | Opus | L |
| **G16** Clips | §6.4: 30s ring buffer from the last keyframe before now−30s at the decoder intake (JS routes) and in Rust (native-surface route), stream audio included when present; mux (WebM for VP9/AV1+Opus, MP4 for H.264) with a small vendored muxer; C key; toast (thumbnail, "Saved the last 30 seconds", source and time, Post to General, dismiss); posting uploads via `fileApi.upload` and sends a message; clip bubble with play button and "0:30 from Vincent's screen"; upload-limit error shown, never silently shortened | `lib/media/clips/**`, `components/glass/stage/ClipToast.tsx`, `lib/media/browserMediaEngine.ts` + `tauriMediaEngine.ts` (intake tap lines only), `client/src-tauri/src/native_media/**` (clip buffer), `components/file/MediaPreview.tsx` (clip label), `package.json` | G14, G6 | Opus | L |
| **G17** Stream reactions | Server: endpoint + `STREAM_REACTIONS` per §3 with tests; client: dispatch → store, flame/heart buttons, rising faces from bottom-right (~270px, fade), merged when busy; reduced motion = brief in place | server: `routes/voice_reactions.rs` (new), `lib.rs` (route line), `paracord-models/src/gateway.rs`, tests, contracts; client: `gateway/dispatch.ts` + `events.ts` (one event), `stores/streamReactionStore.ts`, `components/glass/stage/StreamReactionsLayer.tsx`, `api/voice.ts` (one method) | G14, G5 (serial on server files) | Opus | M |
| **G18** Sheets and menus | Search sheet (reuse `SearchOverlay` logic), people sheet, account menu (status, settings, sign out, admin/developer, reminders), channel menu (pins, threads, media, summary, follows, leaderboard, notifications), server menu (invite, settings, notifications, mark read, mute, leave, create channel), threads as pushed conversation; near-solid popover glass | `components/glass/sheets/**`, `components/layout/overlays/**`, `components/message/ThreadPanel.tsx`, `components/media/MediaGalleryPanel.tsx`, `components/layout/GroupDmMembersPanel.tsx`, `components/guild/GuildEconomyPanel.tsx` (styles only) | G11 | Sonnet | M |
| **G19** Home, DMs, Friends, server home, forum | Per owner decisions in §1.3: Home conversation-pane content, DM conversation in the pane (DM calls through the pill), Friends, server home restyled in the pane, forum view in the pane, incoming-call banner restyle | `pages/HomePage.tsx`, `pages/DMPage.tsx`, `pages/FriendsPage.tsx`, `pages/GuildHomePage.tsx`, `components/home/**`, `components/rooms/lobby/**`, `components/channel/ForumView.tsx`, `components/dm/**` | G9, G11, owner | Sonnet | M |
| **G20** Phone shell | §8: places as its own screen, back navigation, stacked stream (overlays back / clip "30s" / fullscreen, "2 watching"), two-row pill, header with "6 NEW" kicker, composer with reply chip; remove `MobileBottomNav`; swipe-back. Components already have their phone variants; this is the frame and navigation | `components/glass/shell/**` (phone files), `pages/AppShell.tsx` (phone branch), `components/layout/MobileBottomNav.tsx` (delete), `hooks/useSwipeGesture.ts` | G9, G11, G12, G14 | Sonnet | M |
| **G21** Long tail restyle | Everything not rebuilt looks Glass: `components/ui/**` (no press scale, 120ms hover steps, radii 8–12, focus ring §9), modals, Settings and Server settings, context menus, toasts, tooltips, command palette, pickers, auth pages; check each against tokens | `components/ui/**`, `styles/primitives.css`, `styles/components.css`, `pages/SettingsPage.tsx`, `pages/GuildSettingsPage.tsx`, `components/guild/**` (settings sections), `components/user/**`, `components/layout/CommandPalette.tsx`, `ChannelSwitcher.tsx`, `components/message/{EmojiPicker,GifPicker,StickerPicker}*`, auth pages | G1 | Sonnet | M |
| **G22** Retire Lantern | Delete what nothing imports: `components/light/**`, `layout/sidebar/**`, `ContextPanel`, `TopBar`, `OnAirDock`, `VoiceStageChannel`/`StreamViewer`/`SplitPane` leftovers, `StagePreviewPage`, `LayoutTour`, Lantern CSS; rewrite `motion-gate.spec.ts` for Glass moments (hover step, pill expand, pill→stage, theater, browse, room crossfade) and `smoke.spec.ts`; update `docs/` (glass checkpoint summary; mark lantern-stage-spec superseded) | deletions across `client/src`, `client/e2e/motion-gate.spec.ts`, `client/e2e/smoke.spec.ts`, `client/e2e/design-review.spec.ts` (retire), `docs/**` | all client WPs | Sonnet | M |
| **G23** Live verification and WebKitGTK performance | Full scene on a real instance (G3) in Chromium and in the Tauri desktop app on this Linux box (WebKitGTK 2.52): all seven states, listen, watch without joining, clip posted and playable, reactions between two accounts, server switch crossfade. Measure `WebKitWebProcess` CPU with a live stream + room light + stage; fix within scope or file findings. Full gate (§5.3) | fixes only, each named in the checkpoint | all | Opus | L |

### 4.1 Order and parallel waves

```
Wave 1  G0 · G2 · G3 · G4              (four in parallel; G4 is server-only)
Wave 2  G1 (owner) · G7 · G5 (after G4)
Wave 3  G9 (G7+G4) · G10 · G11 · G6 (after G5) · G21 (after G1)
Wave 4  G8 (G6+G7) · G12 (G6+G7) · G13 (G10) · G18 (G11) · G19 (G9+G11)
Wave 5  G14
Wave 6  G15 · G16 · G17                  (disjoint files inside components/glass/stage)
Wave 7  G20 · G22
Wave 8  G23
```

Critical path: G0 → G7 → G11/G9 → G12 → G14 → G15 → G20 → G23, with the backend
chain G4 → G5 → G6 feeding G12 and G14. Server packages never run in parallel
with each other (shared route table, gateway constants, contracts).

Parallel packages do not share files, with one explicit rule: the stub files G7
creates (`components/glass/*/index.ts`) and G14 creates (`useClip.ts`,
`StreamReactionsLayer.tsx`) belong to the package that fills them from then on.

---

## 5. Verification

### 5.1 Running the app

| What | How |
|---|---|
| Fast visual loop (UI only) | `~/Documents/Paracord-wt/tools/pc-lab.sh up <port>` from the worktree root: debug server + Vite with hot reload + demo seed. Then `node client/scripts/glass-scene.mjs --base http://127.0.0.1:<port>` (G3) to add the Glass scene. Note: pc-lab copies `client/dist` from the main checkout when it is missing (build first) and `pc-shot.mjs` resolves Playwright from the main checkout; prefer G2/G3's own shots |
| Mocked states (no server) | `cd client && PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g9 npx playwright test e2e/glass-review.spec.ts` → `output/design-reference/glass-build/g9/<state>-{desktop,phone}.png`. Stream, stage and room light use the DEV fixture frame source |
| Real stream | `cd client && npm run build`, `touch crates/paracord-server/src/embedded_ui.rs`, `pc-cargo.sh build --release --bin paracord-server`, confirm the served `assets/index-*.js` matches `client/dist` (stale embed is a known trap), `node scripts/live-env.mjs`, then `node client/scripts/glass-scene.mjs --shot all` |
| Desktop (WebKitGTK) | `VITE_DEV_PROXY_TARGET=http://127.0.0.1:18420 npx tauri dev` from `client/`; the other cast members stay in Chromium via G3. CPU: `top -b -n 30 -d 1 -p $(pgrep -d, WebKitWebProcess)` |

Every agent **reads its screenshots and the matching reference PNG with the Read
tool** and lists differences in its checkpoint. Screenshots go in
`output/design-reference/glass-build/` (gitignored).

Cargo builds go through `~/Documents/Paracord-wt/tools/pc-cargo.sh` (RAM limit,
two slots). Keep one `target/` for the worktree.

### 5.2 Which state proves which package

| Reference | Proves |
|---|---|
| `01-conversation` | G0, G7, G8 (warm), G9, G10, G11, G12 (compact, not joined), G13 |
| `02-quiet` | G8 (cool, banner source), G9 (quiet rows, media lead), G12 (cross-server name) |
| `03-listen` | G6 + G12 (expanded, Listening) |
| `04-side-by-side` | G14 (joined), G16 (toast), G17 (reactions), G13 (plan card narrow) |
| `05-theater` | G15 (theater, surfacing messages, mention edge) |
| `06-browse` | G15 (browse, not joined controls) |
| `07-phone` | G20 + every component's phone variant |

### 5.3 Suites that must stay green

- Client: `npm test` (typecheck, unit, token lint, motion lint), `npm run lint`,
  `npm run test:a11y:static`, `npm run test:contrast`, `npm run build`,
  `npm run test:e2e` (mocked smoke), `PARACORD_E2E_REAL=1 npx playwright test`
  (real server incl. voice join), `npm run contracts:check`.
- Rust (for G1, G4, G5, G17): `cargo fmt --all -- --check`,
  `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, the
  PostgreSQL route smoke (`cargo test -p paracord-api --test postgres_route_smoke`
  with a PG URL configured), `cargo check --manifest-path client/src-tauri/Cargo.toml --all-targets`
  for G6/G8/G16 (with `vpx` on; never disable it).
- `client/scripts/live-drive.mjs` once at G23 (messaging regressions).
- The motion gate is rewritten in G22; until then Lantern cases that test deleted
  surfaces are deleted by the package that deletes the surface.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **WebKitGTK cost of blur and translucency** | No `backdrop-filter` on panes (near-solid). The room is one small canvas upscaled; blur, saturation and brightness are computed in the 32×18 pixels, never a full-window CSS `filter`. `backdrop-filter` only on the pill, message box, stage controls and popovers. G23 measures CPU with a stream running |
| **Room token churn** | JS writes one variable (`--room-rgb`) at ≤ 4 Hz; `color-mix()` derives the rest; panes use CSS color transitions to blend between writes. Never register an animated custom property on `:root` (a per-frame style recalc of the whole app) |
| **Native underlay on Linux** (video under the webview through a hole) | Glass controls over native video cannot blur it: controls must be legible without blur (near-solid fills). The pill→stage transition cannot animate a native surface: show the last sampled frame as a poster during the move and attach the surface after settle. Sampling and clips need Rust hooks on this route (G8, G16). Decide the route per track as today (deterministic), never switch mid-stream |
| **Ambient view bandwidth and privacy** | Layer 0, capped fps, one ambient view per client, closed when the window is hidden or the server is not current. Owner decides whether ambient viewing is acceptable (§7) |
| **Token lint** (`npm run test:tokens`) | All literals in `tokens.css`; JS passes channel numbers, not `rgb(…)` strings; the canvas fixture and sampler get named allowances only if a canvas `fillStyle` truly needs a literal (precedent: `canvasRenderer.ts`) |
| **Motion lint** (only transform/opacity animate) | Pill expand and pill→stage via transforms and View Transitions; radius distortion under scale handled by animating an inner element or accepted for 650ms; any `clip-path` use needs a named allowance with its reason |
| **Contrast** on a moving tint | Contrast audit sweeps `--room-rgb` over the clamp box G8 enforces; ink-3 never below `rgba(240,243,243,.64)` |
| **Test churn** (350 unit test files; Lantern-specific: layout 16, message 23, voice 10, lobby 9, home 6, attention 12; motion gate 28 cases) | Each package owns the tests of what it replaces; `lib/attention` tests stay (data layer kept); smoke/motion gate rewritten once in G22, not piecemeal |
| **MessageList monolith** | G10 restyles in place, adds `isLastInGroup` from the next row, keeps `MessageRowMemo` deps accurate (a wrong dep list means stale bubbles). Reaction chips biting media need `overflow: visible` inside virtual rows; measure after images load |
| **Mobile** | Every component package ships its phone variant with a 390×844 shot; G20 only does the frame. The places overlay < 860px and the phone screen are different things; test both widths plus 768 |
| **E2EE previews** | Encrypted channels and DMs show no server preview; the client may show a locally decrypted cached preview, never decrypt just to preview |
| **Concurrent agents** | Work only in `~/Documents/Paracord-glass`; stage paths by name; never `git add -A` |
| **Scope** | §1.3 decisions first; any feature without a home is listed in a checkpoint, never removed quietly |

---

## 7. Decisions needed from the owner

1. **Looks:** retire all looks and the light theme; keep High contrast and
   Reduced transparency as accessibility settings (§2). This reverses the
   2026-09-20 "keep choices" request.
2. **Ambient view:** every member looking at a server with a live stream
   silently receives its lowest layer so the room can be lit (and the live row and
   pill preview can move). Acceptable? The alternative is the streamer publishing
   a still every second or two (cheaper, needs its own server path, less alive).
3. **What Watch plays:** proposal: Watch = the stream's video and its audio,
   not the voices; Listen = the voices. Both are visible to others ("2 watching",
   "Listening in"); ambient is not.
4. **Homes for features** in §1.3: server home (Overview row), App Home, the
   stage "More" button (soundboard, Watch together, invite, devices, connection
   check), deafen, Split pane (retire?), voice channel chat, stage channels.
5. **Red and green:** one danger ink for destructive confirms and errors only;
   presence without colored dots.
6. **Plans:** ship events/polls in plan-card style now; add event `capacity`
   (for "1 spot left" and the open slot) now or later?

---

## 8. Owner decisions (2026-09-29)

1. **Looks: retired.** Glass is the only layout and look. High contrast,
   Reduced transparency, Reduced motion and Custom CSS stay as settings.
   WP-G1 may proceed.
2. **Ambient view: accepted.** Members viewing a server with a live stream
   receive its lowest layer to light the room (capped fps, one per client,
   closed when hidden or on another server, never shown as watching).
3. **Watch = the stream (video + its own audio), Listen = the voices.** Both are
   visible to others; ambient is not.
4. **Defaults accepted:** "More" button in call controls (soundboard, Watch
   together, invite, devices, connection check); deafen in the mic menu; Split
   pane retired; voice channel chat beside the stage; stage channels use the
   stage look; server home is an "Overview" row; App Home keeps DMs and friends.
5. **One danger color**, only for destructive confirms and errors.
6. **Plans:** events and polls get the plan-card style now; event capacity
   later.
