# Glass polish 1 checkpoint

Seven small, independent fixes that earlier packages found and left for later (G6b, G8, G13, G14,
G19). Branch `design/glass`, nothing committed. Each item names its change, its test and its
result. Commands and screenshots are at the end.

| # | Item | Result |
|---|---|---|
| 1 | Server banner race | Fixed. Fails before, passes after |
| 2 | Stale authenticated images | Fixed. Fails before, passes after |
| 3 | Places preview names a shared event | Done. Live in the mocked harness |
| 4 | Incoming-call notice reserves no space | Done. Measured in Chromium; the unit test pins the contract only |
| 5 | Server hub settings copy | Done |
| 6 | `docs/encryption.md` | Done |
| 7 | `CanvasRenderer` `fit` option | Added and tested. Nothing passes it yet (see item 7) |

## 1. Server banner race

- **Problem.** READY names six fields per guild and no banner. When it landed while `fetchGuilds`
  was in flight, `addGuild` recorded a `put` and the finished list was replaced by that partial
  projection, so the banner was gone until something else fetched the guild (G8 item 3).
- **Change** (`client/src/stores/guildStore.ts`). The replay of a recorded `put` merges over the
  fetched guild (`{ ...fetched, ...put }`). Also in `record`: a `put` that follows an earlier `put` or
  `patch` of the same guild is merged into it, where it used to replace it, so a later partial
  projection cannot erase a change the gateway already sent. A `put` after a `delete` still stands
  alone. What the gateway did say still wins over the older REST snapshot.
- **Test** (`guildStore.test.ts`, 5 new). The race (banner, description and visibility survive;
  name and member count come from READY); a guild only READY knows is still added; a `patch` then a
  partial `put` keeps the patched banner; a later full `put` adds to an earlier partial one; a removed
  guild does not come back. Run against the old code first: the race test and the patch-then-put
  test fail (the latter with `expected undefined to be 'banner-2'`); the other three pass either way.
- **Result.** 28 of 28 pass.

## 2. Stale authenticated images

- **Problem.** The hook kept its answer in state and returned it until an effect replaced it, so the
  render in which `src` changed returned the last input's image (G8 item 4). In a browser (where every
  URL loads as it is) that was the old URL itself.
- **Change** (`client/src/lib/authenticatedImage.ts`; the hook lives there, not in `hooks/`). A URL
  the browser can load as it is (`data:`, `blob:`, or any URL outside the desktop shell) is returned
  directly, with no state. A bridge resolution is stored with the input and cache generation it
  answered, and read back only while both match, so a new input is null until its own answer arrives.
  A cache clear still shows nothing until the new resolution lands, as before.
- **Test** (`authenticatedImage.test.tsx`, 10 new; the hook had none). Every render is recorded, so
  a stale value cannot hide between effects: a new input in a browser; an input that goes away; on the
  desktop route, old image to new input (pending, then resolved), to a URL needing no bridge, to
  nothing; an answer for a replaced input is ignored; a failed bridge call reads null, not the last
  image; a cache clear. Run against the old hook first: 6 of the 10 fail.
- **Result.** 10 of 10 pass. Every component that uses the hook passes in the full suite.
- `components/glass/room/useRoomSource.ts` still works around the old behavior (it takes loadable
  URLs as they are). It is harmless now and outside this package.

## 3. Places preview names a shared event

- **Change.**
  - `client/src/lib/markdown.ts`: `messageSnippetText` takes an optional fifth argument
    `eventNames` (event id to name). `<event:ID>` reads as the name when it is there and "an
    event" when not. The name goes in after the markup is stripped, so `snake_case_run` is not
    read as formatting. `messagePreviewText` is unchanged.
  - `components/glass/places/model.ts`: `PreviewContext` gains `eventNames`; `previewText` passes it.
  - `components/glass/places/usePlacesData.ts`: `useServerPlaces` builds `eventNames` from the server's
    calendar, which it already loaded for Coming up (`useUpcomingEvents`), and puts it in the context.
- **Test.** `markdown.test.ts` (+1): known, unknown, no map, empty name. `model.test.ts` (+3): the
  reference case, an event that is the whole message, two events, a name with markup characters.
  `PlacesPanel.test.tsx` (+2): the real panel reads "Jeremy: @someone is Movie night still on?"
  with the event in the calendar and "an event" without it, never the id. `rows.test.ts`: the
  context gains the field.
- **Result.** Mocked harness, General row: "Jeremy: @Sean is Movie night still on? I'm bringing the
  projector" (clamped in the panel to "…is Movie n…", the reference's shape), and with the calendar
  emptied "…is an even…" (the old reading). See screenshots.
- **What it does not cover.** The panel knows the events the calendar lists: scheduled or active
  ones. A finished or canceled event, and one in another server, reads "an event". The card cache
  (`glass/cards/useGuildEvent.ts`) holds more, but it is private to that file and outside this
  package. The search overlay (`SearchOverlay.tsx`) and `messagePreviewText` callers (reply chips,
  notifications) still say "an event".

## 4. Incoming-call space

- **Problem.** `BannerStack` measured its whole column, so the ringing capsule (62px with its air)
  pushed both panes down while it rang, though the Glass notice floats (G19).
- **Change** (`client/src/components/BannerStack.tsx`). The capsule (`.glass-callbanner`) is taken
  out of the stack's flow with five Tailwind rules on the stack: `absolute`, `inset-x-0`,
  `top-full` (just under whatever banners are in flow), and `pointer-events-none` on the notice with
  `pointer-events-auto` on its children, so only the capsule takes clicks and the strip around it
  reaches the app. The stack's height, and so `--pc-banner-inset`, then counts only banners in flow.
  Nothing else changed: the connection bar and the restart banner still stack and still move the
  app down.
- **Test** (`BannerStack.test.tsx`, 4 new). jsdom applies no stylesheet, so these pin the contract:
  the stack carries the rules for `.glass-callbanner` and for nothing else; the inset is the stack's
  own measured height, not the capsule's (mocked 32 and 62 give 32px; a lone capsule gives 0px). The
  first two fail without the rules; the measure tests pass either way, because in a browser the
  stack's own box is what excludes the capsule. The layout itself was measured in Chromium (below).
- **Result, measured in Chromium** (mocked scene, `/app/dms/3001`, 1440x900; scratch harness, see
  Commands):

  | State | `--pc-banner-inset` | Places pane top | Capsule | Point beside the capsule |
  |---|---|---|---|---|
  | Quiet | 0px | 16 | none | the app |
  | Ringing, before | **62px** | **78** | y 0 to 62 | the notice |
  | Ringing, after | **0px** | **16** | y 0 to 62 (capsule 539,10, 362x52, as before) | the app (places list) |
  | Ringing with a 32px bar, before | 94px | 110 | y 32 to 94 | the notice |
  | Ringing with a 32px bar, after | **32px** | **48** (same as the bar alone) | y 32 to 94 (under the bar) | the app |
  | The bar alone | 32px | 48 | none | the app |

  Phone (390x844, ringing): inset 0px, conversation pane at y 12, capsule at y 10, the capsule takes
  the click at its center. The compiled production CSS (`vite build` to a scratch directory)
  contains all five rules.
- **Note for review.** While a call rings, the capsule now covers the top 62px of the panes (the
  DM header's name, and on the phone the first row of the call pill). That is what floating means
  and the panes no longer jump; the pointer still reaches everything beside it.

## 5. Server hub settings copy

- **Change** (`client/src/components/guild/ServerHubSettings.tsx`). The section label "Home page" is
  now "Overview page", and the line reads "The widgets on this server's Overview page, top to bottom,
  between Live now and Latest. One with nothing to show stays hidden." (The settings tab called
  Overview is a different thing: name, icon, banner. "Overview page" keeps the two apart.) The code
  comment no longer says "widget column".
- **Test** (`ServerHubSettings.test.tsx`, 2 new; the component had none): the new label and line,
  no "beside the feed", "home page" or "widget column" in the section, and the widget list still there.
- **Result.** 2 of 2 pass.
- `components/rooms/lobby/widgets/HomePageSettings.tsx` still has `aria-label="Home page widgets"`
  (and its test title "Home page settings"). Outside this package.

## 6. `docs/encryption.md`

The "Voice and video" section is rewritten from the G6b suggestion and checked against the code
(`engineShared.keyRecipients` and `isViewableStream`, `ViewTarget::allows`, `roster_kind`,
`MediaCloseReason`, `revoke_views_without_access`). It now has: members and viewers (watch and
ambient); the roster marker and how an unknown one is refused; one key per track; who is sent which
key (voice to members, screen video and screen audio also to viewers, camera never), with the relay
filtering again; the rotation rules as a table; the three close reasons with codes and words; the
5-second re-check of views; and limits (keys not tied to identity, a viewer's arrival not rotating,
the roster marker not saying watch from ambient, calls not re-checked, the short stall when a viewer
leaves). "What the server can see" gains who is watching a screen share without being in the call.
Wording choices to check: I described an ambient view as "the app opens one by itself, for example to
light the room", and kept G6b's numbers (0.2 to 5.1 s, 0.1 to 0.7 s) as "in our live runs".

## 7. `CanvasRenderer` `fit`

- **Change** (`client/src/lib/media/video/canvasRenderer.ts`). `new CanvasRenderer(canvas, { fit })`
  with `fit: 'contain' | 'cover'`; the default is `contain`, the old behavior, and the existing
  single-argument calls are unchanged. `cover` scales by the looser axis and centers, so the draw
  rectangle overflows the canvas (negative `drawX` or `drawY`) and both backends crop at the canvas
  edge (2D `drawImage`, and a GL `viewport` larger than the drawing buffer). Rounding cannot leave a
  one-pixel bar on the axis that sets the scale. Exported types: `CanvasFit`, `CanvasRendererOptions`.
  `renderer.fit` is readable. It is fixed at construction, like the backend.
- **Test** (`canvasRenderer.test.ts`, 11 new). 2D: default and `contain` agree (4:3 in 2:1 draws
  133x100 at x 33); `cover` draws 200x150 at y -25 and 178x100 at x -39 in a square; same shape is
  identical; a grid of canvas and frame shapes never leaves a bar or gap, and `contain` always fits
  inside. WebGL (a fake context that records `viewport`): default viewport `[33, 0, 133, 100]`, `cover`
  `[0, -25, 200, 150]`. Mutating `cover` away fails 4 of them.
- **Result.** 14 of 14 pass.
- **For the stage.** Nothing passes `fit` yet. The brief said not to touch the stage; what it needs:
  1. `MediaEngine.subscribeVideo`'s `options` (`lib/media/mediaEngine.ts`, `{ preferredTrackId? }`)
     gains `fit?: 'contain' | 'cover'`.
  2. `browserMediaEngine.ts` (`new CanvasRenderer(canvas)` near line 1452) and `tauriMediaEngine.ts`
     (near line 1919) pass `{ fit: options?.fit }`. One subscription is shared by several tiles
     but each tile has its own sink and renderer, so the fit is per tile.
  3. The camera tile (`components/glass/stage/StagePeople.tsx`) passes `{ preferredTrackId: 'camera',
     fit: 'cover' }`.
- **Not covered.** The desktop's native-surface route (Linux `native_render/linux.rs`, and macOS)
  letterboxes in its own shader (`insideFrame`), so a native camera tile stays letterboxed until that
  shader gets the same option. The option changes the canvas route only (every browser, and the
  desktop when WebCodecs decodes).

## Files

Changed: `client/src/stores/guildStore.ts`, `client/src/lib/authenticatedImage.ts`,
`client/src/lib/markdown.ts`, `client/src/components/glass/places/{model.ts,usePlacesData.ts}`,
`client/src/components/BannerStack.tsx`, `client/src/components/guild/ServerHubSettings.tsx`,
`client/src/lib/media/video/canvasRenderer.ts`, `docs/encryption.md`.

Tests changed: `client/src/stores/guildStore.test.ts`, `client/src/lib/markdown.test.ts`,
`client/src/components/glass/places/{model.test.ts,rows.test.ts,PlacesPanel.test.tsx}`,
`client/src/components/BannerStack.test.tsx`, `client/src/lib/media/video/canvasRenderer.test.ts`.
Tests new: `client/src/lib/authenticatedImage.test.tsx`,
`client/src/components/guild/ServerHubSettings.test.tsx`.

Outside the scope, not edited (for whoever owns them): the comments in
`components/dm/IncomingCallBanner.tsx` and `styles/glass-pages.css` that still say the stack
"reserves" the capsule's height; `HomePageSettings.tsx`'s aria-label; the stage's use of `fit`.
`BannerStack` finds the capsule by its class. If `IncomingCallBanner` ever carries an explicit
marker for "floats", the stack's rules should key on that instead.

## Commands (from `client/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | 399 files, 4,078 tests pass |
| the eight files touched, plus `src/components/dm` (13 files) | 263 tests pass |
| `npm run test:tokens` | pass (814 files) |
| `npm run test:motion-lint` | pass |
| `npm run test:a11y:static` | pass |
| `npm run lint` | 0 errors (254 warnings repo-wide, none in these files; `eslint` on the files touched prints nothing) |
| `vite build` to a scratch directory | builds; the compiled CSS has the five banner rules |

Screenshots and measurements: `output/design-reference/glass-build/polish1/` (gitignored).

- Places preview: `places-event-preview-after.png` (full window), `places-event-preview-crop-after.png`
  (the panel; "Jeremy: @Sean is Movie n…"), `places-event-preview-unknown-after.png` (the calendar
  emptied: "…is an even…"), with `places-event-preview-after.json` (the row text).
- Ringing, desktop: `ringing-none-before.png`, `ringing-before.png`, `ringing-with-bar-before.png`
  against `ringing-none-after.png`, `ringing-after.png`, `ringing-with-bar-after.png`, and the
  measurements in `ringing-before.json` and `ringing-after.json`. Phone: `ringing-phone-after.png`
  and `.json`.
- Harness: `harness/{playwright.config.ts,polish1.spec.ts}`. It lives outside the repo's e2e
  folder on purpose (this package may not add to it). Copy both next to a `node_modules` link to
  `client/node_modules` and run `npx playwright test -c playwright.config.ts` (ports 4473 and 4475;
  `POLISH1_TAG=before|after` names the files). It uses the G2 scene and G19's `installGlassPages`
  with `{ ringing: true }`.

## Uncertain or left

- Item 4 has no automated check of the layout in the repo; only the class contract and the
  measure are unit-tested, and the real numbers come from the scratch harness above. A committed
  Playwright assertion would belong in `glass-pages.spec.ts` (G19's file).
- Item 3 covers calendar events only (see above).
- Item 7's option is not used by any tile yet, and the native-surface route is unchanged.
- The full unit run happened with other packages' work in the tree (clips, stream reactions, stage).
  All of it passed at that moment.
