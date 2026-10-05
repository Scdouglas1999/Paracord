# Glass: what shipped

> **Glass was replaced by Index** (2026-10-04, branch `feat/index-ui`): see
> [`index-summary.md`](index-summary.md) for what is built and where it lives, and
> [`docs/index-spec.md`](../index-spec.md) for the contract. IX-19 deleted the
> Glass frame, places panel, call pill, room light, stage shells, Home, the Glass
> e2e specs and the Glass CSS that nothing uses. This page stays as the record of
> what Glass shipped; its follow-up lists are history.

Branch `design/glass`, based on `main` at `c10eb4da`. Contract:
[`docs/glass-spec.md`](../glass-spec.md). Plan:
[`glass-plan.md`](glass-plan.md). This page summarizes the checkpoints; each
checkpoint holds the detail, the measurements and the screenshots.

Status of the follow-ups below is as of 2026-09-30: each item comes from a
checkpoint and was checked against the tree on that date (the working tree
carries uncommitted edits from G22 and other packages). Items may close as those
land. Items that an earlier package left and a later one finished are not listed.

The later completion pass, including the read-state races, channel menu,
native sampler handoff and media counter recovery, is recorded in
[Glass completion, 2026-10-03](glass-completion-2026-10-03.md). Its validation
and deployment record supersedes the earlier status statements below.

## What Glass is

Glass is Paracord's interface: two floating panes on a room backdrop, a places
panel (316px) and a conversation pane with a 720px centered column, 16px from
the window edges and from each other. Content is solid and controls are glass.
The backdrop and a small tint in every surface come from the live stream in the
current server, or from the server's banner when nothing is live. Amber means
live; white means it is for you; Join is the one filled button. A call pill at
the top of the conversation expands into a roster and grows a stage (side by
side, theater, browse) when you watch. You can listen in to a voice channel or
watch a stream without joining, save the last 30 seconds as a clip, and send
flame and heart reactions to a stream. On a phone, places and the conversation
are separate screens. The owner's hard constraint holds: no server rail, no `#`
channel list, no IRC log and no docked member list. Glass is now the only layout
and the only look: the Lantern Stage UI and the old looks are retired, and only
Glass and Glass high contrast remain as themes.

## Packages

Every checkpoint is in `docs/design/`. G23 (live verification in the desktop
app and WebKitGTK performance) has not run; see "Desktop and WebKitGTK" below.

| Package | What shipped | Checkpoint |
|---|---|---|
| G0 Foundation | Glass tokens (room tint from one `--room-rgb` through `color-mix()`, fixed colors, ink ramp, shape, shadows), Lantern semantic tokens remapped, self-hosted Instrument Sans with the width axis, custom glyphs, waveform, primitives, a Glass section on `/design-tokens`, a Glass contrast audit | [glass-g0-checkpoint.md](glass-g0-checkpoint.md) |
| G1 Retire the looks | Two themes (`glass`, `glass-contrast`); accent presets, base hue and the rows/bubbles switch removed; Reduced transparency setting; retired theme ids migrate on read; server default theme is `glass`; one danger ink | [glass-g1-checkpoint.md](glass-g1-checkpoint.md) |
| G2 Mocked review harness | `e2e/glass-review.spec.ts`: the reference scene on mocked REST and gateway, fixed clock, seven named states at 1440x900 and 390x844, a DEV-only fixture frame source | [glass-g2-checkpoint.md](glass-g2-checkpoint.md) |
| G3 Live scene driver | `glass-scene.mjs` builds the reference scene on a real instance (cast, three servers, posts, events, a held Lounge call with fake media) and shoots named states; found the rejoin and stage bugs | [glass-g3-checkpoint.md](glass-g3-checkpoint.md) |
| G4 Channel previews | `GET /api/v1/guilds/{id}/channel-previews`: newest message per readable channel, at most 140 characters, end-to-end encrypted content omitted, one query, contract and generated types | [glass-g4-checkpoint.md](glass-g4-checkpoint.md) |
| G5 Listen and view sessions (server) | `voice_states.mode` and `self_stream_started_at`, listen join, in-place `/mode` upgrade, watch and ambient view sessions in the relay, `VOICE_WATCHERS_UPDATE`, `listen_in_enabled`, migrations on both engines | [glass-g5-checkpoint.md](glass-g5-checkpoint.md) |
| G6 Client media sessions | `voiceStore` actions `listen`, `joinFromListen`, `startWatch`, `stopWatch`, `startAmbient`, watcher counts; a second lightweight session in both engines and the native layer; frame taps; "Listening in" switch in channel settings | [glass-g6-checkpoint.md](glass-g6-checkpoint.md) |
| G6b Viewer keys | Per-track sender keys, the voice key never reaches a viewer, a `member`/`viewer` roster marker, three relay close reasons, views re-checked for access every few seconds, desktop key rotation plans | [glass-g6b-checkpoint.md](glass-g6b-checkpoint.md) |
| G7 Shell | `GlassFrame` with two panes, the 720px column, compact overlay below 860px, `glassStore`, and slot stubs that later packages replaced | [glass-g7-checkpoint.md](glass-g7-checkpoint.md) |
| G8 Room light | One pair of 32x18 canvases, analysis and clamp box, `--room-rgb` written at most 4 times a second, ambient view, banner and icon sources, 1.2 s crossfade, Rust `native_render_sample` | [glass-g8-checkpoint.md](glass-g8-checkpoint.md) |
| G9 Places panel | Server row, server title and menu, text, live and quiet channel rows with previews and unread counts, add-on rows, Coming up, Home mode | [glass-g9-checkpoint.md](glass-g9-checkpoint.md) |
| G10 Timeline bubbles | `MessageList` restyled in place: grouping with joined corners, avatar at the bottom of a group, hover actions, typing bubble, fade under the header | [glass-g10-checkpoint.md](glass-g10-checkpoint.md) |
| G11 Header and message box | 76px header with the channel menu, search, people and your face; the 52px capsule message box with one "+" menu; the pill slot; the phone header | [glass-g11-checkpoint.md](glass-g11-checkpoint.md) |
| G12 Call pill | Compact and expanded pill (550 ms FLIP), Listen, Watch, Join, Leave, persisted mute preference, roster states, collapse ladder, phone two-row variant | [glass-g12-checkpoint.md](glass-g12-checkpoint.md) |
| G13 Timeline cards | Media frame with joined corner, one reaction chip biting the media, catch-up divider, live-channel and event chips (`<event:ID>`), plan cards for events and polls, mention chips | [glass-g13-checkpoint.md](glass-g13-checkpoint.md) |
| G14 Stage, side by side | Watch without joining, stream and camera tiles and chips, joined and not-joined controls, More and mic menus (Deafen), sampled side glow, native underlay handling | [glass-g14-checkpoint.md](glass-g14-checkpoint.md) |
| G15 Theater, browse, moves | Theater, surfacing messages, browse, the S, T, H, C and Esc keys, every stage move (pill to stage, theater, browse) as Web Animations FLIP, shield and poster for the native route | [glass-g15-checkpoint.md](glass-g15-checkpoint.md) |
| G16 Clips | 30 second ring buffer (JS in the browser, Rust on the desktop), in-house WebM and MP4 muxers, C key, toast, post to the channel (encrypted-aware), clip bubble | [glass-g16-checkpoint.md](glass-g16-checkpoint.md) |
| G17 Stream reactions | `POST /api/v2/voice/{id}/stream-reactions` and `STREAM_REACTIONS` (250 ms coalescing, one per second per person), flame and heart buttons, rising faces layer | [glass-g17-checkpoint.md](glass-g17-checkpoint.md) |
| G18 Sheets and menus | Search, people, channel pages (summary, pins, threads, follows, media, leaderboard, notifications), reminders and inbox as sheets over the conversation pane; account menu; threads pushed as a conversation | [glass-g18-checkpoint.md](glass-g18-checkpoint.md) |
| G19 Home, DMs, Friends, Overview, forum | Pages in the 720px column: For you, Live now, Around now, Coming up; messages index; Friends; server Overview; forum rows; incoming-call capsule | [glass-g19-checkpoint.md](glass-g19-checkpoint.md) |
| G20 Phone shell | Places and the conversation as separate screens, no bottom nav or drawer, stream card with back, clip and full screen, safe areas, swipe back | [glass-g20-checkpoint.md](glass-g20-checkpoint.md) |
| G21 Long tail restyle | UI primitives, dialogs, Settings and Server settings, command palette, pickers, menus, toasts, profile card and auth pages; nothing scales on press | [glass-g21-checkpoint.md](glass-g21-checkpoint.md) |
| polish-1 | Seven small fixes: server banner race, stale authenticated images, event names in places previews, call notice takes no layout space, server hub settings copy, `docs/encryption.md` voice section, `CanvasRenderer` `fit` option | [glass-polish-1-checkpoint.md](glass-polish-1-checkpoint.md) |
| fix-rejoin | Rejoining a running call works (the server no longer replays stale track keys at connect time); the keyring waits for the roster; engine joins keep known voice states | [glass-fix-rejoin.md](glass-fix-rejoin.md) |
| fix-watch-audio | A watch without joining plays the stream's own audio (browser and desktop); clips render as the clip bubble; camera tiles fill their tile | [glass-fix-watch-audio.md](glass-fix-watch-audio.md) |
| G22 Retire Lantern | (see glass-g22-checkpoint.md) Glass is the only UI: a voice channel is its chat with its pill, the call itself on the stage ("Show the call") for voice, stage and DM calls, stage-channel moderation over the chat, Lantern components, tests and CSS deleted, e2e smoke and motion gate rewritten | `glass-g22-checkpoint.md` |

## Where things live

### Client, Glass UI (`client/src/`)

| Path | What is there |
|---|---|
| `components/glass/primitives/` | `Glyph`, `Waveform`, `GlassButton` and `JoinButton`, `Kicker`, `InstrumentText`, `Pane`, `GlassChip`, `GlassShowcase` (G0) |
| `components/glass/shell/` | `GlassFrame`, `PlacesOverlay`, `PlacesToggle`, `useGlassLayout`, `slots.ts` (slot prop types); phone: `GlassFrame`'s phone layout with `usePhoneFrame`, `PhonePlaces`, `PhoneStageChrome`, `phoneNav`, `phoneMotion` (G7, G20) |
| `components/glass/room/` | `RoomBackdrop`, `useRoomSource`; the engine is in `lib/room/` (G8) |
| `components/glass/places/` | `PlacesPanel`, `ServerRow`, `ServerTitle`, `ServerMenu`, `PlaceRows` (text, quiet, live, glyph and event rows), `ComingUp`, `HomePlaces`, `AddonRows`, `Lead`, `model.ts`, `rows.ts`, `usePlacesData`, `useUnreadMessageCounts` (G9) |
| `components/glass/conversation/` | `ConversationPane`, `ConversationHeader`, `HeaderAvatar`, `useChannelMenu`, `useDmCall`, `sheetBridge` (G11) |
| `components/glass/pill/` | `CallPill`, `model.ts`, `useCallPill`, `pillActions`, `muteStore`, `PillPreview`, `PillRoster`, `pillMotion` (G12) |
| `components/glass/stage/` | `Stage`, `StreamSurface`, `StagePeople`, `StageControls`, `StageMenus`, `useStageWatch`, `useStageData`, `useStageGlow`, `useShareScreen`, `nativeUnderlay` (G14); `TheaterPeople`, `SurfacingMessages`, `stageTransition` (G15); `ClipToast` (G16); `StreamReactionsLayer` and its `.css` (G17) |
| `components/glass/sheets/` | `Sheets`, `SheetFrame`, `sheetStore`, `PeopleSheet`, `ChannelSheet` with `ThreadsPage`, `SummaryPage`, `FollowsPage`, `NotificationsPage`, `RemindersSheet`, `AccountMenu` (G18) |
| `components/glass/cards/` | `MediaFrame`, `ReactionBite`, `CatchUpDivider`, `InlineChips`, `PlanCard`, `EventPlanCard`, `useGuildEvent`, `eventRefs` (G13) |
| `lib/room/` | `roomController`, `tokenWriter`, `analyzeFrame`, `color.ts` (the clamp box), `sources.ts`, frame sources (`imageFrameSource`, `viewFrameSource`, `nativeSample`, and the DEV-only `fixtureFrameSource`, `devFixture`) (G2, G8) |
| `lib/media/clips/` | `clipRing`, `clipTimeline`, `webmMuxer`, `mp4Muxer`, `clipMux`, `clipStore`, `useClip`, `ClipAttachment`, `clipSource`, `nativeClipSource` (G16) |
| `lib/media/` (engines) | `browserMediaEngine`, `tauriMediaEngine`, `mediaKeyring`, `engineShared`, `senderKeys`, `roomFrameTap`, `transport/webTransport` (G6, G6b, fix-rejoin, fix-watch-audio) |
| `lib/motion/sharedElement.ts` | The Glass morph engine for stage moves (G15) |
| `stores/glassStore.ts` | Layout state: stage mode and target, browse, chat hidden, pill expanded, places overlay, open sheet (G7) |
| `stores/voiceStore.ts`, `stores/voice/` | Listen, watch, ambient and watcher state: `viewSessions`, `watchers`, `viewFrames`, `selectors` (G6) |
| `stores/streamReactionStore.ts` | Stream reactions: receive, echo dedupe, send outbox, merging (G17) |
| `hooks/useGlassKeybinds.ts` | S, T, H, C and Esc while a stage is on screen (G15) |
| `hooks/useChannelPreviews.ts` | Channel previews for the places panel, kept live from `MESSAGE_CREATE` (G9) |
| `styles/glass*.css` | `glass.css` (type, pane, buttons, chips, waveform), `glass-layout.css`, `glass-room.css`, `glass-places.css`, `glass-timeline.css`, `glass-conversation.css`, `glass-pill.css`, `glass-stage.css`, `glass-stage-modes.css`, `glass-cards.css`, `glass-sheets.css`, `glass-pages.css`, `glass-phone.css`; the Glass token block is in `tokens.css` |
| `pages/AppShell.tsx` | Mounts `GlassFrame`; pages, settings dialogs and the command palette hang off it |
| `pages/HomePage.tsx`, `FriendsPage.tsx`, `DMPage.tsx`, `components/home/`, `components/rooms/lobby/`, `components/channel/ForumView.tsx` | G19 pages, the server Overview and forum |
| `components/ui/`, `styles/primitives.css`, `styles/components.css` | Glass primitives for the long tail (G21) |
| `lib/themes.ts`, `hooks/useTheme.ts`, `stores/uiStore.ts` | The two themes and the transparency and motion settings (G1) |

### Server and desktop

| Path | What is there |
|---|---|
| `crates/paracord-api/src/routes/channels/previews.rs`, `crates/paracord-db/src/channel_previews.rs` | Channel previews (G4) |
| `crates/paracord-api/src/routes/voice.rs`, `routes/message_features.rs` | Listen join, `/mode`, `/view`, `/watchers`, view sweep and access re-check; `listen_in_enabled` feature (G5, G6b) |
| `crates/paracord-api/src/routes/voice_reactions.rs` | Stream reactions route and `STREAM_REACTIONS` batching (G17) |
| `crates/paracord-relay/src/` (`room.rs`, `participant.rs`, `relay.rs`), `crates/paracord-transport/src/control.rs` | View participants, roster `kind`, ambient keyframe-only fan-out, close reasons (G5, G6b) |
| `crates/paracord-server/src/main.rs` | View-token admission; no track state at connect time (G5, fix-rejoin) |
| `crates/paracord-db/migrations/` and `migrations_pg/` `20260929000001_voice_listen_mode.sql` | `voice_states.mode`, `self_stream_started_at`, `listen_in_enabled` (G5) |
| `crates/paracord-contracts/src/channel.rs`, `voice.rs`; `contracts/api-contracts.json`; `client/src/api/generated/` | Wire types for previews, voice state, view sessions, watchers, stream reactions (G4, G5, G17) |
| `crates/paracord-api/tests/` `channel_previews.rs`, `voice_listen_view.rs`, `stream_reactions.rs` | Route tests (G4, G5, G17) |
| `crates/paracord-api/src/routes/users.rs` | `DEFAULT_THEME = "glass"` (G1) |
| `client/src-tauri/src/native_media/` | Viewer slot and session roles (`mod.rs`, `session.rs`), key rotation plans (`events.rs`), `native_render/sample.rs` (room sample), `clip_buffer.rs` (clip ring), `native_render/{linux,macos}.rs` (`fit`) (G6, G6b, G8, G16, fix-watch-audio) |

### Tests, harnesses and scripts (`client/`)

| Path | What it is | Ports |
|---|---|---|
| `e2e/glass-review.spec.ts`, project in `playwright.config.ts` | Mocked reference scene, seven states (G2) | 4173 / 4175 |
| `e2e/glass-room.spec.ts` + `glass-room.config.ts` | Room light: warm, cool, crossfade, budget, Home, reduced transparency (G8) | 4393 / 4395 |
| `e2e/glass-pill.spec.ts` + `glass-pill.config.ts`, `glass-pill-dev.mjs` | Call pill states and the spring (G12) | 4413 / 4415 |
| `e2e/glass-stage.spec.ts` + `glass-stage.config.ts`, `glass-stage-dev.mjs` | Stage, side by side (G14) | 4423 / 4425 |
| `e2e/glass-theater.spec.ts` + `glass-theater.config.ts` | Theater, browse and moves (G15) | 4433 / 4435 |
| `e2e/glass-sheets.spec.ts` + `glass-sheets.config.ts`, `glass-sheets-dev.mjs` | Sheets and menus (G18) | 4383 / 4385 |
| `e2e/glass-pages.spec.ts` + `glass-pages.config.ts` | Home, DMs, Friends, Overview, forum (G19) | 4383 / 4385 |
| `e2e/glass-phone.spec.ts` + `glass-phone.config.ts` | Phone shell (G20) | 4443 / 4445 |
| `e2e/glass-longtail.spec.ts` + `glass-longtail.config.ts` | Long tail and the primitives gallery (G21) | 4373 / 4375 |
| `e2e/fixtures/glass/` (`scene.ts`, `install.ts`, `pages.ts`, `generate-images.mjs`, PNGs) | Shared scene and mocks for the specs above (G2, G9, G13, G19) | |
| `e2e/glass-pill-live.mjs` | Live proof of the pill (G12) | `--vite-port` 18730 |
| `scripts/glass-scene.mjs`, `scripts/glass-scene/{scene,seed,api,art,assets,media-init,ui,call,shots}.mjs` | Live scene driver (G3) | |
| `scripts/glass-scene/{media-probe,g6b-probe,stage-live,moves-live,clip-live,reactions-live}.mjs` | Live probes for media sessions, viewer keys, stage, moves, clips, reactions (G6, G6b, G14, G15, G16, G17) | |

## Owner decisions (glass-plan §8, 2026-09-29)

- **Looks retired.** Glass is the only layout and look. High contrast, Reduced
  transparency, Reduced motion and Custom CSS stay as settings.
- **Ambient view accepted.** Members viewing a server with a live stream receive
  its lowest layer to light the room: capped frame rate, one per client, closed
  when the window is hidden or on another server, never shown as watching.
- **Watch is the stream, Listen is the voices.** Watch is the stream's video and
  its own audio; Listen is the voices. Both are visible to others; ambient is not.
- **Defaults accepted.** A "More" button in the call controls (soundboard, Watch
  together, invite, devices, connection check); deafen in the mic menu; Split
  pane retired; voice channel chat beside the stage; stage channels use the stage
  look; the server home is an "Overview" (G9 built it as a server-menu item, not
  a row); App Home keeps DMs and friends.
- **One danger color**, only for destructive confirms and errors.
- **Plans.** Events and polls get the plan-card style now; event capacity later.

## Known follow-ups

Each item names the checkpoint it came from. "Handed to G22" follows this
section.

### Server and media

- The relay stores wrapped track keys by recipient user id, but they are sealed to a session's call key; key them by session receipt or drop them when the session ends, and add a relay regression test next to `availability_bounds_tests.rs` (fix-rejoin).
- A comment on the `StreamKeyAnnounce` handler in `relay.rs` still describes the connect-time `send_initial_track_state` delivery that was removed (fix-rejoin).
- When a viewer leaves, other watchers stall for 104 to 668 ms while the publisher switches to the new screen key; announcing first and switching a moment later would remove it, in both engines (G6b).
- A viewer's arrival does not rotate the stream key, by design; a new viewer could open packets from earlier in the current epoch if it recorded them with the relay's help (G6b).
- The roster marker says `viewer`, not watch or ambient, so the publisher also wraps the screen-audio key to ambient viewers and the relay drops it (G6b).
- Calls are not re-checked when a member loses VIEW_CHANNEL or CONNECT; only views are (G5, G6b).
- An unknown roster `kind` makes the desktop drop the whole control message (strict serde) (G6b).
- The relay repeats `TrackPublish` after every key announce; clients now ignore an unchanged repeat (G6b).
- Soundboard still lets a listener play sounds, and `voice_speaking` accepts a listener's speaking edges (G5).
- The legacy `OP_MEDIA_CONNECT` path admits a publishing participant without SPEAK, stage suppression or listen-mode checks, and the WebSocket op-4 event hard-codes `suppress: false` (G5).
- `voice_v2::join_voice_v2` and `recover_voice_v2` still compile but are no longer routed; delete them (G5).
- LiveKit has listen through the join grant and `/mode`, but only native media has view sessions (G5).
- An account's stored `user_settings.theme` is not rewritten to `glass`; the client maps old ids on read, and a one-line migration on both engines would normalize rows (G1).
- A server-side `unread_count` (capped) on `GET /users/@me/read-states` would replace one request per unread channel; `useUnreadMessageCounts.ts` and its test then go (G2, G9).
- The server makes no thumbnails, so a picture lead in the places panel downloads the whole file (G9).
- Events have no capacity, no attendee list and no creator on `ComingUpEvent`, so "1 spot left", the open slot and a host face on Home's Coming up cannot be drawn (G9, G13, G19).
- An event in a voice channel gets an auto-created text channel (`event-haz-5-run`) as its start approaches; the reference has none, and nobody decided (G3).
- The previews endpoint could return several recent authors if faces on rows should come from the server; the client keeps its own list from loaded messages (G4).
- `channelApi.getChannelPreviews` validates through `loadValidators()`; `contractValidators.ts` could carry `isChannelPreviewList` and the call could use `responseContract` (G4).
- `STREAM_REACTIONS` was exercised on the SSE transport only, not on the WebSocket gateway, and its route tests ran on SQLite only (G17).

### Stage

- Not joined, camera tiles show faces, not video: a watch view carries one stream (the screen and its own audio), and showing cameras needs the view to carry camera tracks. Owner question, because it changes what Watch costs and reveals (G14).
- Stage channels (type 13) have no Glass treatment: listen is refused for them (400), and "Request to speak" as a text decision is not built (G5, G12, plan §8.4).
- The compact frame (768 to 859 px) squeezes the side-by-side stage beside the 420px conversation; decide whether that layout should exist (G7, G14, G20).
- A centered `cover` crop cuts faces at the eyes and chin in very wide camera tiles (about 3.3:1); a camera-specific upper-third anchor would need to be added to the canvas renderer and the shader. Design call (fix-watch-audio).
- Reactions are `aria-hidden` and not announced to screen readers. Owner question (G17).
- The stage still says `'fire'` where the wire says `flame`; rename the three spots in `StageControls.tsx`, then delete `toWireKind` and the alias in `StreamReactionsLayer.tsx` (G17).
- Your own share cannot be clipped: a clip taps a decoder's intake, and your share never passes through one (G16).
- Clip timing: A/V sync was verified by construction and unit tests, not measured live; the MP4 writer has no `ctts`, so a B-frame encoder would need it; the Rust track map forgets a track only on `TrackUnpublish` (about 100 bytes per stream) (G16).
- Stage moves: the first 100 ms of side to theater can show the stream box's letterbox band over the people row; the clip toast scales with the stream during T instead of gliding; the pointer shield blocks input for 650 ms per move on the desktop (G15).
- The stage subtitle appends " · N watching" after "live for 42 min"; remove the one span if the owner disagrees (G14).

### Pill

- Not built: "Open Lounge chat" in the expanded pill (a door to a voice channel's text chat) (G12, plan §1.3).
- Deafen lives in the stage's mic menu; the pill's mic has no menu (G12, G14).
- A DM call still has the conversation header's call button beside the pill's Leave; `useDmCall.ts` and that button go when the pill carries DM calls (G11, G12).
- The pill's tooltips are native `title` attributes; the near-solid popovers of spec §5 have no user there (G12).
- The compact row draws no talking name (the reference draws none either); say if the owner wants one beside the waveform (G12).
- The stage transition finds the pill by its classes (`.glass-pill[data-layout="row"] .glass-pill__surface`), not a `data-motion-shared` marker; renaming them turns the open into a scale and fade (G15).
- `glass-pill-live.mjs` prints its "nameless placeholders" NOTE even at 0; make it conditional (G6b).

### Places, Home and Overview

- `glassStore.sheet === 'server'` renders nothing and `openSheet('server')` is not wired from `places/`; per-server notification levels and "create channel" are not menu items (they live in Server settings) (G18, G9).
- The Overview is a server-menu item, not a row; owner call if a row is wanted (G9).
- Home's places list has Friends but no "Mentions" or "Saved" rows (plan §1.3) (G9).
- Forum channels get a row, but the previews endpoint holds no messages for them, so they read as quiet one-liners (G4, G9).
- Add-on rows have no live cue beyond their words, and server icons can be an API path in a browser without a download ticket (G9).
- With several streams in one channel, the room lights from the earliest-started stream while the places panel names the first sharer in speakers-first order; they can differ (G8).
- Places previews name an event only when it is in the calendar the panel loaded (scheduled or active); finished, canceled and other-server events read "an event", as do the search overlay, reply chips and notifications. Carrying the name on the wire (`<event:ID:name>`) would fix all of them (G13, polish-1).
- `GameServerParts` `StatusDot` still draws a status dot in the Game servers widget (G19).
- A forum post's header shows the server as its line because `GuildPage` builds the subject; "Strategy" would say more (G19).

### Timeline and cards

- Nothing emits `<event:ID>` yet: the composer and the events list ("Share to channel") do not offer it (G13).
- The catch-up divider is absent when read states have not loaded at open time, and for a channel that was never read (G13).
- `ReactionBite` duplicates the who-reacted popover of `ReactionChip` in `message/ReactionPeople.tsx`, which `rooms/lobby/FeedItemMessage.tsx` still uses (about 100 lines); a shared hook would remove the copy (G13).
- `FilePreview.tsx` (an encrypted attachment's preview) still uses Lantern classes around `MediaPreview` (G13).
- The typing bubble sits at the end of the timeline; the reference puts it between the picture and Jeremy's message. A picture-only message's action plate sits at the far right of the column; the reference shows none. A small picture is scaled up to the frame's 240px (G13).
- `fromRoom` rows (the stage ribbon's "from the room" raised row) keep `data-from-room`, but nothing draws it; decide whether the Glass stage chat wants it (G10).
- Reply nesting depth is no longer drawn; `computeReplyLayout` stays exported and tested (G10).
- The contrast audit does not cover the card chips; they were checked by hand (G13).

### Sheets

- Follows (announcement channels) is covered by unit tests only; the scene has no announcement channel (G18).
- A sheet covers the header including the call pill (one Escape closes it); say if the owner wants the pill kept (G18).
- The profile card opened from a member row closes with the sheet on Escape, and Unpin is offered to anyone who can see a pin (the server refuses it) (G18).

### Phone

- Hardware and browser back go to the previous route, not to the list; places is not a history entry. The header chevron and the edge swipe are the ways back (G20).
- The swipe is a threshold gesture (60px from the edge, then a 360 ms move), not a drag that follows the finger (G20).
- A navigation that is not a tap (a notification, the command palette, an accepted call) while places is in front changes the route and leaves places showing (G20).
- Landscape phones under 768px wide get the stream card capped at half the window height and nothing else; the on-screen keyboard is not handled (the shell is `100dvh`) (G20).
- Full screen is a portrait band (the stream keeps 16:9); the Fullscreen and orientation APIs are not used (G20).
- Not run on a device, in Tauri mobile or in WebKit; Chromium only (G20).
- `hooks/useGlassKeybinds.ts` still ignores C on a phone (`case 'clip': if (phone) return;`); the card has a Clip button now, so the guard can go (G20).

### Long tail and settings

- Row titles in Settings still use `text-label` (14/500), and settings lists keep their hairline `divide-y` dividers instead of tonal rows (G21).
- `--focus-ring` paints its 2px gap in `--bg-base` (near black) instead of leaving it transparent, which reads as a black gap on lighter surfaces; a one-line change in `tokens.css` or `focus.css` (G21).
- Native controls keep the browser's own look: color picker, range sliders and the file input (G21).
- `Button variant="light"` is kept as an alias (same cream as `primary`); it is still used by `voice/StageSpeakers.tsx` and `/design-tokens`, so drop it after those go (G21).
- `globals.css` still imports the Onest, Gabarito and JetBrains Mono fonts as fallbacks (G0).
- `--text-link` is `--ink-1`; Glass specifies no link color, so links rely on underline or weight (G0).
- `widgets/HomePageSettings.tsx` still has `aria-label="Home page widgets"`; `components/dm/IncomingCallBanner.tsx` and `styles/glass-pages.css` comments still say the banner stack reserves the capsule's height (polish-1).
- `components/glass/room/useRoomSource.ts` still works around the old authenticated image behavior; harmless (polish-1). `BannerStack` finds the incoming-call capsule by its class; an explicit "floats" marker on `IncomingCallBanner` would be sturdier (polish-1).
- Comments still name retired looks: `looks.css` in `styles/primitives.css` (near `.pc-message-row`), `--ui-hue` and `--ui-chroma` in `lib/nativeGround.ts` and `lib/room/fixtureFrameSource.ts`, "all four themes" and "Night" in `pages/DesignTokensPage.tsx` (G1).
- Owner review of G1's calls: Reduced transparency is three choices (match system, standard, reduced) rather than a switch; High contrast drops the room tint and its values, including the 12:1 floor, have no reference render; the danger well is a mix of the one danger ink (G1).

### Tests and tooling

- `glass-review.spec.ts` states 03 to 06 are route placeholders with stale `pending` strings; the real states are shot by the package specs (`glass-pill`, `glass-stage`, `glass-theater`) (G2, G12).
- `glass-scene.mjs` still lists `03-listen` as `pending`; the pill now makes it reachable (press "Listen in to Lounge", then "Show who's in Lounge") (G3, G12).
- Harness fixtures: General has no topic, so the header shows the server name where the reference shows a topic; DM recipients carry no `display_name` (names read lowercase); avatars are initials; there is no `PATCH /users/@me/settings` handler, so saving a setting shows "Could not save theme" and rolls back (G1, G2, G11, G19).
- The mocked realtime stub refuses read-state acks, so specs see "Failed to save read position" toasts; the specs clear them before each shot (G15).
- `glass-stage` "the conversation keeps working beside the stage" (main is 940 wide, not 420) and `glass-sheets` "a sheet fits the conversation beside a stream" (one pixel off) measure 500 and 900 ms after opening a stage, in the middle of the 650 ms move; wait for the move first (G20).
- `glass-pages` and `glass-sheets` both default to ports 4383 and 4385, so they cannot run at once; set the `PARACORD_E2E_*_PORT` variables (configs).
- There is no committed assertion that a ringing incoming-call notice takes no layout space; it belongs in `glass-pages.spec.ts` (polish-1).
- Live scene: timestamps are real, so the catch-up divider says "4 new", not "6"; states marked `unread` take down and repost messages; DMs (end-to-end enrollment) and the Sunday League live match are not seeded; headless Chromium only; `pc-lab.sh` was not exercised; the holder's cast got 401 on `/stream/ticket` about 40 minutes in; a SIGKILLed holder leaves its seats for 30 to 60 seconds (G3, G8).
- Live check of the G19 pages against a real instance was not run (an incoming DM call was simulated with a `VOICE_STATE_UPDATE` frame); High contrast and Reduced transparency were not eyeballed on those pages, and Home's wrapped two-line "Pick up" preview is covered by tests, not a shot (G19).
- No checkpoint records a `client/scripts/live-drive.mjs` run against Glass (messaging regressions); plan §5.3 puts it at G23.
- `scripts/literal-color-audit.mjs` still allows literal colors in `hooks/useTheme.ts` for `ACCENT_PRESETS`; the file has none now, so the entry hides a future mistake (G1).
- `cargo fmt --all -- --check` flagged `crates/paracord-server/src/main.rs` and `crates/paracord-api/tests/voice_listen_view_sse.rs` (both unformatted before Glass) as of G17; `cargo test --workspace` and a PostgreSQL run of the stream reactions tests were not run (G4, G5, G6b, G17).

### Desktop and WebKitGTK

The desktop app (Tauri on WebKitGTK) was not run for any Glass package. Every
native-route claim below is compiled (vpx on), clippy-clean and unit-tested
only. WP-G23 (live verification and WebKitGTK performance) is the package that
closes this, and it has not run.

- Room light: the ambient view decodes nothing on the native-surface route, because the headless tap branch in `tauriMediaEngine.ts` settles the route and subscribes nothing. The fix is to call `native_render_attach_sampler`, register a lowest-layer subscription and detach in `stop`. Until then the room cannot sample an ambient stream there and the pill preview shows the tint (G8, G6).
- CPU with a live stream, room light and stage is unmeasured in the app. G8's probe page on WebKitGTK 2.52 measured the room at about 2 to 3 percent of a core once the pane color transition was removed (55 percent with it). Also to measure: the timeline's fade mask (G10), the rising reaction discs with `backdrop-filter: blur(16px)` (G17), and the waveform and typing-dot animations (80 to 90 percent of a core in headless Chromium's software compositing) (G8).
- Stage moves on the native route use a shield and a poster; it is unit-tested at event level only. Check that the surface hides before the first frame of a move, returns at the settled box, and what the move costs; camera tiles show a black canvas while hidden (no per-camera poster) (G15).
- Clips on the desktop: the Rust ring (`clip_buffer.rs`) and its three commands were not cut live; playback of the posted WebM and MP4 in WebKitGTK is unverified; the clip thumbnail on the native route is the 32x18 sample scaled up (G16).
- Stream audio for a watch without joining on the desktop, the Linux shader's `cover` and the native tile's `fit` plumbing are unit-tested only; the macOS `videoGravity` line is compile-unverified (fix-watch-audio).
- Key handling: the native session's per-track rotation plans, `media_announce_sender_keys` and the older bug they fix (members not sent a desktop publisher's rotated keys after a join) are inferred from code and plan tests (G6b). The Tauri engine has the same leave-during-announce race as the browser had (fix-rejoin).
- One subscription per track: a second `subscribeVideo` for the same track on the desktop replaces the first, so two surfaces of one stream still fight; taps survive it (G6).
- The sheets use `:has()` in a few selectors; WebKitGTK 2.52 supports it, but the desktop build was not opened (G18).

### Design differences versus the reference

- The message box is 744px wide (the render and prototype CSS), not the column's 720; `--glass-composer-bleed: 12px` flips it. Its focus ring is on the capsule, not the bare input (G11).
- The column goes fluid when the pane is under 776px (below about a 1140px window), not at 1100px, because the prototype's `max()` formula was kept (G7).
- Text bubbles follow spec §2.4 joined corners. The prototype's own CSS has a missing semicolon, so its renders show text bubbles fully round (G10).
- Bubble width caps at 560px absolute, not 78% of the column, so a narrow column uses its full width as the renders do (G10).
- The current server with something live wears the white bar, not the amber ring; other servers with something live wear the ring (G9).
- Reactions on a bubble or card anchor by their bottom edge instead of biting 12px up, so they do not cover the first line; the live chip's "3 in" is at 80% alpha, not 72%, for 4.5:1 (G13).
- The pane's far-corner glow is static; the prototype breathes it (G0).
- The pill's surface animates `border-radius` with its scale (an exception to transform and opacity only); delete the `borderRadius` keyframe pair in `playPillResize` for the strict reading (G12).
- The mic glyph is lucide's `Mic` and `MicOff`, a hair different from the prototype's slash (G12).
- Joined stage controls include More before Leave, so the row sits 27px further left than `04`; the stage's glow is subtler than the prototype's hand-set teal (G14).
- Toasts use `--raise` instead of the reference's near-black, for separation on a pane; dialogs are opaque `--solid`; warnings, success and info are ink, not color (G21).
- The clip bubble's play circle and label are solid, not blurred, because the timeline has no blur (WebKitGTK cost) (G16).
- Phone: the header has a back chevron, search and people where the reference has none, and the card sits one pixel lower (G20).
- A channel is quiet after 7 days with nothing unread and no mention (`QUIET_AFTER_MS` in `places/model.ts`). The reference draws a two-day-old channel as quiet beside fuller rows of similar age, which no recency rule reproduces, so the harness moved Patch notes to nine days old (G9).
- Removed on purpose from the timeline: role colors on author names (names are ink-1), the "in Lounge" line and presence rim on faces, reply nesting indentation, and the always-visible touch "Message actions" chip (now tap to reveal) (G10).
- Fixture-driven differences, not bugs: initials instead of illustrated faces, the DEV fixture scene instead of the cave, "7 online" for 8, "3 going" for "1 spot left", Trips' line shows the newest message, Vincent has no camera in the scene so he is a chip (G9, G13, G14).

## Handed to G22

Work the checkpoints assigned to the package that retires Lantern. WP-G22 closed
these (details in [`glass-g22-checkpoint.md`](glass-g22-checkpoint.md)); the two
left open are marked.

Components, pages and hooks

- [x] `components/layout/TopBar.tsx`, `ConversationHeaderActions.tsx` and the five `TopBar.*.test.tsx` files. TopBar is still drawn by `pages/guild/GuildStateScreens.tsx` (loading and not-found) and mocked in `GuildPage.test.tsx` and `TextRoom.test.tsx` (G11, G18).
- [x] `components/layout/ContextPanel.tsx` and its test: nothing renders them (G18).
- [ ] (kept, still working; a refactor for later) `uiStore.contextPanelMode` is only a request channel now; `CommandPalette`, `useKeyboardNavigation` (Mod+F), `ServerHome` and `DMPage` can call `toggleSheet('search')` and `openChannelSheet('media' | 'leaderboard')` directly, then the field can go (G18).
- [x] `components/voice/OnAirDock.tsx` and `components/layout/sidebar/*` (`UnifiedSidebar`, `CallDock`, `BuildingsColumn` and the rest): nothing outside each other imports them (G20).
- [x] `components/light/**`: now imported only by the Lantern files in this list (`TopBar`, `layout/sidebar/*`, `OnAirDock`, `voice/stage/*`, `StreamViewer`, `VoiceStageChannel`, `VoiceLobby`, `StagePreviewPage`) (G19, G21; import check at the time of writing). Keep `lib/attention/*` and `hooks/useUnifiedConversations.ts`: Home's For you and the places panel read them (plan §1.1).
- [x] `components/onboarding/LayoutTour.tsx` and its test: still mounted by `AppShell.tsx`; the anchors it points at are gone (G7, G11).
- [x] `pages/StagePreviewPage.tsx` and its two routes (`/design-stage`, `/app/design-stage`) in `App.tsx` (plan G22, G2).
- [x] `pages/guild/VoiceStageChannel.tsx` is still what a voice channel's route renders (`GuildPage.tsx:176`), with the welcome and onboarding gates and its own watch path (`setWatchedStreamer`, `SplitPane`, `StreamViewer`, `useWebcamTiles`, `useScreenShareSubscriptions`, the 1.2 s auto-clear). A voice channel's route needs to show that channel's conversation (`RoomChat`) beside the stage before it goes (owner decision, plan §8.4) (G14, G7). `pages/guild/VoiceLobby.tsx` and `components/voice/stage/*` (the Lantern stage) belong to the same retirement; they are used by `StreamViewer`, `VoiceStageChannel`, `VoiceLobby`, `StagePreviewPage` and `pages/guild/RoomChat.tsx` (which imports `RoomChatRibbon`), so settle what the voice route's chat uses before deleting them.
- [x] `components/voice/StreamViewer.tsx`, `SplitPane.tsx` and `SplitPaneSourcePicker.tsx`. `DMPage.tsx:297` still shows a DM call's stream with `StreamViewer` and `DMPage.tsx:341` uses `VoiceControlBar` as the DM call dock, so both need a Glass home first; `StreamViewer` keeps its own native-underlay refcount beside `stage/nativeUnderlay.ts`, which DM calls can use instead (G14, G11, G12).
- [x] `glass/stage/useShareScreen.ts` and `StageMenus.tsx` copy `getStreamErrorMessage` and the `InCallDeviceMenu` device logic; dedupe when `VoiceControlBar` and `InCallDeviceMenu` go (G14).
- [x] `components/layout/ChannelSwitcher.tsx`: mounted only by the old TopBar; delete both (G21).
- [x] The phone header's navigation (the phone-header `PlacesToggle` item): in `glass/conversation/ConversationHeader.tsx` render `<PlacesToggle className="glass-header__btn glass-header__nav" />` for channels and messages, delete `drawerButton`, `backButton`, `useNavigate` and the `sidebarCollapsed` subscription, and delete the drawer-button block and the `aria-label$='sidebar'` mask in `glass-phone.css` (G20).
- [x] `glass/stage/Stage.tsx` phone branches of its overlay (title group, X stop button, `phone ? undefined` labels) are hidden by `glass-phone.css` and replaced by `PhoneStageChrome`; delete them or move the chrome into `stage/` (G20).
- [x] (the dead sidebar roving is gone; `Ctrl+B` stays, it still brings places back on a phone) Related, classification unsure: `hooks/useKeyboardNavigation.ts` still documents and binds `Ctrl+B` ("toggle Unified Sidebar collapse") and sidebar arrow-key roving written for `UnifiedSidebar`; `Ctrl+B` has no effect on the wide Glass frame (G7; layout-spec §5).

Dead CSS

- [x] `styles/glass-layout.css`: the block "Phone (today's phone frame until WP-G20)" (three rules on `.glass-frame[data-layout='phone']`, `… .glass-pane` and `… .glass-frame__stage`) (G20); the `.glass-conversation__heading` and `.glass-conversation__places-toggle` rules (G11); the `.glass-outlet` adapter for Lantern page wrappers, used in `AppShell.tsx`, once no page wraps itself in street and plate (G7). (Kept: sports, daily word and settings pages still use `bg-bg-base` and plate shadows.)
- [x] `styles/glass-conversation.css`: `.glass-conversation__phone-pill { padding: 8px 8px 0 }`, overridden by `glass-phone.css` (G20).
- [x] `styles/components.css`: the `.chat-header*` rules (old conversation header) and `.message-composer-secondary`, `-more` and `-surface` (G11, G21).
- [x] `styles/primitives.css`: `.pc-message-row` matches nothing (G10).
- [x] `styles/layout.css` lines 9 to 23: `color-scheme` rules for `light`, `amoled` and `high-contrast` (G1, G21).
- [x] `styles/server-home.css`: almost all `pc-home-*` is dead; only `pc-home-enter` is used, by `ServerHome` (G19).
- [x] `styles/tokens.css` `--h-mobile-nav` (0px) and its reads in `components/ui/Toast.tsx` (G20).
- [x] `pages/DesignTokensPage.tsx` primitives section still carries Lantern copy ("off is a well, on is the emerald", "Lantern Stage") (G21).

Tests, scripts and docs

- [x] `e2e/smoke.spec.ts`: rewrite for Glass. It fails at line 526 (`Switch channel, current:`), asserts the Lantern header (`.chat-header`, four `.chat-header-actions` buttons, "More channel actions", "Back to messages", "People here now"), the "Servers and channels" listbox (about line 650), "Your servers" (lines 465 and 760) and the LayoutTour "Skip tour" button (G11, G19, G21).
- [x] `e2e/motion-gate.spec.ts` (28 cases): rewrite for Glass moments (hover step, pill expand, pill to stage, theater, browse, room crossfade); the Lantern "walk into the shop floor" flow starts from the old Home (plan G22, G19).
- [x] `e2e/design-review.spec.ts`: retire; it asserts "Your servers", the server `article` and `group`, and "Join voice" at lines 1292, 1311 and 1324 (plan G22, G19).
- [x] `scripts/glass-scene/clip-live.mjs`: the `eric-watching` step treats stream audio when not joined as a NOTE; it now finds an Opus track, so make it a PASS (fix-watch-audio).
- [x] `docs/design/wp9-summary.md` maps the Lantern motion gate; update or mark it when the gate is rewritten (docs check, not from a checkpoint).

Glass imports these Lantern-era files, so they stay when the lists above are deleted: `components/voice/streamOverlayPortal`, `VoiceConnectionCheck`, `SoundboardPopover`, `ScreenSharePickerModal`, `together/*` (stage More menu and `AppShell`), `layout/overlays/*` and `layout/GroupDmMembersPanel` (sheets), `layout/CommandPalette` (AppShell).

## Verification entry points

Screenshots go to `output/design-reference/glass-build/<tag>/` (gitignored);
the reference renders are in `output/design-reference/glass/screens`.

### Mocked review harness (no server)

```bash
cd client
PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=<tag> npx playwright test e2e/glass-review.spec.ts
```

Writes `<state>-{desktop,phone}.png` at 1440x900 and 390x844 for states
`01-conversation` to `07-phone` (about 45 seconds). Ports 4173 and 4175 are
fixed, so another checkout's run collides. Regenerate the PNG fixtures with
`node e2e/fixtures/glass/generate-images.mjs`.

### Per-package configs

Each runs its own Vite dev server (HMR off) and realtime stub on its own ports:

```bash
cd client
PARACORD_E2E_GLASS_WP=<tag> npx playwright test -c e2e/glass-<name>.config.ts
```

| `<name>` | Covers | Ports | Package |
|---|---|---|---|
| `room` | Room light, crossfade, write budget | 4393 / 4395 | G8 |
| `pill` | Call pill states and spring | 4413 / 4415 | G12 |
| `stage` | Stage, side by side | 4423 / 4425 | G14 |
| `theater` | Theater, browse, moves | 4433 / 4435 | G15 |
| `sheets` | Sheets and menus | 4383 / 4385 | G18 |
| `pages` | Home, DMs, Friends, Overview, forum | 4383 / 4385 | G19 |
| `phone` | Phone shell | 4443 / 4445 | G20 |
| `longtail` | Long tail, primitives gallery | 4373 / 4375 | G21 |

`sheets` and `pages` share ports; do not run them together. Ports can be set
with the `PARACORD_E2E_*_PORT` variables in each config. To reuse servers you
started yourself (sheets), set `PARACORD_E2E_SH_REUSE=1` and start
`VITE_DEV_PROXY_TARGET=http://127.0.0.1:4385 VITE_DEV_HMR=false node e2e/glass-sheets-dev.mjs 4383`
and `PARACORD_E2E_RT_PORT=4385 node e2e/realtime-stub.mjs`. Do not
`pkill -f vite` or `-f realtime-stub`: the patterns match other checkouts'
servers (G18).

### Live scene on a real instance

```bash
cd client && npm run build
touch crates/paracord-server/src/embedded_ui.rs        # otherwise the embedded UI is stale
~/Documents/Paracord-wt/tools/pc-cargo.sh build --release --bin paracord-server
node scripts/live-env.mjs --port <port> --data <dir>
# confirm the served bundle is the one just built
curl -s http://127.0.0.1:<port>/ | grep -o 'assets/index-[^"]*\.js'; ls client/dist/assets | grep '^index-.*\.js$'

node client/scripts/glass-scene.mjs --base http://127.0.0.1:<port> --out <dir> --hold    # seed, start the Lounge call, hold it
node client/scripts/glass-scene.mjs --base http://127.0.0.1:<port> --shot all             # seed, fresh call, shoot every reachable state
```

`glass-scene.mjs` options: `--shot <names|all>`, `--hold`, `--no-call`,
`--reseed`, `--seed-only`, `--tag <suffix>`, `--no-typing`, `--headed`,
`--out <dir>`. It writes `scene.json` (ids and sign-ins) next to its shots;
the probes read it. Ctrl-C leaves the call cleanly. States are in
`scripts/glass-scene/shots.mjs` (`03-listen` is still `pending`). Everything
started is stopped by SIGINT of the holder, then `live-env`.

With a scene held (`--hold`), run the probes against the same `--base` and
`--scene <dir>/scene.json`:

| Script | Proves | Runs the app from |
|---|---|---|
| `node client/scripts/glass-scene/stage-live.mjs` | Stage: watch without joining, watcher counts, join and leave from the stage, Esc (G14) | the embedded build |
| `node client/scripts/glass-scene/clip-live.mjs` | Clips: cut, post, download, ffprobe and Chromium playback, freed on switch (G16) | the embedded build |
| `node client/scripts/glass-scene/reactions-live.mjs` | Stream reactions: own bubble, who receives, echo, merging, reduced motion (G17) | the embedded build |
| `node client/scripts/glass-scene/moves-live.mjs` | Stage moves held at fixed moments on a real stream (G15) | the embedded build |
| `node client/scripts/glass-scene/media-probe.mjs` | Listen, upgrade in place, watch, ambient, carry-over (G6) | a Vite dev server proxied to the instance (`--vite-port`) |
| `node client/scripts/glass-scene/g6b-probe.mjs` | Viewer keys, roster marker, superseded and revoked (G6b) | a Vite dev server |
| `node client/e2e/glass-pill-live.mjs` | Every pill button against a real relay (G12) | a Vite dev server (`--vite-port`) |

`watch-audio-live.mjs` (fix-watch-audio) was kept with its evidence under
`output/design-reference/glass-build/fix-watch-audio/` and is not in the
repository.

### Desktop app (not yet run)

```bash
cd client
VITE_DEV_PROXY_TARGET=http://127.0.0.1:18420 npx tauri dev
top -b -n 30 -d 1 -p $(pgrep -d, WebKitWebProcess)     # CPU with a stream, room light and stage
```

The other cast members stay in Chromium through `glass-scene.mjs`. G8's
WebKitGTK probe page and script are in
`output/design-reference/glass-build/g8/webkit-probe/` (run with
`WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`, as the app sets on this NVIDIA box).

### Gates for every client package

In `client/`: `npm run typecheck`, `npm run test:unit`, `npm run test:tokens`,
`npm run test:motion-lint`, `npm run lint`, `npm run test:a11y:static`,
`npm run test:contrast`, `npm run build`, `npm run test:e2e` (mocked smoke),
`npm run contracts:check`. For the desktop layer:
`cargo check`, `clippy -D warnings` and `test` with
`--manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on). For
server packages: `cargo fmt --all -- --check`, `cargo clippy --workspace -- -D
warnings`, `cargo test --workspace` and the PostgreSQL route smoke
(`postgres_route_smoke`, with `PARACORD_TEST_POSTGRES_URL` set). Cargo builds go
through `~/Documents/Paracord-wt/tools/pc-cargo.sh`.
