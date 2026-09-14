# WP1 — Light primitives: the vocabulary and the data that drives it

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §1.2, §1.5, §3,
§5, §7.1 (data), §8, §9. Depends on [WP0](./wp0-checkpoint.md). Branch:
`design/lantern-stage`.

Everything here is checkable in one place: run the client and open
**`/design-tokens` → "Light components"** (dev builds only). Every component, in
every state, is rendered from real models — not from hand-written props — so if a
state looks wrong on that page, the model is wrong, not the component.

---

## 1. Where things live

| File | Role |
|---|---|
| `client/src/lib/attention/lightModel.ts` | The three models as types: `RoomLight`, `PersonLight`, `BuildingLight` (+ `RoomThumbnailState`, `BuildingWindow`). Pure types, no logic. |
| `client/src/lib/attention/lightCaptions.ts` | Every string that goes with a light. One place, so two surfaces can never word a count differently. |
| `client/src/lib/attention/personLight.ts` | Presence + voice → a person's light. Builds on WP0's `lib/presence.ts`. |
| `client/src/lib/attention/roomLight.ts` | Voice and text channels → light. **Carries the exact definition of "reading"** (§3 below). |
| `client/src/lib/attention/buildingLight.ts` | Window map, counts, brightest-first ordering, the "Around now" sentence. |
| `client/src/lib/attention/litHistory.ts` | What this client has itself observed: when a channel lit up, when it was last lit. |
| `client/src/lib/attention/guildLight.ts` | The seam: raw store shapes → one `BuildingLight`. Pure and injectable. |
| `client/src/lib/attention/light.ts` | One import for every later package. |
| `client/src/lib/media/roomFrameTap.ts` | The read-only ≤ 2 fps tap on the media pipeline, and the honest live/still table. |
| `client/src/hooks/useLights.ts` | The only place the stores are read for light. Memoized, account-scoped. |
| `client/src/hooks/useRoomThumbnail.ts` | Wires one channel's thumbnail to the tap. |
| `client/src/components/light/` | The components + `index.ts` barrel. |
| `client/src/pages/DesignTokensPage.tsx` | The `Light components` section. |
| `client/e2e/design-review.spec.ts` | `PARACORD_E2E_DESIGN_WP=wp1` capture path. |

Nothing in `lib/attention/` imports a store or React. Nothing in
`components/light/` reads a store. The hooks are the only join.

---

## 2. The data models

### `PersonLight` — a person is a rim

```
level: 'on' | 'dim' | 'off'      lit, dim, dnd, speaking, live
roomName, avatar, avatarClass, label
```

`on` = presence `online` or `streaming`; `dim` = `idle` or `dnd`; `off` =
everything else. `dnd` additionally carries the danger slash (§1.5).

**`speaking` only survives when their lights are on and they are in a channel.** A
breathing rim asserts that somebody is talking *right now*, so a stale speaking
flag on somebody who has left can never paint one.

`label` is the DOM text equivalent — "Lights on", "Away", "In Shop floor",
"Speaking in Shop floor", "Do not disturb", "Lights off". §9 says light is never
the only cue, so every component renders it.

`countLightsOn()` gives the "24 in" number. `mergePersonLights()` merges the
same human seen through two connected servers, brightest observation winning —
it takes the identity key as a parameter, because two servers' user ids are not
the same person and WP1 does not pretend otherwise.

### `RoomLight` — a channel is a window

```
key (entityScopeKey), scope, guildId, channelId, name, order
kind: 'voice' | 'text'      level: 'dark' | 'white' | 'amber'      lit
voice:  occupants[], talkingCount, screenSharer, cameraSharer, durationMs, youAreHere
text:   readers[], readingCount
lastLitMs, caption, thumbnail
```

- **Voice occupancy is exact.** The gateway sends every `VOICE_STATE_UPDATE`;
  nothing is approximated. Occupants are ordered speakers → sharers → `order` →
  name, so an avatar stack does not reshuffle on every tick.
- **Text occupancy is derived** — see §3.
- `order` is the channel's own `position`. Equally-lit channels keep the order the
  server's people gave them rather than falling back to the alphabet.
- `durationMs` and `lastLitMs` come from `litHistory` (§5).
- `caption` is the short form — "3 talking", "5 reading", "you're here",
  "Dark · nobody in". `roomCaptionFor(room, { surface })` in
  `components/light/LightCaption.tsx` adds the surface-specific wording the
  contract spells two ways ("Dark · nobody in" in a sidebar row, §7.1; "Dark ·
  nobody's in" on a Lobby card, §6.9/§7.3) plus the optional "last lit 2 h ago".

### `BuildingLight` — a server is a window map

```
key, scope, guildId, name, icon
windows[] (≤ 2 rows of 8), overflowCount
rooms[], brightestRoom
roomsLit, talkingCount, readingCount, lightsOn, memberCount
brightness, caption
```

- **Window order** (§3): voice channels first (lit before dark, more people before
  fewer), then text channels by reader count; ties on `order` then name.
- **At most `MAX_WINDOWS` = 16 windows.** Channels past the sixteenth do not get a
  cell — they collapse into `overflowCount` and the caption. A window map that
  scrolls is a chart, not a server.
- **`brightness`** ranks talking > channels lit > reading > lights on, so
  `orderBuildingsByBrightness()` puts the loudest server first (§7.1, §7.5).
  The scale is arbitrary; the *order* is the contract and the tests assert it.
- **`caption`** is "2 channels lit · 3 reading" / "1 reading" / "Dark · nobody in".
- **`brightestRoom`** is the lit voice channel whose thumbnail the server should
  show (live frames first, then talkers, then occupants).

### "Around now"

`aroundNowSentence({ rooms, people, maxClauses, empty })` →

> Mara, Priya and Ren are in Shop floor · Aisha and Tomas are reading build-log · Devon is away

Voice clauses first (loudest first), then reading clauses, then at most one
"away" clause naming people who are **not** in any channel. Names inside a clause
are alphabetical so the sentence is stable between ticks instead of reshuffling
with the typing order. Clauses past `maxClauses` are dropped — the window map is
what carries the rest. With nothing lit it says "Nobody's lights are on right
now", never "No data".

---

## 3. The exact definition of "reading" (read this before changing it)

The server has **no "viewing channel" signal**, and WP1 does not invent one.
Amber light is derived from signals the client already receives, and it is
deliberately conservative: **presence alone is never enough**, because "has the
app open somewhere" is not "is in this channel".

A member `m` is reading text channel `c` at time `t` when:

1. `m` has their lights on — presence is `online` or `streaming` (`idle`, `dnd`
   and `offline` can never read); **and**
2. at least one channel-bound signal for `m` in `c` is fresh at `t`:

   | Term | Source | Freshness |
   |---|---|---|
   | **typing** | `typingStore.typingByChannel[c]` contains `m` | the store expires an entry 8 s after the last `TYPING_START`, and the server re-emits while a composer is active |
   | **authored** | `m` wrote one of the last `RECENT_AUTHOR_LIMIT` (40) messages in `c` | the message snowflake is younger than `READING_WINDOW_MS` (5 min) |
   | **viewing** (self only) | `m` is the local account, this client has `c` selected, and `document.visibilityState !== 'hidden'` | live |

Consequences, stated so no surface over-claims:

- **A silent lurker is not counted.** The count is "people the channel can tell are
  here", not "people looking at it".
- **The count is a floor, never an overestimate** — the right direction for a
  number that means "say something to these people".
- The **authored** term only contributes for channels whose timeline this client
  has loaded. An unopened channel contributes nothing rather than a guess. In
  practice that means the *active* account's open timelines: message stores are
  per account (`getMessageStore`) and React hooks cannot be looped over scopes,
  so `useLights` feeds the current account's map and an empty map to background
  accounts. Typing and self-viewing still apply everywhere.
- The **viewing** term exists only for the local account. There is no equivalent
  for anybody else and none is faked.
- If the server ever gains a real channel-presence event it becomes term (d) and
  every caller improves at once — nothing else has to change.

`readersOf()` reports the strongest observed signal per person
(`typing` > `viewing` > `authored`) and orders by it, then by name.

---

## 4. Channel thumbnails: what is live and what is a still

`client/src/lib/media/roomFrameTap.ts`. **The tap adds nothing to the delivery
path.** It calls the engine's existing public `MediaEngine.subscribeVideo` with
its own offscreen canvas, samples that canvas on a timer, and never touches the
decoder, the transport, the relay, or the tile the Stage renders. §5's ceiling
(`MAX_THUMBNAIL_FPS = 2`) is enforced in the tap, not by the caller.

| Situation | Thumbnail | `RoomThumbnailState.reason` |
|---|---|---|
| Channel you are **in**, publisher's frames land in a DOM canvas | **live, ≤ 2 fps** | `null` |
| Channel you are in, platform composites **below** the webview (Linux GTK underlay) | still + LIVE dot | `native-surface` |
| Channel you are in, nobody is publishing video | still | `no-publisher` |
| Channel you are **not** in | still + LIVE dot | `not-joined` |
| No media engine at all (idle, or the LiveKit path) | still | `no-engine` |

The two "still + LIVE" rows are **not a degraded video path — they are the
absence of one**:

- A channel you have not joined has **no decoder running for it anywhere on this
  device**. Frames for it do not exist to be sampled, and opening a second media
  session behind the user's back to make a thumbnail move would be a real
  session, not a preview.
- On the Linux GTK underlay the frames exist but are composited *below* the
  webview (see the `native-streaming-pipeline` notes): the DOM canvas is a
  deliberate transparent hole with nothing to read back. `nativeRenderUnderlay`
  in `MediaStreamCapabilities` is the capability that says so.

Every non-live state is **named** in the model, so nothing silently degrades.
`RoomThumbnail` paints a frame only when `room.thumbnail.live` is true; a frame
handed to it for a still channel is ignored (asserted in the tests).

Ownership: the tap hands each `ImageBitmap` to its caller.
`useRoomThumbnail` holds exactly one at a time and closes the previous one on
replace and on unmount, so a 2 fps feed cannot accumulate frames. A frame that
resolves after unsubscribe is closed, never delivered.

---

## 5. `litHistory` — the only new mutable state

Neither the call start time nor "when did this channel last empty" is on the wire.
Rather than invent a server field, the client remembers what it has **observed
itself** (`client/src/lib/attention/litHistory.ts`, one process-wide instance
registered with `registerSessionReset` so it clears on logout):

- `litSinceMs` is "since this client first saw the channel lit", so a duration is a
  lower bound on a call that was already running — never an over-claim.
- `lastLitMs` is `null` until this client has actually seen the channel lit, so an
  unseen channel reads "never lit", not a fabricated hour.
- Capped at 2 000 channels, least-recently-touched evicted; losing an entry costs
  only a "last lit" label.

No store shape changed in WP1. Everything else is derived.

---

## 6. The selectors (`src/hooks/useLights.ts`)

| Hook | Returns |
|---|---|
| `useBuildingLight(guildId)` | one `BuildingLight`, or null |
| `useRoomLights(guildId)` / `useRoomLight(guildId, channelId)` | its channels / one channel |
| `useBuildingPeople(guildId)` | the people the server's channels know about |
| `useBuildingLights()` | every server on every connected instance, brightest first |
| `useLightsOnAcrossBuildings(buildings)` | the "+17 lights on" number |
| `useAroundNow(buildings, maxClauses?, empty?)` | the one-sentence summary |
| `useHereNow(guildId, channelId)` | `{ people, here, lightsOn, caption }` for the strip |
| `useOnAir()` | the on-air pill's model, or null when you are not in a channel |
| `useRoomThumbnail(room)` | `{ state, frame }` (in `useRoomThumbnail.ts`) |
| `useLightClock(active)` / `useWindowIsVisible()` | the 1 Hz duration clock; the self-viewing term |

Three rules they keep:

1. **Account-scoped, always.** Every key is `entityScopeKey(scope, id)` and every
   presence lookup passes the owning `serverId` as the presence scope, following
   `client/src/lib/messages/README.md` and the existing scope helpers. Voice
   states are matched on `guild_id`, so two servers minting the same channel id
   can never bleed light into each other (the same collision `hasVoiceOccupancy`
   guards in `useUnifiedConversations`).
2. **Memoized on the narrowest slice.** `useLightSources` subscribes once and
   returns one stable object; a guild-scoped hook takes only that guild's
   channel/member slices. `useBuildingLights` is the one place that pays for the
   cross-server sweep, and it reuses the same pure builder (`guildLight`) as the
   per-guild hook — so a server can never look different on Home than it does
   in the sidebar.
3. **No store shape changes.** Additive only: one new module-level record
   (`litHistory`) and one new session-reset registration.

`useBuildingLights` merges across connected servers through the existing
`useAvailableGuilds` / `channelsByGuild` / per-account `memberStore` layer — the
same account-availability rules as `useUnifiedConversations`.

---

## 7. The components (`src/components/light/`)

Presentational only. No store reads, no product decisions. Every state renders
its text equivalent in the DOM (§9). **All motion lives in
`src/styles/primitives.css`**, where `prefers-reduced-motion` is handled once
(§5): warm-up 220 ms ease-out (`--duration-warm-up`), dim 400 ms ease-in
(`--duration-dim`, via `pc-dimming`), speaking breathe ~1.6 s between the two
ring alphas (`--duration-breathe`), all instant / stopped at ring .7 under
reduced motion. There is **no motion code in any WP1 component.**

| Component | Props | Notes |
|---|---|---|
| `LitAvatar` | `person`, `size` (px), `hideLabel` | rim / breathe / dim / dnd slash; avatar image or identity-coloured initials (`avatarInitials`). Renders `"{name} — {label}"` as `sr-only` unless `hideLabel`. |
| `AvatarStack` | `people`, `size`, `max`, `overlap`, `context` | overlap defaults to `size / 4`; "+M" tail; names everybody **once** in one `sr-only` sentence instead of N labels. |
| `WindowMap` | `windows`, `overflowCount`, `caption`, `scale` (`sidebar` 10×13 / `home` 12×16), `columns` (capped at 8) | cells are `pc-window` + `is-talking` / `is-reading`; one `sr-only` sentence ("2 of 13 channels lit, 4 more not shown. 2 channels lit · 2 reading"). |
| `BuildingPlate` | `building`, `scale`, `caption`, `children` | Plate + `Lamp` + `WindowMap`. Lit ⇒ the lit ring and **exactly one** lamp; dark ⇒ neither, and it drops to the quiet tile highlight rather than a plate shadow it has not earned. |
| `RoomThumbnail` | `room`, `height` (64 / 168 / 176), `frame`, `still`, `showOccupants`, `action` | `--radius-thumb` well; lamp anchored top-left (the reference's `radial-gradient(70% 120% at 20% 0%)`); LIVE dot + label; occupant stack; a dark channel says its words rather than being a black rectangle. |
| `HereNowStrip` | `hereNow`, `context`, `everyone`, `size` | well + stack + "4 here · 20 lights on"; the trigger opens the **people sheet** on WP0's `Popover` — the only full list of people in the product (§6.5). |
| `OnAirPill` | `onAir`, `onReturn` | white dot, channel name, mono duration, mic state; one action. Replaces `MiniVoiceBar` in WP3. |
| `LiveDot` | `label` | 6px dot, 10.5px label — never louder than the channel (§6.7). |
| `LightCaption` / `RoomDuration` / `roomCaptionFor` | — | the meta ink, and the surface-specific wording. |

One token was added in WP1: **`--radius-thumb: 8px`**. §8 names the size
("8px radius well") and §3's radii list does not, so it now exists as a token
rather than a literal.

---

## 8. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint . --quiet` | pass, 0 findings |
| `npx vitest run` | **249 files, 2164 tests passed** (WP0 was 239 / 2033 — WP1 adds 10 files and 131 tests) |
| `npm run build` | pass; `/design-tokens` and the light demo data absent from `dist/` |
| `npx playwright test` (mocked smoke) | **84 passed** |
| `npm run test:contrast` | 49 checks × 4 themes passed |
| `npm run test:a11y:static` | one **pre-existing, non-WP1** failure in `src/components/guild/ChannelManager.tsx` (WP7's file, being restyled concurrently). No `components/light/**`, `hooks/**` or `lib/attention/**` finding. |

WP1's own tests:

- `lib/attention/lightCaptions.test.ts` — every string pinned, including "never
  says No data / It's quiet / Online".
- `lib/attention/personLight.test.ts` — the three levels, the stale-speaking
  guard, cross-server merge.
- `lib/attention/roomLight.test.ts` — **the reading definition**, term by term,
  including every way it must refuse to light somebody.
- `lib/attention/buildingLight.test.ts` — window order, the two-row cap,
  brightest-first, the Around-now sentence.
- `lib/attention/litHistory.test.ts` — start/stop/restart, eviction, logout.
- `lib/attention/guildLight.test.ts` — the store seam, with fixture store shapes.
- `lib/media/roomFrameTap.test.ts` — every still reason, the 2 fps ceiling,
  release on unsubscribe, no leaked bitmaps, capture failure survivability.
- `hooks/useLights.test.tsx` — **fixture stores**: seeded guild/channel/member/
  presence/voice/typing stores, lighting and dimming a channel live.
- `hooks/useRoomThumbnail.test.tsx` — live only in the joined channel on a
  canvas-rendering engine; `native-surface` and `not-joined` never subscribe.
- `components/light/light.test.tsx` — every component and state, plus the
  no-literal-colour assertion the WP0 test established.

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp1 npx playwright test e2e/design-review.spec.ts
# → output/design-reference/wp1/ (gitignored)
```

Twelve frames: `light-{avatars,windows,thumbnails,herenow,people-sheet}` at
**1440×900 and 390×844**, plus the tokens page at both. All inspected against
`output/design-reference/{Main,Lobby,Home}.png`. Four things the screenshots
caught and fixed:

1. **A tall element screenshot came back clipped.** `/design-tokens` scrolls
   inside its own container, so `locator.screenshot()` only captured what the
   container had painted. The spec now shoots the viewport once per anchored
   block (`#light-avatars`, `#light-windows`, `#light-thumbnails`,
   `#light-herenow`) — and re-asserts the section heading before each frame, so
   a shot can never catch the shell's boot splash.
2. **The channel thumbnail's lamp washed the middle of the frame.** It was sized in
   pixels from the height; it is now the reference's geometry exactly — an
   ellipse centred on the top edge, a fifth of the way across — so the glow hugs
   the top-left corner.
3. **The demo server had four channels**, so the window map drew one row and the
   lamp read as a smudge over empty plate. The demo now carries thirteen channels:
   two rows of eight with an overflow count, exactly like the reference sidebar.
4. **The Lobby demo card showed the occupant stack twice** (on the frame and in
   the body). The 168px card now follows `Lobby.png` (stack + Join in the body)
   and the 176px Home thumbnail follows `Home.png` (stack + Join on the frame);
   both demo cards are `w-full max-w-…` so nothing overflows at 390.

Checked against the reference renders: rim strength (the 1.5px warm ring plus
the 12px glow reads at 24px and at 40px), window size and gaps (10×13 / 5px in
the sidebar, 12×16 / 6px on Home), lamp position (top-left, behind the windows),
and caption copy (identical wording to §6.9 and §7).

---

## 9. Handover — which component to use where

| Package | Use |
|---|---|
| **WP2 Servers column** (§7.1) | `useBuildingLights()` for the per-server sections, ordered brightest-first. Per server: `SectionLabel` + `litMembersCaption(lightsOn)` ("24 in"), then `BuildingPlate` (scale `sidebar`), then channels from `building.rooms`: a **lit voice channel** is a row with `RoomThumbnail height={64}` + name + `roomCaptionFor(room)`; a **dark voice channel** is a plain row with `darkRoomCaption('row')`; a **text channel** is a row with a small `pc-window` dot (`is-reading` when `room.lit`) + `readingCaption(room.readingCount)`. The account plate's "Lights on" comes from `presenceLight`. |
| **WP3 Stage** (§7.2, §7.7) | `useHereNow(guildId, channelId)` → `HereNowStrip` in the header (`context="in {room}"`); `useRoomLight` for the channel name, `RoomDuration` for the mono duration; `useOnAir()` + `OnAirPill` replaces `MiniVoiceBar`. Speaking rings on tiles use `pc-speaking` — `room.occupants[i].speaking` is the source. **Do not** route media through `roomFrameTap`; the Stage keeps its existing engine contracts untouched. |
| **WP4 Lobby** (§7.3) | `useBuildingLight(guildId)` for the header counts and `useAroundNow([building])` for the Around-now well (`AvatarStack` + the sentence + `lightsOnOverflowCaption`). Channel cards: `RoomThumbnail height={168} showOccupants={false}` on a `Plate lit`, with the occupant `AvatarStack`, `RoomDuration` and a `variant="light"` Join in the body; dark cards use `roomCaptionFor(room, { surface: 'card', withLastLit: true })`. Text-channel rows reuse the WP2 row shape. Live frames come from `useRoomThumbnail(room)` — pass `state`/`frame` straight through. |
| **WP5 Text channel & DMs** (§7.4, §7.6) | `useHereNow` → `HereNowStrip` in the header ("5 reading · 19 lights on"); `LitAvatar size={36}` on timeline authors; `useRoomLight` for the inline channel events ("Shop floor lit up · …" from `aroundNowSentence({ rooms: [room] })` + a `LiveDot`); composer copy from `readingCaption(room.readingCount)`. A DM's peer light is `personLight` on the recipient. |
| **WP6 Home** (§7.5) | `useBuildingLights()` (already brightest-first), `useAroundNow(buildings)` and `useLightsOnAcrossBuildings(buildings)` for the Around-now well; per server `BuildingPlate scale="home"` beside `RoomThumbnail height={176}` fed by `building.brightestRoom`; lit text channels from `building.rooms.filter(r => r.kind === 'text' && r.lit)`. |
| **WP7** | Nothing required. One note: `src/components/light/HereNowStrip.tsx` composes WP0's `Popover` for the people sheet — if the floating surface's API changes, it is the one WP1 call site. |
| **WP8 sweep** | `presenceLight` + `LitAvatar` are the replacement for every remaining status dot and every `bg-accent-primary` avatar fallback. `MiniVoiceBar` is dead once WP3 lands `OnAirPill`. |

### Two things WP2–WP6 must not do

1. **Do not re-derive a light.** If a surface needs to know who is reading or
   talking, it calls a hook. The moment a component computes "online ⇒ reading"
   itself, the promise in §3 is broken and nobody can find it again.
2. **Do not spend a light token on emphasis** (§0, §6.3). `Button variant="light"`,
   `Chip tone="talking" | "reading"`, `LiveDot`, `pc-lit` and `pc-window.is-*`
   all assert that somebody is there right now.

### Left for later

- **Cross-server identity.** `useLightsOnAcrossBuildings` sums per server; the
  same human on two connected servers counts twice because the client cannot
  prove they are the same person. `mergePersonLights(people, keyOf)` is the seam
  that fixes this the day account linking exists.
- **Real channel presence.** If the server ever emits "user is viewing channel",
  it becomes term (d) of §3 and the reading count stops being a floor.
- **Camera thumbnails.** §5 allows "a 6–8s animated preview for cameras"; WP1
  samples cameras at the same ≤ 2 fps as a screen share. The interface
  (`RoomFrameRequest.track`) already distinguishes them.
