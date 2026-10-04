# Index: build plan

How to build [`docs/index-spec.md`](../index-spec.md) in the `feat/index-ui`
worktree (`~/Documents/Paracord-index`, based on `design/glass` at `cd6239c9`),
next to two branches being built at the same time from the same base:

- `feat/send-flight` (`~/Documents/Paracord-send`): the send flight in
  `MessageInput.tsx`, `MessageList.tsx` and `lib/motion`.
- `feat/native-video` (`~/Documents/Paracord-video`): native video as the only
  desktop route (media engines, `native_render`, stage video surfaces).

Neither had commits or working-tree changes when this plan was written, so the
fences below come from what those branches are expected to touch (§2), not from
their diffs. The orchestrator re-checks both branches before each merge gate.

> **Before any agent starts:** `CLAUDE.md` has been copied into this worktree
> (untracked; it is gitignored). `client/node_modules` is installed. Reference
> renders at exact 1x are produced by `node client/e2e/index-reference.mjs`
> (already run once: `output/design-reference/index/ref/*.png`, ten states).

---

## 1. How Index maps onto the client

### 1.1 What is reused, rebuilt, retired

| Layer | Verdict |
|---|---|
| Data and actions: `voiceStore` (listen, watch, join, leave), `glass/pill/{model,useCallPill,pillActions,muteStore}.ts`, `glass/places/{model,rows,usePlacesData,useUnreadMessageCounts}.ts`, `useChannelPreviews`, `useRoomMenu`, `sheetStore`, `CommandPalette` logic, `SearchOverlay` logic, clips, stream reactions, Together | **Reused** as-is (edits only by the named owner) |
| Stage video internals: `StreamSurface`, `CameraTile` (`StagePeople.tsx`), `useNativeUnderlay`, `useStreamPoster`, `ClipToast`, `StreamReactionsLayer`, `SurfacingMessages`, `StageChannelPanel`, `StreamSound` | **Composed unchanged** by the Index call view (fenced for `feat/native-video`, §2) |
| `MessageList`, `TimelineParts`, `MessageInput` | **Restyled in place** after the send-flight merge (M1) |
| Sheets (`glass/sheets/**`), cards (`glass/cards/**`), settings, long tail | **Restyled in place** |
| Frame, sidebar, dock, room card, call view, conversation chrome, People | **New** under `client/src/components/ix/` |
| Room light (`glass/room`, `lib/room`, ambient view use), call pill UI, places panel UI, compact overlay, browse, Home sections, `messageLight` | **Retired** (index-spec §12) |

### 1.2 New code layout

```
components/ix/identity/      IX-1   Avatar, ServerMark, PresenceDot
components/ix/primitives/    IX-1   CreamButton, Control, WideControl, ToolChip, SectionLabel, Hairline
components/ix/glyphs/        IX-1   the prototype's glyph set (stroke 1.7)
components/ix/motion/        IX-4   flipFromRect, slidePanes, crossfadeLayers, onSettle (Index-only helpers;
                                    lib/motion stays untouched until M1)
components/ix/shell/         IX-4   IxFrame, TintLayers, Toolbar, slots.ts; phone/ (IX-16)
components/ix/page/          IX-4   LargeTitlePage, useTitleFold (shared by conversation and pages)
components/ix/sidebar/       IX-5   SidebarHeader, SearchField, ChannelList, ChannelRow, RoomList, AddonList, ComingUp
components/ix/dock/          IX-6   Dock, DockItem, AddServerSheet
components/ix/card/          IX-7   RoomCard, PeopleRows, CardActions, IncomingCallCard, PinnedCallCard, selectors
components/ix/call/          IX-13  CallView, CallHeader, PeopleGrid, StreamFocus, ChatColumn, CallControls, CallMenus
components/ix/conversation/  IX-15  IxConversation, Welcome, ActionCards, DraftEventCard, BannerStrip, DropTarget
components/ix/menus/         IX-9   ServerMenu, ChannelMenu, PeopleMenu, AccountMenu (moved), ProfileCard
components/ix/people/        IX-14  PeopleSidebar, FriendsPage, InboxPage, useLastPlace
lib/identityHue.ts           IX-1   paletteHue, serverHue, PEOPLE_HUE
styles/ix-*.css              IX-1 creates every file empty and imports them in globals.css, in this order:
                             ix-base, ix-shell, ix-sidebar, ix-dock, ix-card, ix-cards, ix-sheets, ix-pages,
                             ix-timeline, ix-composer, ix-conversation, ix-call, ix-people, ix-phone
```

### 1.3 Contracts fixed before the packages that use them

- **Slots** (`components/ix/shell/slots.ts`, IX-4): `SidebarSlot({ place })`,
  `DockSlot()`, `CardSlot({ place, position: 'pinned' | 'inline' })`,
  `CallSlot()`, `SheetSlot()`; `place = { kind: 'server', guildId } | { kind:
  'people' }`. IX-4 writes stub components in each `components/ix/*/index.ts`;
  from then on each stub belongs to the package that fills it.
- **Store** (`stores/glassStore.ts`): IX-4 adds `stage.chat: boolean` and
  `toggleChat()`; keeps `mode: 'none' | 'side' | 'theater'` (the rename to
  `'main'` happens in M2, when the Glass stage is deleted, so no fenced file
  changes before then). `browseOpen`, `pillExpanded`, `placesOverlayOpen` are
  removed in IX-19.
- **Hue** (`lib/identityHue.ts`, IX-1): `paletteHue(id: string): number`,
  `serverHue(g: { id: string; hue?: number | null }): number`, `PEOPLE_HUE =
  210`. Tint layers take a hue number; nothing animates `--ix-hue`.
- **Timeline props** (IX-11): `MessageList` gains `header?: ReactNode`
  (rendered as the first item of the scroller, above history, visible when the
  start of the channel is loaded) and `emptyState?: ReactNode` (replaces the
  feed when the channel has no messages). IX-15 fills both.
- **Composer height** (IX-12): the message box root carries
  `data-ix-composer-open="true|false"`; IX-15 observes its size with a
  `ResizeObserver` and FLIPs the list container (index-spec §5.12). Neither
  package edits the other's file.
- **Test ids** (used by IX-0 drivers before the UI exists): `ix-sidebar`,
  `ix-sidebar-header`, `ix-search-field`, `ix-channel-row` (`data-channel-id`),
  `ix-room-row`, `ix-room-card` (`data-state`), `ix-card-join`,
  `ix-card-open-call`, `ix-card-leave`, `ix-dock`, `ix-dock-item`
  (`data-place`), `ix-toolbar`, `ix-title`, `ix-welcome`, `ix-action-card`
  (`data-action`), `ix-composer`, `ix-call`, `ix-call-back`, `ix-call-leave`.

---

## 2. Living next to feat/send-flight and feat/native-video

### 2.1 Fences (no Index package edits these before its merge gate)

| Fenced for | Files | Opens at |
|---|---|---|
| `feat/send-flight` | `components/message/MessageInput.tsx`, `MessageList.tsx`, `TimelineParts.tsx`, `messageLight.ts`, `MessageInput*.test.*`, `MessageList*.test.*`; `lib/motion/**`; `components/motion/MotionDirector.tsx`; `styles/glass-conversation.css`, `styles/glass-timeline.css`; `styles/tokens.css` motion-token region (the `--duration-*`, `--ease-*`, `--spring-*` block); `scripts/motion-lint.mjs`; `e2e/motion-gate.spec.ts`, `e2e/fixtures/motionFixture.ts`; `src/test/messageInputRuntimeMock.ts`; `pages/guild/TextChannelView.tsx`, `pages/DMPage.tsx`, `components/message/ThreadPanel.tsx`, `components/glass/conversation/ConversationPane.tsx` | **M1** |
| `feat/native-video` | `lib/media/**`, `client/src-tauri/**`, `stores/voiceStore.ts`, `stores/voice/**`, `components/glass/stage/**`, `components/glass/pill/PillPreview.tsx`, `components/glass/room/**`, `lib/room/**`, `lib/nativeGround.ts`, `components/voice/streamOverlayPortal.tsx`, `components/glass/shell/{GlassFrame,PhoneStageChrome}.tsx`, `pages/MediaTest.tsx`, `styles/glass-stage.css`, `glass-stage-modes.css`, `glass-phone.css`, `layout.css`, `docs/streaming-native-render-spec.md` | **M2** |

Two narrow exceptions, both single-line and conflict-tolerant:

- IX-4 edits `pages/AppShell.tsx` to mount `IxFrame` instead of `GlassFrame`,
  keeping the `data-native-underlay-clear` attribute line byte-identical.
- IX-2 edits `types/voice.types.ts` (one field, `joined_at`) through the
  contract generator.

Before M1, Index packages add **no** motion-lint allowances (design to need
none); after M1 an allowance needs a named reason. Index motion helpers live in
`components/ix/motion/` so `lib/motion` never conflicts.

### 2.2 Merge gates

- **M1 (merge `feat/send-flight`).** Runs when that branch is finished and the
  orchestrator says so, at a quiet point (no Index package running). If it is
  not ready when wave C ends, IX-13 and IX-14 (not fenced) still run; IX-11,
  IX-12 and IX-15 wait.
- **M2 (merge `feat/native-video`).** Runs when that branch is finished and
  IX-13 has landed. If native video lands first, run M2 before IX-13 and IX-13
  builds directly on it (preferred). Either way M2 owns the reconciliation.

---

## 3. Work packages

Tiers: **Sonnet** for well-scoped UI work against a fixed contract; **Opus**
for cross-cutting, media, backend, merges or tricky motion/state. Size: S ≈
half a session, M ≈ one, L ≈ a full session.

Every package:

- works in `~/Documents/Paracord-index`, edits only its listed files (plus its
  own new tests), never commits (the orchestrator commits per package, staging
  paths by name), and replaces or deletes the tests of whatever it replaces in
  the same package (no skipped tests);
- writes `docs/design/index-ix<N>-checkpoint.md`: what changed, commands run
  and results, screenshots, differences from the reference, what is left;
- passes the common gate: `npm run typecheck`, `npm run test:unit`,
  `npm run test:tokens`, `npm run test:motion-lint`, `npm run lint` (no new
  errors), and for visual packages `npm run test:a11y:static` and
  `npm run test:contrast`;
- for UI, shoots its own states with
  `PARACORD_E2E_INDEX_SPEC=<spec> PARACORD_E2E_INDEX_PORT=<p> PARACORD_E2E_INDEX_RT_PORT=<p+2> PARACORD_E2E_INDEX_WP=ix<N> npx playwright test -c e2e/index-review.config.ts`
  at 1280×800 (held against `output/design-reference/index/ref/<state>.png`),
  1440×900, 900×700 and 390×844, runs `node e2e/index-compare.mjs ix<N>`, and
  **reads** each side-by-side image with the Read tool before writing the
  checkpoint.

| WP | Goal | Files (may edit) | Depends | Model | Size | Group |
|---|---|---|---|---|---|---|
| **IX-0** Review harness | The prototype scene as mocked data: cast Jeremy, Vincent, Brendan, Nick, Maya and you (S); Fuel (new, empty: general, clips, plans; rooms General, Late night), Game Night (12 members; lounge, looking-for-group, screenshots; Lounge live 34 min, Vincent streaming), Basecamp; DMs with Jeremy, Nick, Maya; fixed clock and zone. Scenario steps that mutate the mock (someone arrives, joins, five in the call, busy messages) as gateway events. `index-review.config.ts` parameterized by `PARACORD_E2E_INDEX_{SPEC,PORT,RT_PORT,WP}` (default 4513/4515), `index-dev.mjs` (Vite via API, like `glass-stage-dev.mjs`), `index-compare.mjs` (for each `<state>.png` in a WP folder and in `ref/`: a side-by-side PNG and a mean per-pixel difference, composed in a Playwright page canvas, no new dependency), shared drivers keyed to the §1.3 test ids. `index-smoke.spec.ts` proves the scene loads in today's UI | `client/e2e/fixtures/index/**` (new; may import from `fixtures/glass/install.ts` without editing it), `client/e2e/index-review.config.ts`, `index-dev.mjs`, `index-compare.mjs`, `index-smoke.spec.ts`, `index-reference.mjs` (exists) | none | Sonnet | M | A |
| **IX-1** Foundation | index-spec §2: Index token block (ground, ink ramp, fills, cream, amber, danger, call, focus) and remap of the semantic tokens (`--accent-primary` etc.) to cream (supersedes the 2026-10-03 slate-blue primary); hue-derived classes; `paletteHue`/`serverHue` (no purples; deterministic; tests); `Avatar`, `ServerMark`, `PresenceDot` (image wins, one letter, sizes, high contrast); Index primitives and glyphs; `Face` in `glass/places/Lead.tsx` renders `Avatar` (instant global switch); create every `styles/ix-*.css` (empty except `ix-base.css`) and import them; contrast audit sweeps hues 0–359 at 15° for ink-2/ink-3 on sidebar top, sidebar bottom, selection, main, bubble, card, call; Index section on `/design-tokens` | `styles/tokens.css` (theme blocks and a new Index block only), `styles/ix-*.css` (create), `styles/globals.css` (imports), `lib/identityHue.ts`, `lib/colors.ts`, `components/ix/{identity,primitives,glyphs}/**`, `components/glass/places/Lead.tsx` (`Face` internals), `scripts/contrast-audit.mjs`, `pages/DesignTokensPage.tsx` | none | Sonnet | M | A |
| **IX-2** Backend: hue and joined_at | index-spec §11: `spaces.hue` and `voice_states.joined_at` (migration pair `20261004000001_index.sql`, CHECK 0–359, TEXT time, constant default then backfill); db modules; `PATCH /guilds/{id}` validates and stores `hue` (Manage Server; null clears); guild payloads, READY, `GUILD_UPDATE`, voice states carry the fields; `joined_at` set on join and listen join, reset on a channel move; `npm run contracts:generate`; route tests on SQLite and the PostgreSQL smoke | `crates/paracord-db/migrations/20261004000001_index.sql`, `migrations_pg/20261004000001_index.sql`, `crates/paracord-db/src/**` (spaces and voice_states queries), `crates/paracord-models/**`, `crates/paracord-api/src/routes/{guilds,voice}.rs`, `crates/paracord-ws/src/handler.rs` (READY fields), `crates/paracord-contracts/**`, `contracts/api-contracts.json`, `client/src/api/generated/**`, `client/src/types/{guild,voice}.types.ts`, `crates/paracord-api/tests/index_hue_joined_at.rs` | none | Opus | M | A |
| **IX-3** Live scene driver | `index-scene.mjs` on a real instance (`scripts/live-env.mjs`): the IX-0 scene for real (accounts, servers with no icons so monograms show, channels, DMs, messages), three Chromium cast members holding Lounge with fake media and Vincent's canvas share (reuse `scripts/glass-scene/{call,media-init}.mjs` by import), step commands (`--step arrive|join|busy`) and `--shot <state>` for your view | `client/scripts/index-scene.mjs`, `client/scripts/index-scene/**` | none | Sonnet | M | A |
| **IX-4** Shell | index-spec §3: `IxFrame` (two flush columns 316/280, hairline, phone root/pushed screens via `phoneNav`/`phoneMotion`), tint layers (sidebar background and main glow per hue, crossfade 900ms on change, old layer removed), place pane slide (§5.1: two mounted panes, `dir` from dock order), toolbar (search → search sheet, members → people sheet, your avatar → account menu, folded-title slot, DM call button slot), `LargeTitlePage` + `useTitleFold` (§5.14), call and sheet slots (inset 10, radius 24), slot stubs and `slots.ts`, `components/ix/motion/**`; mount in `AppShell`; RoomBackdrop no longer mounted (ambient views stop); the compact overlay is gone. Main shows today's `<Outlet>` until IX-15 | `components/ix/{shell,page,motion}/**`, stubs `components/ix/*/index.ts`, `stores/glassStore.ts` (additive), `pages/AppShell.tsx` (frame mount only), `pages/AppShell.test.tsx`, `styles/ix-shell.css`, `e2e/index-shell.spec.ts` | IX-1 | Opus | M | B |
| **IX-5** Sidebar | index-spec §4.1–4.7: header (Overview on click, server menu on "…"/right-click), search field (opens `CommandPalette`), channels by category (sentence case, collapse, hover `+`), fixed 52px two-line rows with previews (§4.5 rules incl. encrypted, muted, mentions, announcements), selection glide, unread and preview motions (§5.2, §5.3, §5.20), Rooms rows (busy faces, click joins, right-click menu), Add-ons rows with live lines, Coming up; roving keyboard; the card slot rendered at its inline position | `components/ix/sidebar/**`, `components/glass/places/{model,rows,usePlacesData}.ts` (owner from now), `hooks/useRoomMenu.tsx`, `styles/ix-sidebar.css`, `e2e/index-sidebar.spec.ts` (states s0-quiet, s1, s4, s5 sidebar crops) | IX-4 | Sonnet | L | C |
| **IX-6** Dock | index-spec §4.8: People first, separator, servers, `+`; indicator glide, active scale, inactive opacity, hover lift and tooltip, live dot and the one-time ping, unread dot and mention chip (People: DMs + requests), overflow scroll with edge fades, roving toolbar, Ctrl+Alt+Up/Down and Ctrl+1–9, right-click server menu; Add a server sheet (Create with templates, Join with a link, Discover) | `components/ix/dock/**`, `components/guild/CreateGuildModal.tsx`, `hooks/useKeyboardNavigation.ts` (place keys only), `styles/ix-dock.css`, `e2e/index-dock.spec.ts` | IX-4 | Sonnet | M | C |
| **IX-7** Live room card | index-spec §4.3, §4.4, §4.10, §5.4, §5.5, §5.7: busiest-room choice, every state (live, streaming with Watch, listening, yours, pinned with server line, incoming DM call), people rows (stable order, overflow row), talking ring and waveform on real voice activity, "live N min" from `joined_at` on one minute tick, actions wired to the existing voice actions (join, listen, watch → `openStage`, mic/camera/screen, Open call/Back to chat, leave), mic device menu, enter/leave and join-flight motion, pinned-card FLIP between positions, system-audio line; `IncomingCallBanner` replaced; Settings › Join calls muted wired to `muteStore` | `components/ix/card/**`, `components/glass/pill/{model,useCallPill,pillActions,muteStore}.ts` (owner from now), `components/dm/IncomingCallBanner.tsx`, `lib/AppProviders.tsx` (banner mount line), `styles/ix-card.css`, `e2e/index-card.spec.ts` (s1, s2, s4, s6 card crops) | IX-2, IX-4 | Opus | L | C |
| **IX-8** Conversation cards | index-spec §4.11 cards: event card (from `PlanCard`/`EventPlanCard`, RSVP as I'm in / Maybe), poll card (`scaleX` bars), file card, link and feed embeds, sports score card, code block, ephemeral line, bot components, inline chips; no `MessageList` edits | `components/glass/cards/{PlanCard,EventPlanCard,CardGlyphs,InlineChips,eventTime}.ts(x)`, `components/message/{PollMessageCard,MessageEmbed,GitHubEventEmbed,MessageComponents,EphemeralMessage,CodeBlock}.tsx`, `components/feeds/FeedPostCard.tsx`, `components/sports/ScoreUpdateCard.tsx`, `components/file/{FilePreview,MediaPreview}.tsx`, `styles/ix-cards.css`, `e2e/index-cards.spec.ts` (a gallery page in DEV) | IX-1 | Sonnet | M | C |
| **IX-9** Sheets, menus, switcher | index-spec §6.1–6.5, §6.9: sheet frame in main (no pill), people sheet, channel sheet with a segmented control, message search sheet, reminders, server menu (moved to `components/ix/menus`), channel menu (Inbox and Help move out), People menu, account menu (adds Keyboard shortcuts), quick switcher (restyled `CommandPalette`, anchored over the sidebar, server scope first, "Search messages in Fuel"), Help as a dialog, profile card | `components/glass/sheets/**`, `components/glass/conversation/{useChannelMenu.tsx,sheetBridge.ts}`, `components/glass/places/ServerMenu.tsx` (move), `components/ix/menus/**`, `components/layout/CommandPalette.tsx`, `components/layout/overlays/{SearchOverlay,PinnedMessagesOverlay,HelpOverlay,TopBarOverlay}.tsx`, `components/user/UserProfile.tsx` (popup layout), `styles/ix-sheets.css`, `styles/glass-sheets.css` (remove replaced rules), `e2e/index-sheets.spec.ts` | IX-4 | Sonnet | M | C |
| **IX-10** Server pages and Server color | index-spec §8.1, §8.3: Overview page in `LargeTitlePage` (widgets grid, no LiveNow), Events page, Sports / Daily word / Game servers pages (chrome only; their internals keep their CSS), sports channel pin as a thin card, onboarding gate page, missing-channel states, Server settings › Overview › Server color (eleven swatches + Match icon) | `components/rooms/lobby/**`, `pages/{GuildHomePage,GuildSportsPage,GuildSportsGamePage,GuildDailyWordPage}.tsx`, `components/gameServers/**` (page wrapper), `components/sports/{ChannelPin,ChannelAmbient}.tsx`, `components/guild/{EventList,GuildOnboardingGate,BuildingNotFound}.tsx`, `pages/guild/GuildStateScreens.tsx`, `components/guild/GuildSettingsSections.tsx` (OverviewSection only), `styles/ix-pages.css`, `styles/server-home.css`, `e2e/index-pages.spec.ts` | IX-2, IX-4 | Sonnet | M | C |
| **M1** Merge send-flight | `git merge feat/send-flight` into `feat/index-ui` at a quiet point; resolve conflicts (expected: none in Index-owned files; `tokens.css` regions; `globals.css` imports); full client gate + `npm run test:motion`; record the send-flight contract (ghost element, events, timing) in the checkpoint for IX-11/IX-12 | merge only | send-flight done, wave C done | Opus | S | gate |
| **IX-11** Timeline | index-spec §4.11 in place: grouping (same author, 5 min), time dividers (30 min / day, labels), others' bubbles with joined corners and the 30px avatar at the bottom, your cream bubbles, mention chips, hover time and action capsule, reaction chip (`ReactionBite`), reply line, thread line, edited, media and file bubbles (`MediaFrame`), system lines (own voice joins only), typing bubble, New divider (replaces catch-up), jump-to-latest capsule, skeletons, encrypted placeholders, compact density, the `header` and `emptyState` props (§1.3), arrival motion for others' messages (§5.10) composed with the send flight; `messageLight` and catch-up retired; tests rewritten | `components/message/{MessageList,TimelineParts}.tsx`, `messageLight.ts` (delete), `components/glass/cards/{ReactionBite,MediaFrame,CatchUpDivider,catchUp}.ts(x)`, `components/message/MessageList*.test.*`, `styles/ix-timeline.css`, `styles/glass-timeline.css` (remove replaced rules), `e2e/index-timeline.spec.ts` (s2, s4, s5, s6 feed crops) | M1, IX-4, IX-1 | Opus | L | D |
| **IX-12** Message box | index-spec §4.12, §5.12, §5.13: capsule, three-slice open (transform only), tools row (Attach, GIF, Poll, Event, Format), emoji button and the unified picker host, reply chip, attachment queue, completion popovers, Send later menu and scheduled sheet entry, read-only and slow-mode lines, `data-ix-composer-open`; send flight untouched | `components/message/{MessageInput,MarkdownToolbar,SlashCommandPopup,RoleMentionChip,ScheduledMessagesPanel}.tsx`, `MessageInput*.test.*`, `src/test/messageInputRuntimeMock.ts`, `styles/ix-composer.css`, `styles/glass-conversation.css` (composer rules only), `e2e/index-composer.spec.ts` (s0-message-box-open) | M1, IX-1 | Opus | M | D |
| **IX-13** Call view | index-spec §7, §5.8, §5.9: call surface in the call slot growing out of the card (poster frames for native surfaces), header, people grid and stream focus with filmstrip, chat column (H) hosting the room's conversation components (imported, not edited), controls for joined / watching / stage channels, `CallMenus` (ported from `StageMenus`: mic menu with Deafen, More), theater over the window, Esc/T/H/C, closing unsubscribes video; composes `StreamSurface`, `CameraTile`, `useNativeUnderlay`, `useStreamPoster`, `ClipToast`, `StreamReactionsLayer`, `SurfacingMessages`, `StageChannelPanel`, `StreamSound` unchanged; DM calls; Glass `Stage` no longer mounted | `components/ix/call/**`, `hooks/useGlassKeybinds.ts`, `stores/glassStore.ts` (`chat`, open/close helpers), `styles/ix-call.css`, `e2e/index-call.spec.ts` (s3-call-open and stream states with the DEV fixture frame source) | IX-7, IX-4 | Opus | L | D |
| **IX-14** People place | index-spec §6.6, §8.1, §8.6: People sidebar (header, search, Friends and Inbox rows, Messages with DMs and groups), Friends page, Inbox page (from `InboxOverlay`), New message, Discover page restyle, `/app` and `/app/dms` redirects to the last place, Home retired | `components/ix/people/**`, `App.tsx` (index route), `pages/{HomePage,FriendsPage,DiscoveryPage}.tsx`, `components/home/**` (delete), `components/layout/overlays/InboxOverlay.tsx` (move), `components/message/DmPickerModal.tsx`, `styles/ix-people.css`, `e2e/index-people.spec.ts` (s6-people sidebar) | IX-5, IX-9 | Sonnet | M | D |
| **IX-15** Conversation chrome | index-spec §4.11 (title, subtitle, encrypted line), §4.13, §5.6, §6.8: `IxConversation` replaces `ConversationPane` (title via `header`, welcome via `emptyState`, the list FLIP on composer resize), "<Server> is ready" and channel/DM/joiner welcomes with the three action cards (invite create + copy, Plan a night draft event card morph and Post it, Say hello fills the draft), banner strip, queue and recovery card, drop target, section errors, the toolbar's DM call button (from `useDmCall`, §7.5) | `components/ix/conversation/**`, `components/glass/conversation/{ConversationPane,ConversationHeader,HeaderAvatar,useDmCall}.tsx` (retire), `pages/guild/TextChannelView.tsx`, `pages/DMPage.tsx` (conversation host), `pages/GuildPage.tsx` (notices), `components/guild/GuildWelcomeScreen.tsx` (retire), `components/{BannerStack,ConnectionStatusBar,RestartBanner,UpdateNotification,ErrorBoundary}.tsx` (presentation), `components/message/{MessagingQueuePanel,MessagingRecoveryNotice}.tsx` (presentation), `styles/ix-conversation.css`, `e2e/index-conversation.spec.ts` (s0-quiet, s0-plan-a-night, s5-busy-title-folded) | IX-11, IX-12, IX-8 | Sonnet | M | E |
| **M2** Merge native-video, reconcile | `git merge feat/native-video` at a quiet point; port its changes in `Stage`/`CallStage`/`stageTransition`/`StagePeople`/`PillPreview`/`RoomBackdrop`/`lib/room` into the Index call view or drop them with their retired files; rename stage mode `side` → `main`; delete the Glass stage shells now replaced (`Stage`, `CallStage`, `CallEmpty`, `StageControls`, `StageMenus`, `TheaterPeople` if unused, `useStageGlow`), the pill UI, room light (`glass/room`, `lib/room`, the ambient start in the stores) and, if nothing calls it, the Rust `native_render_sample` command; restyle `ClipToast` / `StreamReactionsLayer` / `SurfacingMessages` to Index; `cargo check --manifest-path client/src-tauri/Cargo.toml --all-targets` with `vpx` on (never disable it) | merge, the files named, `styles/glass-stage*.css` | IX-13, native-video done | Opus | M | gate |
| **IX-16** Phone | index-spec §9: root = sidebar with the dock as a bottom bar (safe areas), avatar in the header, pushed pages (360ms, edge swipe), call strip, call sheet (rise from card or strip, drag to dismiss, one/two-column tiles, stream on top), menus as action sheets, sheets as pushed pages, full-screen switcher, keyboard-aware message box | `components/ix/shell/phone/**`, `components/ix/call/CallSheet.tsx`, `components/glass/shell/{phoneNav,phoneMotion,usePhoneFrame}.ts` (owner from now), `hooks/useSwipeGesture.ts`, `pages/AppShell.tsx` (phone branch), `styles/ix-phone.css`, `e2e/index-phone.spec.ts` (390×844: root, pushed conversation, call strip, call sheet, action sheet, switcher) | IX-15, IX-14, IX-13, M2 | Opus | M | F |
| **IX-17** Long tail | index-spec §6.7, §6.8, §6.10–6.14: user and server settings surfaces (incl. Join calls muted), dialogs, confirms, toasts, tooltips, context menus, one picker with Emoji / GIF / Stickers, media viewer FLIP, invite and screen-share modals, forward / remind / edit-history, auth and onboarding pages, admin and developer pages, admin initials → `Avatar` | `components/ui/**`, `styles/{primitives,components}.css`, `pages/{SettingsPage,GuildSettingsPage,AdminPage,DeveloperPage,LoginPage,RegisterPage,ServerConnectPage,InstanceSetupPage,AccountSetupPage,AccountUnlockPage,AccountRecoverPage,InvitePage,BotAuthorizePage}.tsx`, `pages/authScaffold.tsx`, `pages/admin/**`, `components/user/UserSettings.tsx`, `components/guild/GuildSettings*.tsx` (presentation), `components/customization/**`, `components/voice/ScreenSharePickerModal.tsx`, `components/guild/InviteModal.tsx`, `components/message/{ForwardPicker,RemindMeMenu,MessageEditHistoryDialog,ReactionPeople}.tsx`, `components/onboarding/**`, `components/developer/**`, `e2e/index-longtail.spec.ts` | IX-7, IX-9, IX-10, IX-12 | Sonnet | M | F |
| **IX-18** Motion gate and polish | Rewrite `e2e/motion-gate.spec.ts` for index-spec §5 (each moment: duration, curve, transform/opacity only; zero running animations 2s after each settles; reduced motion = 150ms fades); live region announcements (§10); tune any moment that misses the prototype; add motion-lint allowances only with named reasons | `e2e/motion-gate.spec.ts`, `e2e/fixtures/motionFixture.ts`, `scripts/motion-lint.mjs`, `components/ix/motion/**`, small timing fixes in any `components/ix/**` file (named in the checkpoint) | IX-15, IX-13, M1 | Opus | M | F |
| **IX-19** Retire Glass | Delete what nothing imports (glass places UI, pill UI leftovers, shell `GlassFrame`/`PlacesOverlay`/`PlacesToggle`/`PhonePlaces`/`PhoneStageChrome`, unused primitives, `MotionDirector` if unused, Home), dead `glass-*.css` rules and files, `glassStore` fields (`browseOpen`, `pillExpanded`, `placesOverlayOpen`); replace the `glass-*` e2e specs and configs with `index-review.spec.ts` (every named state) and the per-package `index-*` specs; update `smoke.spec.ts`; docs: `docs/design/index-summary.md`, glass-summary pointer | deletions across `client/src` and `client/e2e`, `stores/glassStore.ts`, `styles/globals.css`, `client/e2e/{smoke,glass-*}.spec.ts`, `client/e2e/glass-*.config.ts`, `client/e2e/index-review.spec.ts`, `docs/**` | all UI packages, M2 | Sonnet | M | G |
| **IX-20** Final gate and desktop CPU | Full gate (§5.3); every reference state shot from the mocked harness and from the live scene (IX-3) in Chromium and in the Tauri desktop app on WebKitGTK; measure `WebKitWebProcess` CPU (§5.4) and fix within scope; `live-drive.mjs`; real-server e2e incl. voice join; integration review of all checkpoints against the spec; `docs/design/index-summary.md` final | fixes only, each named in the checkpoint | all | Opus | L | H |

### 3.0 Package-specific checks (beyond the common gate)

- **IX-0**: `index-smoke.spec.ts` green on its ports; `index-compare.mjs` run
  on the `ref/` folder against itself reports 0 difference.
- **IX-1**: unit tests for `paletteHue` (deterministic, never 250–320),
  `serverHue`, `Avatar`/`ServerMark` (image wins, one grapheme, sizes, hue
  variable set, no glow); contrast sweep passes; `/design-tokens` shot.
- **IX-2**: route tests (set, clear, out of range → 400, permission → 403;
  `joined_at` set on join, listen join and move); both engines; contracts
  check; the client typechecks against the regenerated types.
- **IX-3**: `--shot` of every `ref/` state on a real instance; Lounge holds
  with real audio and a canvas share.
- **IX-4**: unit (frame layouts at 1280, 900, 390; tint layer swap removes the
  old layer; pane slide direction from dock order); no running animations at
  rest; shots of the frame with stubs.
- **IX-5**: unit for row model (preview text rules, time labels, encrypted,
  muted, mentions), selection transform only; shots s0/s1/s4/s5 sidebar crops.
- **IX-6**: unit for unread/mention/live derivation and the one-time ping
  (fires once per not-live → live edge, never for the current server); keyboard
  test; overflow shot with 12 servers.
- **IX-7**: unit for the card model (busiest room, ordering, overflow row,
  labels "just now"/"live N min"/"You're in"/"Listening", incoming call), action
  wiring (mocked voice store), WAAPI keyframes transform/opacity only;
  `PARACORD_E2E_REAL=1 npx playwright test e2e/real-server.voice-join.spec.ts`
  still green; shots s1/s2/s4/s6 card crops.
- **IX-8**: unit per card (RSVP states, poll bars); gallery shots.
- **IX-9**: unit for menus (items by permission), switcher scope order; shots
  of each sheet and menu.
- **IX-10**: unit for the Server color field (swatches, Match icon computes a
  hue from a fixture image); page shots.
- **M1**: full client gate plus `npm run test:motion`; the send flight plays in
  the mocked harness (shot mid-flight).
- **IX-11**: rewritten `MessageList` tests (grouping, dividers, own bubbles,
  mention chip, reactions, reply, thread, edited, typing, New divider, jump);
  virtualization and keyboard navigation tests kept green; feed crops.
- **IX-12**: composer tests (drafts, slash, mentions, uploads, reply, send
  later, read-only) green; open/close keyframes transform/opacity only; shot.
- **IX-13**: unit for controls by state (joined / watching / stage), Esc/T/H/C,
  video unsubscribed on close (mocked engine); s3 shot and stream shots with the
  DEV fixture frame source; a live check with IX-3 (Open call, Watch Vincent,
  Back to chat, Leave).
- **IX-14**: redirect tests (`/app`, `/app/dms`); People sidebar unit; s6.
- **IX-15**: welcome variants by permission; Plan a night posts an event and a
  message (mocked API); Say hello fills, never sends; s0 states and the fold.
- **M2**: full client gate, Rust checks with `vpx`, the desktop app streams on
  this Linux box (native route) with the Index call view, morph shows posters.
- **IX-16**: phone spec at 390×844 and 844×390; swipe back; call sheet drag.
- **IX-17**: `index-longtail.spec.ts` shots of every settings section, auth
  page and dialog; a11y static audit.
- **IX-18**: the rewritten motion gate is green and fails when a moment is
  given a `height` or `box-shadow` animation (a self-test).
- **IX-19**: nothing imports a deleted path (`npm run build`), no `glass-*`
  e2e config remains, `index-review.spec.ts` shoots all ten `ref/` states.
- **IX-20**: §5.4.

### 3.1 Waves and parallel groups

All packages run in the same worktree (`~/Documents/Paracord-index`). Packages
in one group run at the same time; their file scopes above are disjoint, and
each runs its own Vite dev server and realtime stub on its own ports (§5.2).
Merges run alone.

```
A   IX-0 · IX-1 · IX-2 · IX-3            four in parallel (IX-2 is server-only)
B   IX-4                                 alone (it creates the slots everyone fills)
C   IX-5 · IX-6 · IX-7 · IX-8 · IX-9 · IX-10   six in parallel (IX-7 and IX-10 need IX-2)
M1  merge feat/send-flight               alone, at a quiet point
D   IX-11 · IX-12 · IX-13 · IX-14        four in parallel (IX-13 and IX-14 may start
                                         before M1; IX-11 and IX-12 may not)
E   IX-15
M2  merge feat/native-video              alone (or before IX-13, §2.2)
F   IX-16 · IX-17 · IX-18                three in parallel
G   IX-19
H   IX-20
```

Critical path: IX-1 → IX-4 → IX-7 → IX-13 → M2 → IX-16 → IX-19 → IX-20, with
M1 → IX-11 → IX-15 joining at IX-16.

### 3.2 Shared files and their single owners

| File | Owner (in order) |
|---|---|
| `styles/globals.css` | IX-1 (creates all imports), IX-19 (removes Glass imports) |
| `styles/tokens.css` | IX-1 (theme blocks, Index block), M1 (motion region via merge), IX-19 (removes Glass block) |
| `pages/AppShell.tsx` | IX-4 (frame mount), IX-16 (phone branch), IX-19 |
| `stores/glassStore.ts` | IX-4 (additive), IX-13 (chat, open/close), M2 (`side` → `main`), IX-19 (removals) |
| `App.tsx` | IX-14 |
| `lib/AppProviders.tsx` | IX-7 (incoming call mount) |
| `hooks/useKeyboardNavigation.ts` | IX-6 (place keys), IX-18 (any later key changes) |
| `scripts/motion-lint.mjs` | IX-18 (after M1) |
| `components/glass/places/{model,rows,usePlacesData}.ts` | IX-5 |
| `components/glass/pill/{model,useCallPill,pillActions,muteStore}.ts` | IX-7 |
| `components/ix/*/index.ts` stubs | IX-4 creates; the package named in §1.2 fills |
| `e2e/fixtures/index/**` | IX-0; later packages add scenario steps only in new files under `fixtures/index/steps/` |

---

## 4. Server work

Only IX-2 (index-spec §11): `spaces.hue`, `voice_states.joined_at`, the
guild `PATCH`, payloads, contracts. Rules (CLAUDE.md): both migration
directories, `TEXT` timestamps, constant defaults then backfill, bind `bool`
directly (none here), read with `CAST` where needed; `cargo fmt --all --
--check`, `cargo clippy --workspace -- -D warnings`, `cargo test -p
paracord-api --test index_hue_joined_at`, `cargo test --workspace`, the
PostgreSQL route smoke with a PG URL configured, `npm run contracts:check`.
Cargo builds go through `~/Documents/Paracord-wt/tools/pc-cargo.sh` (RAM limit,
two slots); one `target/` for the worktree.

The ambient view kind on the server becomes dormant when the client stops
using it (M2). Removing it is a follow-up, not part of this plan.

---

## 5. Verification

### 5.1 References

- `output/design-reference/index/ref/<state>.png` (1280×800, exact 1x, from
  `node client/e2e/index-reference.mjs`): `s0-quiet`, `s0-plan-a-night`,
  `s0-message-box-open`, `s1-someone-arrives`, `s2-joined`, `s3-call-open`,
  `s4-other-server`, `s5-busy`, `s5-busy-title-folded`, `s6-people`.
- The prototype itself for motion: open it in Playwright and drive it (step
  button, dock, channels, card actions, Plan a night, typing + Enter, scroll).
- The prototype has no phone, menus, settings or call-with-video states; those
  are held against the spec text and the nearest reference state's tokens.

### 5.2 Ports

| Package | App / realtime ports |
|---|---|
| IX-0 | 4513 / 4515 |
| IX-4 | 4523 / 4525 |
| IX-5 | 4533 / 4535 |
| IX-6 | 4543 / 4545 |
| IX-7 | 4553 / 4555 |
| IX-8 | 4563 / 4565 |
| IX-9 | 4573 / 4575 |
| IX-10 | 4583 / 4585 |
| IX-11 | 4593 / 4595 |
| IX-12 | 4603 / 4605 |
| IX-13 | 4613 / 4615 |
| IX-14 | 4623 / 4625 |
| IX-15 | 4633 / 4635 |
| IX-16 | 4643 / 4645 |
| IX-17 | 4653 / 4655 |
| IX-18 | 4663 / 4665 |
| IX-19, IX-20 | 4673 / 4675 |

### 5.3 Which reference proves which package

| State | Proves |
|---|---|
| `s0-quiet` | IX-1 (marks, ink), IX-4 (frame, tint, toolbar), IX-5 (header, search, rows, rooms), IX-6 (dock), IX-15 (welcome, action cards) |
| `s0-plan-a-night` | IX-8 (event card), IX-15 (morph, preview "You planned…") |
| `s0-message-box-open` | IX-12 |
| `s1-someone-arrives` | IX-7 (live card, Join), IX-5 (unread dot), IX-6 (live dot), IX-11 (grouped bubbles, time divider) |
| `s2-joined` | IX-7 (yours, controls), IX-11 (system line) |
| `s3-call-open` | IX-13 |
| `s4-other-server` | IX-7 (pinned with server line, Watch Vincent), IX-4 (tint of another hue), IX-5 |
| `s5-busy`, `s5-busy-title-folded` | IX-11, IX-15 (fold), IX-7 (five people, talking) |
| `s6-people` | IX-14, IX-11 (your cream bubble) |

### 5.4 Suites that must stay green at IX-20

- Client: `npm test`, `npm run lint`, `npm run test:a11y:static`,
  `npm run test:contrast`, `npm run build`, `npm run test:e2e` (mocked smoke),
  `npm run test:motion` (rewritten gate), `PARACORD_E2E_REAL=1 npx playwright
  test` (real server incl. voice join), `npm run contracts:check`, every
  `index-*` spec via `index-review.config.ts`.
- Rust: `cargo fmt --all -- --check`, `cargo clippy --workspace -- -D
  warnings`, `cargo test --workspace`, the PostgreSQL route smoke,
  `cargo check --manifest-path client/src-tauri/Cargo.toml --all-targets`
  (vpx on).
- `node client/scripts/live-drive.mjs` (25/25 at the Glass release check).
- **Desktop CPU** (Tauri on this Linux box, WebKitGTK; build per
  glass-plan §5.1 including the embedded-UI staleness check): with
  `top -b -n 30 -d 1 -p $(pgrep -d, WebKitWebProcess)`:
  1. at rest in a busy channel, not in a call: mean ≤ 5% of one core;
  2. in a call, call view closed, two people talking: report (the waveform
     and ring are the only motion);
  3. call view open watching a 1080p stream, and theater: report, and compare
     to the Glass numbers in the release check;
  4. `document.getAnimations().length === 0` two seconds after every §5
     moment settles (also asserted by IX-18).

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Merge conflicts with the two sibling branches** | Fences (§2.1), Index helpers in `components/ix/motion`, no motion-lint allowances before M1, merges at quiet points by an Opus package that owns reconciliation |
| **Send flight lands on a restyled timeline** | IX-11 and IX-12 start only after M1 and read M1's record of the flight's contract (ghost, events, target row ids); IX-11 keeps `#msg-<id>` ids and the receipt hook |
| **Native surfaces during morphs** | Call view never animates over a live surface; posters during moves (index-spec §7.6); M2 verifies on the desktop |
| **Composer growth without height animation** | Three-slice capsule and a list FLIP (index-spec §5.12); IX-18 checks no height/box-shadow animation |
| **Large title inside a virtualized list** | `header` is a real first item, measured; the fold reads `scrollTop` once per frame; history loading above keeps the anchor |
| **Contrast of ink-3 at .5 on tinted sidebars** | IX-1's hue sweep decides; raising the alpha is global, recorded in the spec |
| **Card overflow with big rooms** | Six rows then "and N more"; the sidebar scrolls; the card never exceeds ~ 300px |
| **Removing the cross-server Home** | Owner question 1 (§7); the People Inbox and dock dots carry its content |
| **Test churn** (Glass specs and unit tests tied to the pill, places, room) | Each package replaces the tests of what it replaces; IX-19 removes the Glass e2e configs once `index-*` specs cover the same ground |
| **Concurrent agents in one tree** | Disjoint scopes, own ports, orchestrator commits by path; never `git add -A` |

---

## 7. Owner questions

Everything else is decided in index-spec §13 with a default.

1. **Home.** Index retires the cross-server Home (For you / Live now / Around
   now / Coming up). Its content moves to the dock's live and unread dots, each
   server's live card and Coming up, and People › Inbox and Friends. OK to
   drop it? (Default: yes.)
2. **Server color.** Each server gets a hue that tints the window: an
   admin-picked color (eleven swatches or "Match icon") with an automatic
   default from the server id. Is an admin setting wanted, or should it always
   be automatic? (Default: admin setting plus automatic default.)
3. **Rooms join on click.** In the prototype, clicking a room row joins it
   immediately (Listen is on right-click and on the card). Keep that, or make a
   click show the room's card first and Join from there? (Default: join on
   click, as the prototype.)
