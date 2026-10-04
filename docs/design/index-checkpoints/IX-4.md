# IX-4 checkpoint: Shell (frame, tint, place slide, toolbar, large-title pages, slots)

Contract: `docs/index-spec.md` §3, §3.1, §4.9, §5.1, §5.9, §5.14, §6.1, §9 (phone root and pushed main only).
Plan row: `docs/design/index-plan.md` §3 (IX-4) and §1.3. Worktree `~/Documents/Paracord-index`, branch
`feat/index-ui`.

**This file is the contract for wave C (IX-5, IX-6, IX-7, IX-8, IX-9, IX-10).** Read "Slots" and "What each
package gets" before you start.

## What was built

`AppShell` now mounts `IxFrame` (components/ix/shell/IxFrame.tsx) instead of `GlassFrame`. The
`data-native-underlay-clear=""` line on the shell root is byte-identical. `GlassFrame` and its files are untouched
(fenced for `feat/native-video`; removed in M2/IX-19).

```
.glass-shell (AppShell root, kept: legacy pages still read its --glass-* vars)
  .ix-frame[data-layout=wide|narrow|phone][data-stage=none|side|theater][data-screen=places|conversation (phone)]
    nav.ix-side            data-testid=ix-sidebar, aria-label = place name ("Fuel", "People")
      TintLayers side      .ix-tint.ix-hue-side (one at rest, two while crossfading)
      .ix-side__pinned     <CardSlot place={current} position="pinned"/>   (never slides; collapses when empty)
      .ix-panes
        .ix-pane[data-place=<placeKey>][data-leaving?]  <SidebarSlot place leaving/>   (2 only while sliding)
      .ix-side__dock       <DockSlot/>
    main#main-content.ix-main[data-page=index|legacy]
      TintLayers main      .ix-tint.ix-hue-main
      Toolbar              data-testid=ix-toolbar, data-folded=true|false
      .ix-main__content    the routed page (AppShell's .glass-outlet + <Outlet/>)
      #ix-sheet-host.ix-sheet-host[data-sheet=<glassStore.sheet>]   (geometry only, empty)
      <SheetSlot/>
    #ix-call-host.ix-call-host   <CallSlot/>   (always mounted)
```

- **Widths** (`useIxLayout`): `wide` ≥ 1024 (sidebar 316, column padding 48), `narrow` 768–1023 (280, 32),
  `phone` < 768. No overlay, no third mode. The Glass compact overlay is not mounted; `PlacesToggle` renders
  nothing above the phone width.
- **Room light retired**: `RoomBackdrop` is not mounted, so `useRoomSource` never runs and the client opens no
  ambient view. (`lib/room`, the backdrop files and the voiceStore ambient actions stay until M2.)
- **One tree at every width**: `nav`, `main` and the call host are the same elements at every layout; on a phone
  CSS turns the two columns into two absolutely positioned screens and `usePhoneFrame`/`phoneMotion` (Glass,
  reused unchanged) slide between them. Crossing a breakpoint never remounts the page.
- **`inert`**: main while a call is open (`stage.mode !== 'none'`); the sidebar too in theater (it dims to .4,
  600ms spring); on a phone, whichever screen is behind, and both under the call.
- `useStageAudienceGuard()` moved with the frame (a stage audience still publishes nothing).

## Slots (`components/ix/shell/slots.ts`)

Each slot is exported from `components/ix/<dir>/index.ts`, which re-exports a stub from `./stub.tsx`. **The owner
replaces the export line and deletes `stub.tsx`**; the props stay as below. Changing a props type is a contract
change: tell the orchestrator.

| Slot | Props | Owner | Where IxFrame mounts it | Stub today |
|---|---|---|---|---|
| `SidebarSlot` (`ix/sidebar`) | `{ place: Place; leaving?: boolean }` | IX-5 | inside each `.ix-pane` (the pane IS the scroller: padding 16 12 8, flex column, children never shrink, hidden scrollbar) | Glass `PlacesPanel` (reads the route, ignores `place`); People → `PeopleSidebar` |
| `DockSlot` (`ix/dock`) | none (`DockSlotProps = Record<string, never>`) | IX-6 | `.ix-side__dock`, under the panes (phone: foot of the root screen) | static dock with the §1.3 test ids, styles at the end of `ix-shell.css` (`.ix-dock-stub*`, **IX-6 deletes them**) |
| `CardSlot` (`ix/card`) | `{ place: Place; position: 'pinned' \| 'inline' }` | IX-7 | `pinned`: `.ix-side__pinned` above the panes, with the CURRENT place. `inline`: **not mounted by the shell**; IX-5 renders `<CardSlot place={place} position="inline"/>` under its search field, with the pane's place | `null` |
| `CallSlot` (`ix/call`) | none | IX-13 | `#ix-call-host`, always mounted | Glass `Stage` (+ `PhoneStageChrome` on phone) in `.ix-inset-surface` while a stage is open |
| `SheetSlot` (`ix/sheets`) | none | IX-9 (new dir, see deviations) | inside main after `#ix-sheet-host` | Glass `Sheets` (which still portal into `#main-content` and fill all of main) |

`PeopleSidebar` (`ix/people`, no props, IX-14) is what `SidebarSlot` renders for `{ kind: 'people' }`; **IX-5
keeps that dispatch line**. `openAccountMenu()` / `ACCOUNT_MENU_ANCHOR` (`ix/menus`, IX-9) is what the toolbar
avatar calls (today: `toggleSheet('account')`). There is no `ix/conversation` stub: nothing in the shell mounts
the conversation (IX-15 owns the pages that do).

### Rules per slot

- **SidebarSlot**: take the place from the prop, never the route. While the place slides, the leaving pane keeps
  rendering the OLD place for ~450ms with `leaving` true: it is `inert`, `aria-hidden`, `pointer-events: none`;
  skip focus moves, scroll-into-view and pings there. A new pane starts at `scrollTop` 0. The pinned card is not
  yours to render. Give rows `data-place-row` (the phone frame focuses the first one when the root comes back).
- **DockSlot**: render the whole `toolbar` "Servers" (test ids `ix-dock`, `ix-dock-item` with
  `data-place={placeKey(place)}`). Read the current place from `useIxShell().place` and the order from
  `usePlaceOrder()` (People first, then servers as `useAvailableGuilds()` returns them): the shell computes the
  slide direction from the SAME order. Switch place by navigating (server: `guildLandingPath(guild)` then
  `navigate`; People: `/app/dms`); the shell follows the route. The ring surface behind the dock is
  `--ix-side-end` (the tint gradient ends on it).
- **CardSlot pinned**: render your call when it belongs to another place (with the server line), or an incoming
  call; else `null`. The host is `padding: 16px 12px 0` and `:empty { display: none }`; your card keeps its own
  `margin-top: 12px`, which puts it at y=28 like s4. While the host is not empty the panes' top padding becomes
  14px (`.ix-side:has(> .ix-side__pinned:not(:empty))`), so the header lands 18px under the card. **Render
  `null`, not an empty wrapper**, or the host stops collapsing. The §5.4 FLIP between pinned and inline is yours
  (measure before the place change, `flipFromRect(..., { scale: 'none' })` after).
- **CallSlot**: always mounted; render nothing when closed (after your own close motion). The host is geometry
  only (`position: absolute`; over main at inset 10; `data-stage='theater'` → inset 10 over the window; phone:
  `position: fixed; inset: 0`) and `pointer-events: none`, children get them back. Paint the surface yourself:
  `.ix-inset-surface` = radius 24, `--ix-call`, `--ix-shadow-call`, `position: absolute; inset: 0`. The host's
  size changes on theater; FLIP your surface from its old rect. Mark the surface `data-native-underlay-clear`.
  `stage.mode` is still `'side'` for Index "main" until M2.
- **SheetSlot**: `#ix-sheet-host` (`IX_SHEET_HOST_ID`) is the geometry: top/right/bottom 10, width 400 (480 when
  `data-sheet="search"`), radius 24, full inset (left 10) when main is under 760px (container query on main,
  `container: ix-main`), z-index 5 (over the toolbar, z 4), `pointer-events: none` with children `auto`. Portal
  the sheet into it (change `SheetFrame`'s `paneHost()` from `#main-content` to the host) and fill it
  (`position: absolute; inset: 0`). Phone keeps the window host.

## What each package gets (APIs)

Import from `components/ix/shell` (barrel; safe from a slot), `components/ix/page`, `components/ix/motion`.
`IxFrame` itself is NOT in the barrel (it imports every slot); AppShell imports it by path.

### Shell

```ts
type Place = { kind: 'server'; guildId: string } | { kind: 'people' };
PEOPLE_PLACE; serverPlace(id); placeKey(p) /* 'people' | guildId = data-place */; samePlace(a, b)
placeOfPath(pathname): Place | null   // /app/guilds/:g/** -> server; /app, /app/dms[/:id], /app/friends -> People; else null
placeDirection(order, from, to): -1 | 0 | 1
useCurrentPlace(): Place              // the route's, else the last one (useIxPlaceStore.last; IX-14's redirect can read it)
usePlaceOrder(): string[]             // ['people', ...guild ids]  (the dock order)
usePlaceHue(place): number            // People 210; serverHue(guild) (guild.hue, else paletteHue(id))
usePlaceName(place): string
useIxShell(): { layout: 'wide'|'narrow'|'phone'; place; guildId; channelId }   // throws outside IxFrame
useOptionalIxShell()                  // null outside (showcases, tests)
useIxLayout(); IX_NARROW_MAX_WIDTH = 1024
TintLayers({ hue, kind: 'side' | 'main' })
IX_SHEET_HOST_ID = 'ix-sheet-host'; IX_CALL_HOST_ID = 'ix-call-host'
```

CSS variables on `.ix-frame` for slots and pages: `--ix-side-w`, `--ix-toolbar-h` (58), `--ix-col-max` (920),
`--ix-col-pad` (48 / 32 narrow), `--ix-inset` (10), `--ix-inset-radius` (24). The message box margin is
`calc(var(--ix-col-pad) - 12px)` (IX-12).

### Toolbar (`useToolbar`)

The toolbar is the frame's: 58px, absolute over main's top, padding 0 20 0 40, gap 10:
`[back] [folded title] ··· [call] [search] [members] [your avatar 32]`. A page tells it what to say:

```ts
useToolbar({
  title?: string | null;            // the folded title (the large title's text)
  onTitleClick?: () => void | null; // the channel menu / a DM's profile; makes the title a button
  titleHasPopup?: 'menu' | 'dialog' | null;
  folded?: boolean;                 // from useTitleFold
  onBack?: () => void | null; backLabel?: string;   // pushed pages (§6.1)
  call?: ReactNode;                 // the DM call button, left of search (IX-15, §7.5)
  search?: boolean; members?: boolean;  // default: shown when the route has a server or a conversation
});
```

- Registering ALSO tells the frame the page lays itself out under the toolbar (`main[data-page="index"]`); a page
  that does not register (every Glass page today) is pushed 58px down (`data-page="legacy"`). One owner at a
  time; the last to register wins and a late unmount never clears a newer page.
- Search → `toggleSheet('search')` ("Search messages"); members → `toggleSheet('people')` ("Members", or "People
  in this message" in a DM); the avatar → `openAccountMenu()` ("Your account", `data-ix-account-anchor`).
- Folded: `data-folded="true"` → `--ix-toolbar-fold` fill (opaque `--ix-main` with Reduced transparency) and a
  bottom hairline (opacity), 300ms; the folded title enters from `translateY(6px)` + fade (250ms opacity, 350ms
  spring). No blur. While not folded the title is `aria-hidden` and `tabindex=-1`.
- Phone: with no `onBack`, the toolbar shows "Back to the sidebar" (→ `phoneNav.showPlaces`). IX-16 finishes it.

### Pages (`components/ix/page`)

```tsx
<LargeTitlePage title subtitle? onTitleClick? titleHasPopup? onBack? backLabel? toolbarCall? search? members?
                width?='column'|'full' className? bodyClassName? data-testid?>{children}</LargeTitlePage>
<LargeTitle title subtitle? onTitleClick? titleHasPopup? foldRef? />     // h1 has data-testid="ix-title"
useTitleFold(scroller: HTMLElement | null): { folded: boolean; titleRef: (el) => void }
FOLD_RANGE = 60; FOLD_AT = 40; foldProgress(scrollTop)
```

- `LargeTitlePage` is the scroller (`.ix-page`, padding-top 58, hidden scrollbar) → `.ix-column` (max 920 +
  2×padding, centered) → `LargeTitle` (padding-top 8; h1 36/700 −.03em; subtitle 14 ink-3, 4px under) →
  `.ix-page__body` (padding-bottom 32). `width="full"`: the title stays in the column, the body spans main.
  Measured at 1280: title at x=364 (316 + 48), y=88, like `ref/s0-quiet.png`.
- The fold: `t = min(1, scrollTop/60)`, the title block `scale(1 − .1t)`, opacity `1 − .9t` from `0 50%`, written to
  its style on scroll at most once per frame; `folded` flips past 40px. A title that is not mounted (history not
  loaded, virtualized away) counts as folded.
- **IX-15**: put `<LargeTitle foldRef={titleRef} …/>` in `MessageList`'s `header`, call
  `useTitleFold(listScrollerElement)` and `useToolbar({ title, folded, onTitleClick, call })`. The list's
  scroller must start with 58px of top padding (the toolbar floats over it), or register and add it yourself.
- **IX-10 / IX-14 / IX-17**: wrap each page in `LargeTitlePage`; pushed pages pass `onBack` (Esc and Alt+Left are
  the page's to bind).

### Motion helpers (`components/ix/motion`)

All Web Animations, transform/opacity only, honoring the app's one reduced-motion switch; each returns its
`Animation`s (or null) so you can clean up and cut short.

```ts
IX_SPRING /* cubic-bezier(0.32, 0.72, 0, 1) */; IX_EASE /* cubic-bezier(0.2, 0.8, 0.2, 1) */  // pinned to the tokens by a test
IX_REDUCED_MS = 150; ixReduced(); canAnimate(el)
onSettle(animations, done): dispose   // done once, after all finished OR canceled; sync when there is nothing to wait for
commit(animations)                    // finish() each now (cut short by a newer event of the same kind)
slidePanes(outEl, inEl, dir: -1|0|1): { outgoing, incoming }   // §5.1; out fills forwards: remove it on settle
crossfadeLayers(inEl, { duration = 900, easing = IX_EASE, id }) // fade a layer in over an opaque one
measureRect(el); measureRects(els): Map
flipFromRect(el, fromRect, { duration, easing = IX_SPRING, scale: 'xy'|'uniform'|'none' = 'xy',
                             opacityFrom?, origin = '0 0', delay?, reduced: 'fade'|'none' = 'fade', id? })
flipMoved(beforeMap, { duration, easing?, delay?, id? })        // translate displaced content; reduced: snaps
invertTransform(from, to, scale)       // the keyframe, for counter-layers (§5.8)
```

Reduced motion: moves become a 150ms opacity fade (`flipFromRect` default) or nothing (`flipMoved`,
`reduced: 'none'`). Give your animations ids (`ix-<thing>:<part>`): the e2e and IX-18's gate read
`document.getAnimations()` by id. Never fill forwards on an element that stays mounted (it stays in
`getAnimations()` and blocks the "nothing running at rest" check); if you must, cancel it on settle.

### Store (`stores/glassStore.ts`, additive)

`stage.chat: boolean` (the call view's chat column, H) and `toggleChat()`: false when a stage opens, kept when
switching streams, false whenever nothing is open, ignored with no stage. `mode` is still
`'none' | 'side' | 'theater'` (rename in M2). Glass's `chatHidden`, `browseOpen`, `pillExpanded`,
`placesOverlayOpen` remain until IX-19.

## Motion (what the shell plays)

- **Place switch (§5.1)**: `SidebarPanes` mounts the new pane beside the old one and plays `slidePanes` with
  `dir` = sign of the dock-order change (0 for an unknown place: a crossfade); the old pane is removed on
  settle. A newer switch mid-slide cancels the running one (the leaving pane goes at once; the current pane is put
  at rest) and slides from there. Going straight back to the place that is leaving reuses its pane (its
  forward-filling slide-out is canceled so it cannot stay hidden).
- **Tint (§5.1)**: `TintLayers` adds a layer above with the new `--ix-hue` (a plain number, never animated) and
  fades it in 900ms ease; the layers under it are removed on settle. Mid-fade changes commit the first: never more
  than two layers. Both columns crossfade in step.
- **Theater (§5.9)**: the sidebar's opacity .4 (CSS transition, 600ms spring). The surface FLIP is IX-13's.
- **Title fold (§5.14)**, **toolbar fill (§4.9)**: above.
- Main's title/feed entrance on a place switch (§5.1 "Main: … as 5.2") is IX-15's.
- At rest: no `ix-*` animation is running (e2e asserts it 2s after load, after a place switch and after the fold).

## Decisions and deviations

1. **`SidebarSlotProps.leaving`** (optional) added to the plan's `SidebarSlot({ place })`: the leaving pane needs
   to know to skip side effects.
2. **`SheetSlot` lives in a new `components/ix/sheets/`** (the plan names no directory for it). Its owner is IX-9
   (who owns `glass/sheets/**`); the orchestrator should add `components/ix/sheets/**` to IX-9's files.
3. **No `ix/conversation` stub**: the shell mounts no conversation; inventing IX-15's props would be guessing.
4. **The pinned card sits outside the scroller** (it never slides, §5.4), so with a long sidebar it stays put
   while the panes scroll under it. The prototype draws it inside the pane; the spec's "does not slide" decides.
5. **Legacy pages are pushed 58px down** under the toolbar until IX-10/IX-15 register. Interim side effect: a
   channel shows both the toolbar's tools and the old conversation header's (and on a phone two back buttons).
   Expected to disappear when IX-15 retires `ConversationHeader`.
6. **Account menu anchor**: the toolbar avatar opens the Glass account menu, which still anchors to
   `.glass-header__avatar` (the old header's face) when one is on screen. IX-9 anchors to `ACCOUNT_MENU_ANCHOR`.
7. **Sheets**: today's `SheetFrame` still portals into `#main-content` and covers all of main (z 5, over the
   toolbar). The 400/480 host is in place for IX-9.
8. **Calls**: the Glass stage runs on the Index surface. Its own controls (Stop watching, theater, browse S)
   still work; browse does nothing visible (no places pane to bring back). Glass `CallStage` has no theater
   (forces `side`), so only streams reach theater until IX-13.
9. The phone keeps Glass's `-22%` root shift (spec §9 says −30%); `phoneMotion.ts` is IX-16's from now.
10. Out-of-scope edits, each minimal: `components/glass/shell/PlacesToggle.tsx` (renders nothing above the phone
    width: the overlay it opened is gone) and its test; `components/glass/conversation/ConversationPane.test.tsx`
    (its "compact frame" case now asserts there is no Show places button); `stores/glassStore.test.ts` (`chat`
    in the three exact-shape expectations, one new case).
11. Checkpoint path: the preamble's `docs/design/index-checkpoints/IX-4.md` (the plan says
    `index-ix4-checkpoint.md`).

## Verification (commands run in `client/`)

- `npm run typecheck`: clean.
- Unit: `npx vitest run src/components/ix src/pages/AppShell.test.tsx src/stores/glassStore.test.ts
  src/components/glass/shell/PlacesToggle.test.tsx src/components/glass/conversation/ConversationPane.test.tsx`:
  all pass. New: `ix/shell/shell.test.tsx` (16: places, pane slide by dock order both ways, mid-slide cut, coming
  back, no-engine path, tint swap removes the old layer, mid-fade commit, toolbar tools/labels/fold/back/call/
  owner), `ix/motion/motion.test.ts` (12: curves = tokens, onSettle/commit, slide keyframes and timings, reduced
  motion, crossfade, FLIP math), `ix/page/page.test.tsx` (4: fold math, scale/opacity/folded on scroll, one
  update per frame, toolbar registration). `AppShell.test.tsx` rewritten for the Index frame (19: layouts at
  wide/narrow/phone, hosts and slots, place from route and last place, call over main / theater, phone screens,
  push on a same-place pick, swipe, skip link, settings overlays). The pre-existing AppShell failure ("hides the
  conversation in theater only…") went with the Glass frame tests it belonged to.
- Full `npx vitest run`: 4330 passed, 18 failed, none from IX-4: `useGlassKeybinds` and `stageTransition`
  (pre-existing at HEAD); `InlineChips`, `PlanCard`, `eventTime`, `FeedPostCard`, `ScoreUpdateCard`,
  `MessageList.bubbles`, `vocabulary` ("Building the lantern" in `pages/IxCardsGallery.tsx`): IX-8's in-flight
  work; `InstanceSetupPage` (passes alone; load timing).
- `npm run test:motion-lint`: passes (no allowance added). `npm run lint`: 0 errors (213 warnings; none in IX-4
  files). `npm run test:contrast`: passes.
- `npm run test:tokens` and `npm run test:a11y:static` fail on IX-8's in-flight files only
  (`pages/IxCardsGallery.tsx` literal colors; `file/FilePreview.tsx:100`, `message/MessageComponents.tsx:378`).
  No IX-4 file is reported.
- e2e: `PARACORD_E2E_INDEX_SPEC=index-shell PARACORD_E2E_INDEX_PORT=4523 PARACORD_E2E_INDEX_RT_PORT=4525
  PARACORD_E2E_INDEX_WP=ix4 npx playwright test -c e2e/index-review.config.ts`: 7/7 pass (IX-0's harness).
  Frame geometry (316 / 964, hairline, toolbar 58 at main's top, one tint layer each at Fuel's 350, no room
  backdrop, no `ix-*` animation 2s after load); the place switch (two panes mid-move, `ix-pane:in` from
  `translateX(60%)` and `ix-pane:out` to `-40%` going right, `-60%` coming back left, both tint crossfades
  running, then one pane and one layer at Game Night's 195, nothing running); a `LargeTitlePage` rendered over
  main with the app's React (title at x=364, half fold at 30px = `scale(0.95)` / .55, toolbar folded past 40px
  with `rgba(16,17,19,.92)` and no backdrop filter, folded title opacity 1, nothing running after); the call
  host over main at inset 10 (surface radius 24, main inert), theater over the window with the sidebar at .4 and
  inert, closed host empty; the pinned host (collapsed when empty, a card at (12, 28, 292 wide), panes at 14px
  and starting at the card's bottom); the sheet host (400 / 480 / full inset at 900px); shots at 1280, 1440,
  900, 390 (phone root via the toolbar's back).
- `node e2e/index-compare.mjs ix4`: `s0-quiet` mean 2.99%, 19% changed. I read the side-by-side
  (`compare/s0-quiet.png`): window tint, sidebar hairline, toolbar tools (search 1157, members 1201, avatar 1244
  at y 29), dock positions and indicator, and the title column match; every difference is a stub's content (the
  Glass places panel in the sidebar, the Glass conversation and its header in main).
- Not run: `npm run test:e2e` (mocked smoke). `e2e/smoke.spec.ts` and the `glass-*` specs assert `.glass-frame`,
  the compact overlay and the room backdrop, so they now fail by design; replacing them is IX-19's.

## Screenshots (`output/design-reference/index-build/ix4/`, gitignored)

Read: `s0-quiet.png` (+ `@1440x900`, `@900x700`, `@390x844`), `s0-quiet-root@390x844.png` (phone root),
`shell-game-night.png` (after the switch, hue 195), `shell-large-title.png` and `shell-large-title-folded.png`
(held against `ref/s5-busy-title-folded.png`: folded title at x=356, fill and hairline match),
`shell-call.png` (Glass stage on the Index surface), `compare/s0-quiet.png`.

## Left for later packages

- IX-5/6/7/9/13/14: replace the stubs (above). IX-6 deletes the `.ix-dock-stub*` rules in `ix-shell.css`.
- IX-9: `SheetFrame` portal → `#ix-sheet-host`; account menu anchor; drop the pill from `SheetFrame`.
- IX-15: retire `ConversationHeader` (removes the duplicate tools) and register the conversation with the toolbar.
- IX-16: phone polish (52px toolbar, −30% root shift, dock as a bottom bar with safe areas, call as a sheet).
- IX-19: `smoke.spec.ts` and the `glass-*` e2e specs; `GlassFrame`, `PlacesOverlay`, `PlacesToggle`.
