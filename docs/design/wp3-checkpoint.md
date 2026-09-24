# WP3 — The Stage: the channel you are in

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §7.2, §7.7, §5,
§6, §8, §9. Depends on [WP0](./wp0-checkpoint.md) and [WP1](./wp1-checkpoint.md).
Branch: `design/lantern-stage`.

Everything here is checkable in one place: run the client and open
**`/design-stage`** (dev builds only). It renders the real Stage components from
fixture models at full size — `?state=share|speakers|joining|reconnecting`, plus
`&phone=1` for the 390×844 arrangement. If that page looks wrong, the Stage is
wrong, because it *is* the Stage.

---

## 1. Where things live

| File | Role |
|---|---|
| `client/src/components/voice/stage/StageTile.tsx` | One tile: 12px-radius well, name tag bottom-left, transport readout top-right, speaking ring, camera-off initials. |
| `client/src/components/voice/stage/SpeakerGrid.tsx` | The tile layout rules — equal columns in the strip, the old VideoGrid column rules in the speakers-only grid, two columns on a phone. |
| `client/src/components/voice/stage/StageHeader.tsx` | Channel name, "Kestrel · 34:12", the here-now slot, Invite / Layout / more. |
| `client/src/components/voice/stage/StageControlBar.tsx` | The centred control row (46px desktop, 50px phone). |
| `client/src/components/voice/stage/StageLayout.tsx` | The whole in-call surface: plate + ribbon on desktop, share → 2×2 → controls → sheet on a phone. |
| `client/src/components/voice/stage/RoomChatRibbon.tsx` | The 336px plate, and its phone sheet with the handle. |
| `client/src/components/voice/stage/StageStatus.tsx` | The words for a call that is not a channel yet — `StageStatus` (fills the tile) and `StageNotice` (one line above it). |
| `client/src/components/voice/stage/transportReadout.ts` | What the tile's top-right corner may honestly say. |
| `client/src/components/voice/CameraSurface.tsx` | The camera attach/subscribe logic, moved verbatim out of the two places that had a copy each. |
| `client/src/components/voice/StageSpeakers.tsx` | The container: one tile per person **in the channel**, frames from `useWebcamTiles`. |
| `client/src/components/voice/OnAirDock.tsx` | WP1's `OnAirPill`, wired to the route back to the Stage. |
| `client/src/pages/guild/VoiceStageChannel.tsx` | The route: every store read, every media effect, composing `StageLayout`. |
| `client/src/pages/guild/RoomChat.tsx` | The ribbon's contents — the text channel's own list and composer, in their ribbon variant. |
| `client/src/pages/guild/VoiceLobby.tsx` | The channel you are not in yet, restyled to the plate/well system. |
| `client/src/pages/StagePreviewPage.tsx` | `/design-stage`, behind `import.meta.env.DEV`. |

Nothing in `components/voice/stage/` reads a store. The containers
(`StageSpeakers`, `OnAirDock`, `RoomChat`) and the route are the only join.

---

## 2. Component map, old → new

| Was | Now |
|---|---|
| `components/voice/VideoGrid.tsx` (+ test) — one tile per **camera**, four ad-hoc layouts, its own attach logic and its own chrome | **Deleted.** Split into `CameraSurface` (the attach logic), `StageTile` (the chrome), `SpeakerGrid` (the layout rules) and `StageSpeakers` (the container). The strip now shows one tile per **person in the channel**, because a channel with four people and one camera is four tiles, not one. |
| `components/voice/MiniVoiceBar.tsx` (+ test) — a second control bar in the app chrome | **Deleted.** `components/voice/OnAirDock.tsx` renders WP1's `OnAirPill`: white dot, channel name, mono duration, mic state, one action (§7.7). Call sites updated: `components/layout/sidebar/CallDock.tsx`, `pages/AppShell.tsx` (and the two tests that stubbed it). |
| `pages/guild/VoiceChatSidebar.tsx` — a 460px slide-over with its own header | **Deleted.** `pages/guild/RoomChat.tsx` + `RoomChatRibbon`: the 336px plate beside the Stage, or the phone sheet. |
| `components/voice/FocusedWebcamView.tsx` — duplicated VideoGrid's attach logic | Rewritten as `StageTile` + `CameraSurface`. Same props, same behavior. |
| `components/voice/VoiceControlBar.tsx` — an absolutely-positioned floating bar of 44px controls | Laid out in flow by the Stage, on `StageControlBar` + `IconButton size="stage"`: mic-on is **white light**, leave is danger. Every aria-label, tooltip, menu and the whole screen-share flow are unchanged. |
| `components/voice/StreamViewer.tsx` — a red "LIVE" badge and a black gradient wash across the top of the frame | Chrome restyled onto the tile recipe: `LiveDot` + name tag bottom-left, transport readout top-right, hover controls on the tag fill in the same corner (so nothing shifts), poster states left-aligned in the metaphor. **The media path is untouched** — the underlay hole-punch, the WebGL canvas, the subscription bookkeeping and the native-surface boundary are all byte-identical. |
| `components/voice/SplitPane.tsx`, `SplitPaneSourcePicker.tsx`, `InCallDeviceMenu.tsx` | Restyled to tokens (floating recipe, tag fill, stage control height). Behavior untouched. |
| `pages/guild/VoiceLobby.tsx` | Restyled to a plate; the Join button is **white light when somebody is in there** and emerald when the channel is dark; the gradient avatar ring is gone (§6.2). |
| `pages/GuildPage.tsx` | The app's `TopBar` is suppressed for voice/stage channels — the Stage plate carries its own header (§7.2), and two titles for one channel is a defect. Every other channel type keeps it. |

**Deleted files:** `VideoGrid.tsx`, `VideoGrid.test.tsx`, `MiniVoiceBar.tsx`,
`MiniVoiceBar.test.tsx`, `VoiceChatSidebar.tsx`.

---

## 3. The Stage, region by region (§7.2)

- **Header** — channel name in Gabarito at the title step, `Kestrel · 34:12` in meta
  with the duration in the mono face, WP1's `HereNowStrip` ("4 here · 20 lights
  on"), then Invite / Layout / more. The name, the duration and the strip all
  come from the channel's light (`useBuildingLight` → the channel, `useHereNow`) —
  **nothing is re-derived** (WP1 §9, rule 1). On a phone the header stacks, folds
  "4 here" into the meta line, keeps three faces, and gains a back affordance.
- **Dominant tile** — the watched screen share (`StreamViewer`), the split panes,
  or nothing. With nothing dominant the speakers spread into the speakers-only
  grid, which keeps the old VideoGrid column rules (1 / 2 / 2×2 / 3-across).
- **Speaker strip** — 128px, equal columns, one tile per occupant, ordered by
  `RoomLight` (speakers → sharers → name), so it does not reshuffle on a tick.
  A camera that is off is the person's initials on a dark tile (§6.4); a muted
  tag says "· muted"; a speaking tile breathes and says "· speaking".
  Somebody sharing who is not already on the dominant tile carries a **Watch**
  action — this is where the old "Pick a stream to watch" list went.
- **Control bar** — centred, in flow: mic (white light when the channel can hear
  you), the device menu behind its chevron, headphones, camera, the screen-share
  split control, the chat toggle, and leave in the danger well at 64px (72 on a
  phone).
- **Chat ribbon** — the channel's own text channel, 336px, open by default on
  desktop (§7.2 draws it as part of the Stage) and still toggleable from the
  control bar. On a phone it is the sheet under the controls, with a handle that
  collapses it.
- **Reconnecting** is a one-line notice **above** the tiles, not a replacement
  for them: unmounting a live share to say "reconnecting" would tear its
  subscriptions down and rebuild them for a blip the transport is already
  handling.

### Copy

Every not-yet-a-channel state names the channel and says one true thing —
"Joining Shop floor", "Reconnecting to Shop floor · 3 s", "Leaving Shop floor",
"Couldn't reach Shop floor". A test asserts that none of the strings contains
"warming up", "connecting…", "please wait", "loading" or "no data".

---

## 4. Additive props on WP5-owned components

Two components, four props, all optional and all presentation-only. Each is
commented at the declaration with the spec section that asks for it.

| Component | Prop | What it does |
|---|---|---|
| `components/message/MessageList.tsx` | `variant?: 'default' \| 'ribbon'` | 28px `LitAvatar`s, tighter rows, the 14/1.45 ribbon body step. Nothing about what is fetched, rendered or announced changes. |
| | `inRoomUserIds?: ReadonlySet<string>` | Messages written by somebody **in the channel right now** get the raised "from the channel" background. The set comes from WP1's `useHereNow`; the list never works out who is present. |
| `components/message/MessageInput.tsx` | `variant?: 'default' \| 'ribbon'` | 42px composer on the well recipe, "Say something to the channel", and the send button in **white light** — everybody it reaches is in the channel. |

The ribbon reuses the real list and the real composer; nothing is forked.

`components/message/*` (ribbon variant) is WP3's in the spec's §10 table, and
`RoomChat.tsx` cannot type-check without these props, so the two files are in
this commit — which means they also carry **WP5's in-flight restyle of those
files**, mid-flight at the time of writing. That work is theirs, not WP3's, and
their own commit supersedes it; the WP3 change in each file is exactly the block
marked `WP3 (spec §7.2)`.

---

## 5. The transport readout, and the one place the reference could not be met

The artboard draws **"12 ms · QUIC"** in the dominant tile's top-right corner.
The transport half is real and is rendered: the desktop/browser media engine
carries media over QUIC (WebTransport); the LiveKit path carries it over WebRTC.

**There is no round-trip figure on either path.** `MediaEngine`
(`src/lib/media/mediaEngine.ts`) exposes capabilities, published tracks and
subscriptions but no RTT; LiveKit reports a coarse `ConnectionQuality`, not a
latency. The media engines are off limits to this package, and printing a
plausible number would be exactly the silent degradation the project forbids —
so `transportReadout()` prints what the client can observe and nothing else, and
draws no readout at all when it knows nothing. `latencyMs` is already a parameter
with a test, so the day an engine reports a real RTT the corner fills in and
every Stage improves at once.

Two smaller honesty calls, for the same reason:

- **No "CAM · 720p" badge** on a speaker tile. The client is not told a remote
  publisher's capture resolution.
- The ribbon's send button is **white light**, where the artboard drew the
  emerald. §8 allows both and names the Stage ribbon as the white-light case.

---

## 6. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | no WP3 findings |
| `npx eslint src --quiet` | pass, 0 findings |
| `npx vitest run` (WP3's files) | **17 files, 160 tests passed**, including 33 new ones |
| `npm run build` | pass; `/design-stage` and its fixtures absent from `dist/` |
| `npm run test:contrast` | 49 checks × 4 themes passed |
| `npm run test:a11y:static` | no `components/voice/**` or `pages/guild/**` finding |
| `npx playwright test` (mocked smoke) | the voice leg passes |

WP3's own tests:

- `components/voice/stage/stage.test.tsx` — every tile state (camera off, the
  initials fallback, speaking, muted, readout, badge), the column rules, the
  header, the ribbon in both surfaces, the layout's rows, the status copy
  (including the banned-filler assertion), the transport readout, and the
  no-literal-color assertion WP0 established.
- `components/voice/StageSpeakers.test.tsx` — the camera derivation the deleted
  `VideoGrid.test.tsx` used to cover, moved and kept whole: a screenshare-only
  publisher gets no video surface, muted and ended camera tracks are excluded, an
  unsubscribed remote camera is subscribed, the local tile is "You", and the
  Watch action appears only on a sharer who is not already dominant.

### Not WP3 — the tree is shared

At the time of writing, `npx vitest run` reports 12 failing files, all in
`components/layout/TopBar.*`, `components/message/*` and `pages/DMPage` — WP5's
surfaces, mid-restyle (their new `messageLight.ts` is not yet in those specs'
mocks, and their composer copy moved past `smoke.spec.ts`'s expectation). The
static a11y audit's two findings are in `components/home/HomeAddBuilding.tsx`
(WP6) and `components/message/TimelineParts.tsx` (WP5). None of them touch a WP3
file, and every WP3 file passes on its own.

One fix outside WP3's files, because it was a broken class on WP3's surface:
`components/light/HereNowStrip.tsx` painted `text-text-text-body`, which is not a
utility (the token is `--color-text-body`, so the class is `text-text-body`), and
the strip inherited its parent's ink. **Three more instances survive in
`pages/DesignTokensPage.tsx`** — WP8's sweep.

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp3 npx playwright test e2e/design-review.spec.ts
# → output/design-reference/wp3/ (gitignored)
```

Ten frames: `stage-{share,speakers,joining,reconnecting}` and `stage-lobby`, each
at **1440×900 and 390×844**. All inspected against
`output/design-reference/{Main,Phone}.png`. Four things they caught and fixed:

1. **The phone's 2×2 collapsed to a hairline.** The speaker grid divided a
   flexible row that the fixed-height share had already eaten. The phone strip
   now carries its own 96px rows, as `Phone.html` draws them.
2. **The joining Stage overflowed its plate.** The speakers were arranged as the
   speakers-only *grid* (16:9 tiles, two rows) inside the 128px strip row,
   because the arrangement keyed on "is somebody sharing" rather than "is there a
   dominant tile at all". It now keys on the latter.
3. **The Stage plate was invisible on the real route.** `AppShell`'s main pane
   still paints `--bg-primary`, which WP0 aliases to `--bg-plate`, so a plate on
   it had no edge. The voice route paints the street (`--bg-base`) behind its
   plates, as the reference does.
4. **The phone header lost the people.** `Phone.html` keeps three lit faces at
   the top-right and folds "4 here" into the meta line; the compact header now
   takes an avatar stack and a `hereCaption`.

Checked against the renders: the 22px Gabarito channel name and the mono duration,
the here-now well, the 12px tile radius and the 12px gutters, the 128px strip,
the 46px controls on the 13px radius with the mic in white light, the 64px danger
leave, the 336px ribbon with 28px avatars and the raised "from the channel" message,
and the 42px composer with the white-light send.

---

## 7. Left for later

- **A real latency.** §5 above. `transportReadout({ latencyMs })` is the seam.
- **Camera badges.** "CAM · 720p" needs a publisher-resolution signal the client
  does not receive.
- **Stage moderation.** The topic and open/end controls stay in the pre-join
  Lobby, where they already lived; in-call, a moderator gets the raised
  "N people want to speak" row above the tiles. A fuller in-call stage console is
  a product decision, not a restyle.
- **`components/layout/VoiceParticipants.tsx`** still renders a participant list
  in the old vocabulary. It is layout-owned and unused by the Stage; WP8's sweep.
- **The three remaining `text-text-text-body` classes** in
  `pages/DesignTokensPage.tsx` (§6).
