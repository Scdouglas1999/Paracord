# WP-G22 checkpoint: retire Lantern

Contract: `docs/glass-spec.md`. Plan: `docs/design/glass-plan.md` (the WP-G22 row, §1.3 and the owner
decisions in §8: voice channel chat beside the stage, stage channels use the stage look, Split pane
retired, "More" in the call controls, Deafen in the microphone's menu). Nothing is committed. Everything is
in `~/Documents/Paracord-glass` (branch `design/glass`).

Glass is now the only UI. The Lantern voice page, the DM call's stream viewer and control bar, the
sidebar, the old header, the context panel, the light components, the layout tour and the stage preview
page are gone, and so are their tests and their CSS. Three things had to be built for that, because the
Lantern surfaces carried features Glass had no door for:

1. **A voice channel's route is its chat** (owner decision, plan §8.4), with the pill for that channel.
2. **The call itself on the stage** ("Show the call"): the only place a joined person could turn a camera
   on, start a screen share or see cameras when nobody shares was the Lantern voice page. The stage now
   opens on a call with no stream, for server voice channels, stage channels and DM calls.
3. **Stage channels** keep their moderation (open, topic, end, raised hands, invite and move speakers,
   request to speak) in a panel over the channel's chat, and the audience rule in the stage's row.

## 1. Voice channels, DM calls and stage channels

### A voice channel's route (`pages/GuildPage.tsx`)

`/app/guilds/:g/channels/:voiceChannel` renders `TextChannelView` like any channel: the conversation pane,
header, timeline, composer. `VoiceStageChannel` is gone from the route.

- **The pill shows that channel** (`pill/model.ts`, rule 0): on a voice or stage channel's route the pill is
  that channel's, even with nobody in it, so it can be joined, listened to or watched from its own chat.
  When it is the call you hold, it is the held call's pill (rule 1) as before. `CallPillProps` gained
  `channelId` (the conversation header and the phone pill pass it).
- **The live row in places** opens the channel's chat and, when somebody streams there, the stage on that
  stream beside it: the voice channel's chat beside the stage. From the pill on another channel, Watch
  still keeps that channel's conversation (screens/04). `PlacesPanel.openLive`.
- **Watch together** activity is on the live row again ("Watching …", "Listening to …"): the Lantern
  sidebar row showed it, the Glass row did not. `PlaceRows.LiveRow` + `useGuildTogether` in the panel.

### The call itself on the stage (`components/glass/stage/CallStage.tsx`)

`StageTarget` is now `{ serverId, guildId: string | null, channelId, streamerId: string | null }`
(`stores/glassStore.ts`). `guildId: null` is a DM call (no server; never the `'dm'` sentinel, which stays at
the `voiceStore` boundary: `pillActions.stageGuildOf` / `voiceGuildOf`). `streamerId: null` is the call
itself. `isStreamTarget`, `StreamStageTarget` and `stageTargetOf` narrow it; stream-only pieces (the stream
box, the watch, the glow, the poster, Clip, reactions) take a `StreamStageTarget`, and `Stage` dispatches to
`StreamStage` or `CallStage`.

- **Door:** the pill, joined, with nobody else's screen to watch, offers **Show call** ("Show the call")
  where Watch would be. With a stream, Watch opens the stream's stage, which has the same call controls.
- **What it shows:** a title row on the pane (sidebar S, the call's name, "3 in the call", **Close**), the
  cameras in a grid filling the pane, chips for everyone without a camera, and the call's controls: mic,
  camera, share | More, Leave (no reactions or Clip: there is no stream). A Watch together video plays in
  the pane (the existing `TogetherWatchStage`, the player's slot), with the people in a 120px row under it;
  Listen together shows what is playing. Clicking somebody who starts sharing switches to their stream.
  With no camera on: "Nobody has a camera on." / "You are sharing your screen…" / "Join the call to see
  cameras and share your screen."
- **Keys:** S and Esc as on the stream's stage; T, H and C stay free (`useGlassKeybinds({ stream: false })`).
  Theater does not exist without a stream, so the desktop falls back to side by side if asked.
- **Phone:** the card shows the cameras (the pill above keeps the roster), full screen shows them large
  with the controls capsule; the chrome's back button is "Close the call view"; no Clip or count.
- **A DM call** is named for the people in it ("Jeremy", from the channel's recipients), with no server:
  More holds only devices and the connection check (no soundboard, invite or Watch together, which are
  server features), and no Share button (see the server gaps below).

### DM calls (`pages/DMPage.tsx`)

`StreamViewer` and the docked `VoiceControlBar` are gone from the DM page (and `ConversationPane`'s `dock`
prop with them). A DM call is the header's call button (start/end, kept), the pill ("Jeremy, voice call":
mic, Show call, Leave; no Listen, which is for server channels), and the call on the stage.

### Stage channels (type 13)

- `stage/StageChannelPanel.tsx` over the chat (the page's notices): "Stage open" + topic, or "Nobody has
  opened the stage yet."; moderators (Manage channels) get the topic field and Open the stage / Save the
  topic / End the stage, raised hands with Let them speak / Dismiss, and (Manage the stage) everyone with
  Invite to speak / Move to the audience; the audience in the call gets Request to speak / Request sent.
  The server's words go under it when a request fails.
- `stage/useStageChannel.ts`: one small store keyed by channel (the panel and the stage's row read one
  instance), refreshed on `paracord:stage-instance-changed`. The requests are the Lantern page's.
- The stage's row: an audience member gets **Request to speak** instead of mic, camera and share; the pill
  hides its microphone for them.
- `stage/useStageAudienceGuard.ts`, mounted once by `GlassFrame`: while you are a stage channel's audience,
  the microphone is muted and camera and share are stopped, wherever you are in the app (the Lantern page
  did this only while it was open).

## 2. Features that lived only in deleted components, and where they went

| Feature (where it was) | Now |
|---|---|
| Camera on/off, start a screen share, see cameras with nobody sharing (VoiceStageChannel + VoiceControlBar) | The call on the stage (above) |
| Share quality: 720p30 … Movie 4K 100 Mbps (the control bar's chevron menu) | More › "Share quality: …" (`StageMenus.ShareQualityMenu`, `useShareScreen` presets); the stage's share had been fixed at 720p30 |
| "Streaming without PC audio: …" warning (control bar) | A toast with the reason when the share starts (`useShareScreen`) |
| Microphone check: level meter and "Microphone needs attention" / uplink state (InCallDeviceMenu) | The top of the microphone's menu in a call (`StageMenus.MicCheck`, `micStatus`) |
| Push-to-talk state on the mic (control bar) | The stage's mic shows transmitting / ready (`data-ptt`, title) |
| Watched stream's volume, mute and viewing quality (StreamViewer) | "Stream sound and quality" on the stream's overlay and the phone card (`stage/StreamSound.tsx`); `voiceStore.watchVolume` is kept for the session and applied to the next watch; quality asks the watch's engine for a simulcast layer (`StreamSurface`) |
| Soundboard burst on the player's tile (StageSpeakers) | On Glass camera tiles and chips (`StagePeople` mounts `SoundboardBurst`) |
| Reconnecting notice (VoiceStageChannel) | The pill says "Reconnecting…" (`PillTarget.reconnecting`) |
| Join failed: "Run a connection check" (VoiceLobby) | The pill's failure toast carries "Run connection check" (Settings › Voice & video) |
| Stage channel moderation and request to speak (VoiceLobby, VoiceStageChannel) | Panel, row and guard (above) |
| Watch together player slot (VoiceStageChannel) | The call on the stage |
| Watching/Listening together line on voice rows (sidebar RoomRow) | The Glass live row |
| Room chat beside the Lantern stage (RoomChat) | The voice channel's route is its chat |
| Game servers popover (sidebar row) | Already the Glass add-on row; its test moved there |

Kept out on purpose:

- **Split pane and layout modes** (Focus / Split / PiP / Share only): retired by the owner (plan §8.4).
- **Watching your own screen** (StreamViewer's self preview): the server refuses a view of your own stream
  ("Your own stream is already on your screen", G5). The call on the stage says "You are sharing your
  screen" and the share button stops it.
- **Transport readout** on the Lantern stage header (native/LiveKit): a diagnostic; the connection check
  covers it.
- **The layout tour**: its anchors were gone (plan §1.3: retire, rewrite later if wanted).
- **Always-visible mute/deafen on the account plate**: the pill's microphone when joined; Deafen in the
  microphone's menu (owner decision); the voice keybinds.

## 3. A bug this package found and fixed: Glass voice toggles never told the server

The pill's microphone, the stage's camera and the menu's Deafen called `voiceStore.toggleMute/Video/Deaf`
directly. Those only change the local track; the Lantern controls went through `hooks/useVoice`, which
then sends the voice state to the server (`publishVoiceState`). With the Lantern control bar gone, the
live scene showed it: Brendan's camera frames reached the relay but nobody saw a camera tile, and Nick,
muted, read "Mic on" to everyone. Also, joining from the pill (muted by the join preference) never told the
server it was muted. Fixed in `pillActions` (`toggleMic` → `toggleVoiceMute`, and `joinCall` publishes after a
join with non-default state), `StageControls` (camera → `toggleVoiceVideo`, new in `hooks/useVoice.ts`),
`StageMenus` (Deafen → `toggleVoiceDeaf`) and the audience guard; unit-tested in `CallPill.test.tsx` and
`Stage.test.tsx`, and seen live (the holder now reports "Brendan (camera, talking), Nick (muted)").

## 4. Server gaps (not changed; reported)

The brief allows server changes only if a DM stage target truly needs one; these do, so they are left for
the owner:

1. **Screen share in a DM call is refused.** `POST /api/v1/voice/{dm}/stream` and `POST /api/v2/voice/{dm}/view`
   answer `400 Not a voice channel` (`routes/voice.rs` `start_stream` and `view_channel_context` require a
   guild voice or stage channel). Recorded live in `output/design-reference/glass-build/g22/live-calls/dm-stream-refusal.json`.
   The Lantern DM page showed a stream viewer that could never receive a stream. The Glass DM stage does
   not offer Share; the client needs nothing else when the server allows it (a DM stream target goes
   through `startWatch` with `voiceGuildOf(null)`).
2. **Voice state updates in a DM call are dropped.** The gateway's `OP_VOICE_STATE_UPDATE` returns when the
   channel has no guild (`crates/paracord-ws/src/handler.rs`, the `let Some(guild_id) = channel.guild_id() else { return; }`
   in the update branch). So in a DM call the other person never learns your mute, deafen or camera state:
   live, Jeremy's own stage shows his camera, Sean's shows him as a chip ("Talking", no camera). The camera
   frames may well reach the relay; the stage only draws a tile for someone whose voice state says camera.

## 5. Deleted

(All paths under `client/src/` unless noted.)

- `components/light/**` (LitAvatar, AvatarStack, HereNowStrip, LightCaption, LiveDot, OnAirPill,
  BuildingPlate, WindowMap, RoomThumbnail, VoiceParticipants, index, tests). Live users moved to Glass
  faces: `ReactionPeople` (and `ReactionBite`, which now shares its who-reacted hook), `RoleMentionChip`,
  `TimelineParts` (thread row faces), `UserProfile`, `UserSettings`.
- `components/layout/sidebar/**` (UnifiedSidebar, CallDock, AccountPlate, BuildingsColumn,
  BuildingSection, RoomRow, CollapsedRail, SidebarSearch, tests); `components/{dailyWord/DailyWordSidebarRow,
  gameServers/GameServersSidebarRow, sports/SportsSidebarRow}.tsx`; `hooks/useRoomThumbnail.ts` (+ test).
- `components/layout/{TopBar, ConversationHeaderActions, ChannelSwitcher, ContextPanel}.tsx` and their
  tests (five TopBar tests). `pages/guild/GuildStateScreens.tsx` was rebuilt on Glass (loading skeleton of
  the conversation, not-found and error as Glass pages).
- `components/voice/{OnAirDock, StreamViewer, SplitPane, SplitPaneSourcePicker, VoiceControlBar,
  InCallDeviceMenu, StageSpeakers, FocusedWebcamView, CameraSurface}.tsx` and their tests,
  `components/voice/stage/**`; `pages/guild/{VoiceStageChannel, VoiceLobby, RoomChat}.tsx`;
  `hooks/{useStream, useWebcamTiles, useScreenShareSubscriptions}.ts`.
- `components/onboarding/LayoutTour.tsx` (+ test) and its mount; `pages/StagePreviewPage.tsx` and its two
  `/design-stage` routes.
- `voiceStore.watchedStreamerId` / `previewStreamerId` and their setters (the Lantern watch state; nothing
  reads them). `ServerHome`'s Join hands a shared screen to the stage instead.
- The dead sidebar arrow-key roving in `hooks/useKeyboardNavigation.ts` (+ its four tests).
- `client/e2e/design-review.spec.ts` and its project (the Glass review harness replaces it).
- CSS: see §6.

Kept, and why: `uiStore.contextPanelMode` (a working request channel the sheets answer; removing it is a
refactor of four callers and their tests, not a retirement); `.glass-outlet` (sports, daily word and
settings pages still use `bg-bg-base` / plate shadows inside the pane); `pc-meter`, `pc-window*`,
`pc-live-dot`, `pc-lit` and friends (the `/design-tokens` page still draws them); `streamOverlayPortal`,
`VoiceConnectionCheck`, `SoundboardPopover`, `SoundboardBurst`, `ScreenSharePickerModal`, `together/*`
(Glass uses them).

## 6. CSS removed

- `components.css`: `.chat-header*`, `.message-composer-surface/-secondary/-more` (+ `@container`),
  `.voice-connected-pulse`, `.hover-action-btn`, the phone sidebar-size block, `.context-panel-overlay > *`.
- `primitives.css`: `.pc-coach`, `.pc-identity-mark`, `.pc-message-row`, `.pc-window.is-large`,
  `.pc-thumb-glow`, `.pc-live-dot.is-speaking`, `.pc-speaking-face`, `.pc-sheet-in/-out` (+ keyframes),
  `.pc-search-sheet-in`, `.pc-hover-in` (+ keyframes).
- `layout.css`: `color-scheme` for the retired light/AMOLED/high-contrast themes; `.topbar-overlay-backdrop`.
- `server-home.css`: every `pc-home-*` except `pc-home-enter` (+ its orphaned motion-lint allowance).
- `glass-layout.css`: `.glass-conversation__heading`, `__places-toggle`, the "Phone (… until WP-G20)" block.
- `glass-phone.css`: the header drawer-button chevron mask (the stopgap), the stage overlay hide rule.
- `glass-conversation.css`: the phone pill's 8px padding (now 0 12px, as `glass-phone.css` had it).
- `glass-stage.css`: the phone overlay rules; `glass-pages.css`: `.glass-dmstream`.
- `utilities.css`: `.voice-connected-pulse` reduced-motion rule. `tokens.css`: `--h-mobile-nav`,
  `.workspace-canvas`, `.workspace-stage`.

Added CSS (tokens only): the call view, the stage-channel panel, the mic check, the share-quality and
stream-sound popovers (`glass-stage.css`), the phone call card (`glass-phone.css`), the phone back button
without a glass edge (`glass-conversation.css`).

## 7. Other G22 items from the checkpoints

- Phone header: `ConversationHeader` renders `<PlacesToggle>` ("Back to places") for channels and DMs; the
  drawer button, "Back to messages", `useNavigate` and the `sidebarCollapsed` subscription are gone.
- `Stage.tsx`'s phone overlay branches are gone (`PhoneStageChrome` is the phone's chrome).
- `useGlassKeybinds`: the phone C guard is gone (the card has a Clip button).
- Stale comments naming StreamViewer, VoiceControlBar or the Lantern spec: nativeUnderlay, streamOverlayPortal,
  the engines, voiceStore, motion-lint and the literal-color audit (now cite `glass-spec.md`).
- e2e: `dm-attachment-confidentiality` and `production-messaging` no longer expect "Skip tour";
  `glass-longtail` no longer mounts the deleted ChannelSwitcher; `glass-stage`'s "conversation keeps working"
  case now measures after the move settles (it measured mid-move since G15; G20 noted it).
- Live scene driver (`scripts/glass-scene`): `ui.mjs` and `call.mjs` drive the Glass controls (pill Join,
  Show the call / Watch, Camera and Share on the stage, the pill's Microphone), `03-listen` is now shot
  through the pill (it was "pending"), and the cast unmutes unless the scene wants them muted (the pill
  joins muted by default).
- The mocked review harness (`e2e/glass-review.spec.ts`) now drives 03–07 through the pill and the stage
  with the shared fakes in `e2e/fixtures/glass/calls.ts` (it used to navigate to routes and shoot whatever
  was there).
- `e2e/smoke.spec.ts` rewritten for Glass (16 cases, run with and without touch; fixture in
  `e2e/fixtures/smokeApp.ts`): sign-in and contract validation, widths, routes, header menus and sheets,
  attention, DM headers, every G11 composer check, the voice route with its pill (not joined, a refused
  join, joined with "Show the call", Watch), Overview and Home. Lantern-only assertions are gone.
- `e2e/motion-gate.spec.ts` rewritten for the Glass moments (14 cases): the 120ms hover step, the pill's
  550ms expand, pill to stage and back (650ms), theater, browse, the 1.2s room crossfade, the phone slide,
  the shared-element paths, and reduced motion (150ms crossfades, nothing loops). Durations are read from
  the running app and held to the packages' constants. `design-review.spec.ts` and its project are gone.
- The real-server specs (`real-server*.spec.ts`) moved to the Glass controls: join, leave, roster, camera,
  share and watch through the pill and the stage, the connection check from Settings and from the stage's
  More (a new case), the account menu instead of the account plate.
- `glass/sheets/sheetStore.ts`: closing a sheet whose trigger is inside a menu that is still playing its
  exit (inert) now falls back to the header's button instead of leaving focus on the body (found by the
  smoke rewrite).
- Docs: `lantern-stage-spec.md`, `design-spec.md`, `layout-spec.md` (in part), `server-home-spec.md` (in
  part) and `wp9-summary.md` are marked as history; `docs/design/glass-summary.md` summarizes Glass.

## 8. Verification

Run in `~/Documents/Paracord-glass/client` on the final tree.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 405 files, 4,129 tests (baseline before G22: 422 files, 4,295; the difference is the deleted Lantern components' tests, net of the new ones) |
| `npm run test:tokens` | pass (794 files) |
| `npm run test:motion-lint` | pass (2 named allowances; the orphaned server-home one is gone) |
| `npm run lint` | 0 errors, 214 warnings (253 when Glass started; none of the warnings is in a file this package wrote) |
| `npm run test:contrast` | pass |
| `npm run test:a11y:static` | pass |
| `npm run build` | pass |
| `npm run test:e2e` (default: encrypted-storage, smoke, auth-fit, smoke with touch) | 122 of 122 (three clean runs by the e2e agent, one by me) |
| `PARACORD_E2E_MOTION=1 npx playwright test` (the Glass motion gate, 14 cases) | 14 of 14 (one earlier run had one case pass on its retry; the project allows 2 retries and reports them) |
| `PARACORD_E2E_REAL=1 npx playwright test` (real server, voice join included) | 17 of 17, three runs (`PARACORD_E2E_MEDIA_PORT=18152`: UDP 8443 is taken by the owner's own server on this box) |
| `PARACORD_E2E_GLASS=1 npx playwright test e2e/glass-review.spec.ts` | 15 of 15; all seven states driven through the pill and the stage |
| `glass-stage` / `glass-theater` / `glass-pill` / `glass-sheets` | 8/8, 9/9, 12/12, 14/14 (the two mid-move measurements G20 reported now wait for the move to settle) |
| `glass-pages` / `glass-phone` / `glass-longtail` / `glass-room` | 25/25, 27/27, 18/18 (the ChannelSwitcher case is gone), 6/6 |
| `glass-calls` (new, ports 4463/4465) | 6 of 6 |

New mocked spec `e2e/glass-calls.spec.ts` (+ config): a voice channel opened from places is its chat with
its pill (desktop and phone), a live channel's pill in its chat, "Show the call" joined with no stream
(desktop, phone card and full screen, More), and a DM call on the stage. Shots in
`output/design-reference/glass-build/g22/calls-*.png`, all read.

### Live (the embedded build, a real relay)

- `npm run build`, `touch crates/paracord-server/src/embedded_ui.rs`,
  `pc-cargo.sh build --release --bin paracord-server`; the served `assets/index-CAD2bXTu.js` matched
  `client/dist`. `live-env.mjs --port 18760` with its data in the scratchpad.
- `glass-scene.mjs --shot all`: all seven states shot through real controls, `03-listen` included (it was
  pending before). The cast now joins through the pill and turns camera and share on from the stage; the
  holder reports "Vincent (streaming), Brendan (camera, talking), Nick (muted)" from the server's own voice
  states. Shots in `output/design-reference/glass-build/g22/live-scene/`, all read.
- `clip-live.mjs` against the held scene: **59 of 59**, the not-joined clip's stream audio now a PASS
  (Opus, 1,536 packets, mean -12.2 dB, decoded by Chromium).
- A scratch driver (`calls-live.mjs`, in the session scratchpad; not in the repo) through the app's
  controls, **12 of 13**:
  - DM call (Sean and Jeremy): started from the header, the pill carries it ("Jeremy, voice call", no
    Listen), "Show the call" on both sides, Jeremy's camera on from his stage, Close keeps the call, Leave
    ends it, no page errors. **FAIL:** Sean's stage never shows Jeremy's camera: the server drops voice
    state updates in DMs (§4.2).
  - DM screen share: no Share button on the DM stage; the server answers `400 Not a voice channel` to both
    the stream and the view (§4.1), recorded in `live-calls/dm-stream-refusal.json`.
  - A voice channel made for the run ("Campfire"), opened from the places panel: its chat, composer and the
    pill with "Join Campfire"; Join, "Show the call" (stage says "Just you"), Leave from the stage.
  - The live Lounge row: the Lounge's chat beside Vincent's stream.
  - A stage channel ("Town hall", owner Eric): Eric opens it with a topic and joins; Sean joins as the
    audience, presses Request to speak ("Request sent"); Eric sees "One person wants to speak" and presses
    Let them speak; Sean's stage row gets its Microphone.
  - Shots in `output/design-reference/glass-build/g22/live-calls/`, all read.
- Everything I started was stopped: the scene holder (SIGINT, it leaves the call), live-env and its server,
  the Playwright servers. The owner's own `paracord-server` (pid 1203) was not touched.

## 9. Left for others

- **Server (owner decision):** DM screen share and DM voice state updates (§4). The client is ready for
  both.
- **`uiStore.contextPanelMode`** is still the request channel the sheets answer (CommandPalette, Mod+F,
  ServerHome, the Escape precedence); moving the callers to `toggleSheet` / `openChannelSheet` and removing
  the field is a refactor, not a retirement.
- **The frame swap at 768px** (`GlassFrame` ↔ `PhoneFrame`) remounts the conversation, so a dialog held in a
  component's local state (the message edit history) closes when a window is resized across it (found by
  the real-server spec).
- **Two buttons named "Watch …'s screen"** in an expanded pill (the bar's Watch and the preview,
  `pill/PillPreview.tsx`): a screen reader hears it twice.
- **Stage moves drop frames** under the motion gate (45–90ms frames around the 650ms move, 65–134ms on
  the commit frame of Watch; the gate allows them by name, `KNOWN.stageMoves`): message rows and the
  message box re-render during the move. For WP-G23 with the WebKitGTK measurements.
- **Cameras before joining**: a watch carries one stream, so camera tiles show faces until you join (G14
  difference 4, unchanged).
- **The call view without cameras** says "Nobody has a camera on." over an empty pane with the chips at the
  end. It works, but it is a design nobody has reviewed; the owner may want a different empty state.
- **The live scene driver** now has no "Try joining again" to detect a refused join; it reports the pill's
  toast text when the join times out.
- `FilePreview.tsx` (an encrypted attachment's preview) still wears Lantern classes around `MediaPreview`
  (G13); `BuildingNotFound` still uses the Lantern plate recipe; `DesignTokensPage` still showcases the
  `pc-window` / `pc-live-dot` primitives, which keeps their CSS alive.
- `calls-live.mjs` lives in the scratchpad; if it should be kept, it belongs in
  `client/scripts/glass-scene/` beside `clip-live.mjs`.
