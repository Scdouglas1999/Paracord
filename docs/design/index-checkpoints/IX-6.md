# IX-6 checkpoint: Dock (and the Add a server sheet)

Contract: `docs/index-spec.md` §4.8, §5.1, §5.5, §5.15, §6.1, §8.3, §10. Plan row: `docs/design/index-plan.md` §3
(IX-6). Worktree `~/Documents/Paracord-index`, branch `feat/index-ui`.

## What was built

`DockSlot` (the slot IX-4 left a stub in) is the whole dock: People first (your avatar, 34px circle), a separator,
the servers in the client's order, then `+`. `components/ix/dock/` is the package; `stub.tsx` and its
`.ix-dock-stub*` rules in `ix-shell.css` are gone.

- **Marks and states.** Item 42x42 radius 14, mark 34. The current place's mark is full strength at `scale(1.08)`; the
  others sit at opacity .82 (opacity fades 300ms, scale 450ms spring). Hover lifts the item 2px (350ms spring).
  Live dot (10px amber, top 1 right 1), unread dot (8px ink, top 3 left 2), mention chip (16px tall ink, `--ix-mention-ink`
  text 11/700, top-left instead of the dot), all with the 2.5px `--ix-side-end` bite, always in the DOM and scaled in and
  out with the 450ms spring. The current place shows no unread dot or chip (its own rows carry them); it does show live.
- **One indicator** (16x3, 7px from the dock's bottom) in the dock, not in the scroller, so it glides across People and
  the servers. Web Animation `ix-dock:indicator`, `transform` only, 550ms spring. It follows its item while the scroller
  scrolls (one write per frame, no glide), hides while its item is scrolled out of view, and the current server is scrolled
  into view *before* the glide is measured. Reduced motion: a 150ms opacity fade.
- **The ping.** `ix-dock:ping`: a 2px amber ring inside the live dot, `scale(1) -> scale(2.2)`, opacity 1 -> 0, 1200ms ease,
  once per not-live -> live edge of a server you are not in. Never the current place, never a server that was not in the
  dock the render before (a server that arrives already live, READY), never one that was already live; none under reduced
  motion. Rule: `pingEdges` in `dockModel.ts`.
- **Overflow.** The servers scroll horizontally inside `.ix-dock__scroll` (People and `+` stay outside it), no scrollbar,
  16px static edge fades as a mask (`data-fade-start` / `data-fade-end` from the scroll position), a vertical wheel over
  the servers maps to horizontal (a native non-passive listener; only while they overflow). `scroll-padding-inline: 20px`
  keeps the item scrolled into view out of the fades. Padding with an equal negative margin leaves room for the lift, the
  dot rings, the ping and the focus ring.
- **Tooltip.** One bubble in the dock root (the scroller would clip it): the name, centered over the item, 8px above it,
  near-solid `--ix-tip`, radius 8, 12.5/600; 400ms after hover, immediately for keyboard focus and for a neighbor while
  one is open; never for touch; closed by a press, scroll, Escape, blur or leaving.
- **Keyboard.** One roving-tabindex toolbar named "Servers" (`aria-orientation=horizontal`): the Tab stop is the current
  place (it goes back to it when the place changes), Left/Right wrap, Home/End, Enter/Space activate, `+` is in the ring.
  Ctrl+Alt+Up/Down (⌥⌘↑/↓ on macOS) step through People and the servers, wrapping; Ctrl+1…9 (⌘1…9) jump to the nth
  server (People is not numbered). They live in `hooks/useKeyboardNavigation.ts` ("place keys only") and use the same
  `useGoToPlace` as a click. They also work while typing (the modifiers never insert text) and are ignored behind a
  modal dialog (`role=dialog aria-modal`, not a sheet). A digit is read from the physical key (`code`), so AZERTY works.
  A number with no server behind it does nothing and does not take the key.
- **Right-click a server** -> IX-9's `openServerMenu(server, anchor)` (`components/ix/menus`; the sheet slot mounts the
  menu, the dock renders nothing for it). Anchor = the pointer; a keyboard-opened context menu reports (0, 0) and hangs
  under the item. People and `+` have no menu.
- **`+` -> the Add a server sheet** (`AddServerSheet`, mounted by the dock into IX-9's `SheetFrame`): a segmented control
  (tablist: Create / Join / Discover; arrows, Home/End).
  - *Create*: Server name (suggested "<username>'s server"), "Start from" = Blank or one of the instance's templates
    (radio cards: name, description, "N channels · M roles"), an optional picture for a blank server, a cream "Create
    server". A template goes through `applyTemplate` (name only: the route takes no picture, so the picture row is hidden
    for a template). Template list errors are shown with "Try again"; Blank still works.
  - *Join*: Invite link or code (the last path segment is the code), cream "Join server"; the refusal is shown in words
    and the form stays.
  - *Discover*: opens `/app/discovery` (the Discover page in main) and puts the sheet away.
  - Create and Join land on the new server's landing channel (`guildLandingPath`) and close the sheet. One sheet at a
    time: opening it calls `closeSheets()`, another sheet opening closes it, a route change closes it. Esc closes it and
    focus goes back to `+` (`SheetFrame`'s trap). `+` carries `aria-haspopup="dialog"` and `aria-expanded`.

## APIs the next packages get

Import from `components/ix/dock` (barrel):

```ts
DockSlot                                  // the slot (IxFrame mounts it)
openAddServer(tab?: 'create'|'join'|'discover'); closeAddServer(); useAddServerStore   // open the sheet from anywhere
useGoToPlace(): (key: string) => Promise<void>   // 'people' or a server id; what a click and the shortcuts use
placeKeyAction(event, mac) / stepPlace(order, current, ±1) / nthServer(order, n)         // pure
```

Test ids and hooks (all `data-*` on the elements, for specs):

| What | Selector |
|---|---|
| the toolbar | `data-testid="ix-dock"` (`role=toolbar`, `aria-label="Servers"`) |
| a place | `data-testid="ix-dock-item"`, `data-place` (`people` or the server id), `data-kind`, `data-current`, `data-live`, `data-attention` (`dot` or `count`), `aria-current="page"`, `aria-label` = "Game Night, live, 2 mentions" |
| the add button | `data-testid="ix-dock-add"` (not a place: no `data-place`) |
| the indicator | `data-testid="ix-dock-indicator"` (one element) |
| the tooltip | `.ix-dock__tip[data-open]` |
| Web Animations | ids `ix-dock:indicator`, `ix-dock:ping` (for IX-18's gate) |

`useAddServer.ts` holds the rules the sheet and the older `CreateGuildModal` share (`inviteCodeOf`, `defaultServerName`,
`useGuildTemplates`, `useServerIcon`, `useAddServerActions`).

## Decisions and deviations

1. **Inactive marks use opacity .82 (spec §4.8), not the prototype's `filter: saturate(.75) brightness(.9)`.** The
   prototype's filter transitions (a motion-lint violation) and costs more on WebKitGTK. Measured on s4: an inactive mark
   body differs from the reference by 6-11 of 255 on a channel (F (102,49,58) vs (108,45,56); B (48,88,68) vs
   (37,87,63)); the current mark is pixel-identical. The `+` glyph reads a little brighter than the reference because
   IX-1's `--ix-ink-3` is .62, not .5 (IX-1 decision 1). Dock-region difference to `ref/` (s0, s1, s4, 316x66 crop):
   mean 0.5%, every difference in those two places.
2. **People never has a live dot.** The spec says "any room in that server"; a direct message call has no server, and the
   card (IX-7) shows it. A muted server still shows live (muting silences attention, not what is true).
3. **Unread and mentions come from `useUnifiedConversations`**, the model the sidebar's own signals use, which already
   gives a muted server and a muted channel no signals ("any unmuted channel has unread messages"). A thread reply counts as
   unread. People: a dot for any unread direct message; the chip counts friend requests plus direct-message mentions
   (a request is addressed to you, like a mention).
4. **Discover is always offered.** "When the instance has discovery on" has no client signal: `allow_discovery` in the
   server config is *federation* peer discovery, and `/discovery/guilds` is served by every instance (the Discover page
   already shows its own load error). If the owner wants a real flag, the server has to publish one.
5. **Clicking the place you are in does nothing** while you are in one of its conversations (a click must not throw you back
   to the landing channel; the prototype's `go()` returns early too); from its Overview, settings or another page it takes
   you to a channel; from a route that belongs to no place (`/app/discovery`) it goes to the server.
6. **`CreateGuildModal` stays** (HomePage and the Glass `PlacesPanel` still open it; IX-14 and IX-19 retire them) but now
   uses the shared hooks above, so there is one implementation of create / join / template. Its test and the vocabulary
   test pass unchanged. Delete it when its last caller goes.
7. **Place shortcuts work while typing**, which the old Ctrl+Alt+Up/Down did not (it sat under the editing guard). They
   also now include People (the old one skipped it and went to `/app/guilds/<id>`; it now goes to the landing channel).
8. **Files outside the row's list** (minimal, additive): `styles/tokens.css` (`--ix-tip`, the §6.11 tooltip surface,
   next to `--ix-pop`; IX-17 can reuse it) and `styles/ix-shell.css` (deleted the `.ix-dock-stub*` block, as IX-4 asked).
   The place keys' tests are in `hooks/useKeyboardNavigation.places.test.tsx` (new; the existing test file is untouched).
9. **No live-region announcement** ("Game Night is live", §10) here: it is IX-18's; the item's name carries the state
   ("Game Night, live, unread") and `ix-dock:ping` marks the moment.
10. Phone: the dock draws on the phone root as one working row (shot `dock-root@390x844.png`); the 64px bar, safe areas and
    44px targets are IX-16's. The item size is `--ix-dock-item` (42px) so IX-16 can set 44.

## Verification (commands run in `client/`)

- `npm run typecheck`: nothing from this package. It currently reports one error in IX-10's in-flight
  `src/pages/GuildHomePage.test.tsx` (`act` unused).
- Unit: `npx vitest run src/components/ix/dock src/hooks/useKeyboardNavigation src/components/guild/CreateGuildModal
  src/components/ix/shell src/components/ix/identity`: 175 passed. New: `dockModel.test.ts` (26: live per server, unread and
  mentions, labels, the ping edge rule, stepping, nth, key mapping, roving), `Dock.test.tsx` (32: order and test ids, current
  place, live/unread/count, the ping on transform/opacity only and never replayed, the glide keyframes and timing, cancel on a
  newer glide, the roving stop, tooltip timing, right-click -> `openServerMenu`, `+`, overflow fades and the wheel),
  `useDockEntries.test.tsx` (6), `usePlaceNavigation.test.tsx` (7), `AddServerSheet.test.tsx` (19), `useAddServer.test.ts`,
  `useKeyboardNavigation.places.test.tsx` (11).
- Full `npm run test:unit`: 4589 passed, 45 failed in 10 files, none from this package: `AppShell.test.tsx` (19, IX-9's
  `MenuHost` renders `DmPickerModal` against the unmocked relationship store; the test mocks `ix/dock`), `CommandPalette` (8),
  `EventList` (3), `GuildSettings` (5), `feedGlass` (5), `ServerSidebar` (1), `GuildPage` (1), `vocabulary` ("room" in IX-9 and
  IX-5 files), plus `stageTransition` and `useGlassKeybinds` (pre-existing at HEAD).
- `npm run test:tokens`, `npm run test:motion-lint` pass (no allowance added); `npm run test:contrast` passes;
  `npm run lint`: 0 errors, 212 warnings, none in this package's files. `npm run test:a11y:static` fails on IX-9's
  `user/UserProfile.tsx:600`, not on a dock file.
- e2e: `PARACORD_E2E_INDEX_SPEC=index-dock PARACORD_E2E_INDEX_PORT=4543 PARACORD_E2E_INDEX_RT_PORT=4545
  PARACORD_E2E_INDEX_WP=ix6 npx playwright test -c e2e/index-review.config.ts`: 21/21. At 1280x800 it measures the
  prototype's centers (S 33, F 92, G 140, B 188, + 236 at y 765; dock top 734, 66 tall; separator 1x24 at x 62; indicator
  16x3 centered under F, 7px from the bottom; dots at the spec's offsets and colors), the glide (550ms, spring,
  `transform` only), the ping (once, 1200ms, 2px ring, `scale(2.2)`; not on load, not for the current place), nothing
  running 2s after settling, the tooltip (400ms, centered, 12.5/600, lift 2px), the keyboard (roving, wrap, Enter, Ctrl+Alt
  and Ctrl+digit with the message box focused), right-click (IX-9's menu opens at the pointer; People has none), 12 servers
  (one 66px row, People and `+` fixed, fades, wheel, Ctrl+9 scrolls the 9th into view and the indicator follows, hides when
  scrolled out), reduced motion (no lift, no ping, 150ms fade), and the sheet (inside main, tabs, template create posts
  `{ name }` and lands on the new server, Join says "That invite has expired." and keeps the form, Discover opens the
  page, Esc returns focus, a route change closes it).
- `node e2e/index-compare.mjs ix6`: whole-frame means 2.44% (s0), 1.41% (s1), 4.39% (s4); the frame is dominated by what
  other packages own. I held the dock crop against `ref/` separately (above) and read the side-by-sides.

## Screenshots (`output/design-reference/index-build/ix6/`, gitignored; I read each)

`s0-quiet.png`, `s1-someone-arrives.png`, `s4-other-server.png` (+ `compare/`), `dock-s0-quiet.png`,
`dock-s1-someone-arrives.png`, `dock-s4-other-server.png`, `dock-s6-people.png` (the dock alone), `dock-tooltip.png`,
`dock-server-menu.png`, `overflow-12.png` and `overflow-12-scrolled.png` (+ `dock-overflow-scrolled.png`),
`add-a-server-{create,template,join,join-error,discover}.png`, `dock@1440x900.png`, `dock@900x700.png`,
`dock@390x844.png`, `dock-root@390x844.png`.

## Left for later packages

- IX-16: the phone bar (64px + safe area, 44px targets).
- IX-17: tooltips elsewhere can take `--ix-tip`; restyle the Discover page (IX-14) and `/app/templates` is now only reachable
  by URL (the sheet replaced its entry point; the route and `TemplateGalleryPage` still exist, IX-14 owns `App.tsx`).
- IX-18: the "is live" live region; add the dock's two animation ids to the gate.
- IX-14/IX-19: delete `CreateGuildModal` with its last caller.
- Drag-to-reorder and folders are a follow-up (spec §13).
