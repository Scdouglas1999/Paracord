# WP2 — The Servers column

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §7.1, §3, §6,
§8, §9; IA from [`docs/layout-spec.md`](../layout-spec.md) §5 (keyboard) and §6
(narrow). Depends on [WP0](./wp0-checkpoint.md) and [WP1](./wp1-checkpoint.md).
Branch: `design/lantern-stage`.

Everything here is checkable in one place: run the client and open
**`/design-tokens` → "Servers column"** (dev builds only). The column is
rendered there in the four states worth reviewing — a Lobby open, a text channel
open, you in a call, and an account with no servers — from real
`lib/attention` models, not hand-written props. If a row looks wrong on that
page, the light is wrong, not the row.

---

## 1. What replaced what

| Deleted | Replaced by |
|---|---|
| `sidebar/AnchorNav.tsx` (Home / Friends / Messages) | the two `NavRow`s at the top of `BuildingsColumn` (§7.1 draws Home and Messages; see §4 below for where Friends went) |
| `sidebar/NeedsYou.tsx` | nothing in the column — **Needs-you lives on Home now** (§7.1). The column keeps the **count**, as the white-light chip on the Home row |
| `sidebar/PinnedRail.tsx` | nothing. `pinnedStore` survives (`useUnifiedConversations` still reads it), but no UI has ever written a pin — `pin()` is called only from tests — so the rail rendered a store nobody could fill |
| `sidebar/RecentList.tsx` | the per-server channel rows. A channel you were in is a channel in its server, not a separate "recent" list |
| `sidebar/SpacesList.tsx` | `BuildingSection` — the section label, the window-map plate and the channels. Its **context menu** (mute / mark read / settings / leave) moved to `UnifiedSidebar`, which is still the only writer of the account-owned muted set `useMutedGuilds` reads |
| `sidebar/VoiceChannelOccupants.tsx` | `RoomThumbnail`'s occupant stack on a lit channel row |
| `layout/UserPanel.tsx` (+ test) | `sidebar/AccountPlate.tsx` — see §5 |
| `sidebar/SidebarSearch.tsx` (input recipe) | rewritten onto the well recipe, 38px, with a `Kbd` shortcut hint |

**Kept, untouched:** `sidebar/ConversationRow.tsx` (DMPage and Home's pick-up
rows still use it), `sidebar/CallDock.tsx` (WP3 re-pointed it at their
`OnAirDock` while this package was in flight; it still renders only while a call
is running, directly above the account plate).

### New files

| File | Role |
|---|---|
| `sidebar/BuildingsColumn.tsx` | The column, **presentational**. Takes `BuildingLight[]` and callbacks; owns only view state (which servers are unfolded) and the flat roving-tabindex numbering. |
| `sidebar/BuildingSection.tsx` | One server: `SectionLabel` + the `BuildingPlate` (the Lobby link) + its channel rows + the expander. |
| `sidebar/RoomRow.tsx` | The three row shapes, plus `LiveRoomRow`, the one row that touches WP1's read-only frame tap. |
| `sidebar/AccountPlate.tsx` | "sam.douglas · Lights on" + the account menu. |
| `sidebar/CollapsedRail.tsx` | The 64px rail (layout-spec §6), extracted from the old `UnifiedSidebar`. |
| `sidebar/UnifiedSidebar.tsx` | Now purely the **container**: hooks in, models out. |

---

## 2. The column, top to bottom (§7.1)

```
  SearchWell (⌘K)                     a button on the well recipe, 38px
  Home        · count chip            white-light ink — the Needs-you number
  Messages    · count chip            unread DMs and group DMs
  ── per building, brightest first ──
  "Kestrel Robotics"        "24 in"   SectionLabel, sentence case
  BuildingPlate                        window map + "2 rooms lit · 3 reading";
                                       lamp only when lit; opens the Lobby
  lit voice room                       RoomThumbnail 64px + LIVE dot +
                                       occupant stack + "you're here" / "3 talking"
  dark voice room                      NavRow + dark window dot;
                                       "Dark · nobody in" on hover / focus
  text room                            NavRow + amber or dark window dot +
                                       "5 reading" (or a mention chip)
  "N more rooms"                       only when there are more
  ── ─────────────────────────── ──
  Add a building
  CallDock (only in a call) · AccountPlate
```

Ordering is `useBuildingLights()` — brightest server first, and inside a
server the channels are in WP1's window order (lit voice, dark voice, then text by
readers). **Nothing in WP2 re-derives a light.** The only thing the container
merges on top is unread / mention state, and it can do that without a second
resolution pass because a `ConversationEntry.key` and a `RoomLight.key` are both
`entityScopeKey(scope, channelId)`.

Geometry is lifted from the reference renders (`output/design-reference/{Main,Lobby,Channel,Home}.html`):
276px of column on a 12px street gutter (`--w-buildings-column` + `--gutter`
twice), 34px rows, 8px window dots, a 64px thumbnail, 10×13 windows at 5px gaps
in the map, the account plate at 32px avatar + name + caption.

---

## 3. Decisions

### The active row is raised, and the active server is outlined

§7.1 says "active row = raised", and `NavRow active` already is
(`--bg-raised` + the warm top highlight). The **plate** could not take the same
treatment: `pc-plate` sets its own background and shadow from an unlayered
stylesheet, so a Tailwind utility cannot override either. The reference render
rings the open server's plate in warm light — but a light token asserts that
somebody is in there (§6.3), and "you have this Lobby open" is not presence. The
open server gets a 1px `--border-strong` **outline** offset 2px instead, plus
`aria-current="page"`. Outline is free: WP0's focus ring is a box-shadow.

### The server plate keeps its caption when its Lobby is open

`Lobby.html` swaps the caption to the word "open" while the plate is
highlighted. The outline and `aria-current` already say that, and
"2 channels lit · 3 reading" is the more useful half — so the caption stays.

### Friends left the column

§7.1 and all four reference renders draw exactly two anchor rows, Home and
Messages. Friends is not orphaned: Home renders the pending-request rows and the
"N friend requests waiting" line, `MobileBottomNav` keeps its Friends tab, and
⌘K reaches `/app/friends`. The old friend-request badge lived on the Friends
row; the requests themselves are on Home, where the list is.

### Long lists: eight channels, then a row; eight servers, then an accordion

- **Channels.** A server draws at most **8** channel rows and folds the rest into
  "N more channels". Channels arrive lit-first from `buildingLight`, so nothing lit is
  ever behind the fold.
- **Servers.** Past **8** servers the column becomes an accordion: a
  server that is dark *and* not the one you are in draws its label and its
  window map — which still shows every channel's light and its overflow count — and
  its channels wait behind one click. Twenty dark servers cost forty rows instead
  of two hundred.

Virtualizing was the alternative and was rejected: the column is one roving
listbox with a flat `data-nav-index` order (layout-spec §5), and a virtualized
list makes both the arrow-key order and the screen reader's row count lie about
what exists. A window map already summarizes a folded server, which a
scrolled-past row does not.

Both bounds are one piece of state (`openBuildings`), and both expanders are
rows in the same roving order.

### Unread lifts the ink; mentions get a chip

The window dot is already the row's light. A second dot beside it would say two
different things in the same place, so an unread channel lifts its name to
`--text-primary` and a mention shows an accent `Chip`. A mention chip outranks
the channel's own caption in the trailing slot.

### "Dark · nobody in" is in the DOM, always

§7.1 puts it "on hover/secondary line". It is rendered `sr-only` unconditionally
and fades in on hover or keyboard focus — §9 does not allow the words to be the
hover's secret.

### The search well is a button

WP0's `SearchWell` is a real `<input>`. In this column it would trap focus in a
reopen loop with the Command Palette it summons (the palette takes focus and
returns it on close, which reopens the palette). The column's search wears the
`pc-well` recipe on a `<button>` with the same geometry and a `Kbd` hint.

---

## 4. Keyboard and narrow behavior (layout-spec §5, §6)

- One `[data-roving-container]`, one Tab stop. Every row carries
  `data-nav-index` in DOM order — Home, Messages, then per server the plate,
  its channels and its expander, then "Add a server" — and the shared handler in
  `useKeyboardNavigation` moves with ↑/↓/Home/End. The Tab stop prefers the open
  Lobby, then the open channel, then the active anchor, then Home.
- ⌘K opens the palette from the search well (`aria-keyshortcuts`), Escape
  precedence is unchanged, Ctrl+B still collapses.
- Collapsed (64px): the servers survive as their marks, each carrying the
  brightest window it has lit, with the caption in the button's accessible name.
  Its own roving container, one Tab stop.
- Narrow: unchanged from §6 — the column is a full overlay on a phone, never the
  rail, and `AppShell` still owns the overlay, the swipe and the focus trap. No
  AppShell edits were needed; the column sets its own 12px gutter so the street
  reads correctly without touching the main pane other packages are restyling.

---

## 5. The account plate replaced the user panel

`UserPanel` was mounted by nothing but the sidebar footer, and §7.1 redraws that
footer, so it was replaced rather than restyled. Everything it could do
survives, one plate and one menu instead of a row of icon buttons:

| `UserPanel` | `AccountPlate` |
|---|---|
| avatar + presence ring | `LitAvatar` on `personLight` |
| status label | the caption — "Lights on", "Away", "Do not disturb", "Lights off", or your custom status |
| status picker | the menu's four `menuitemradio` rows, with the light swatch |
| custom status field | the menu's field |
| copy username (click and right-click) | the menu row, and right-click on the plate |
| mute / deafen buttons | the menu's two `menuitemcheckbox` rows — **and the caption**, which reads "Lights on · muted" / "· deafened" so the state is still visible without opening anything |
| settings button | the settings `IconButton` on the plate |
| admin dashboard button | the menu row, same flag gate |

---

## 6. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | no finding in `components/layout/**` or `pages/DesignTokensPage.tsx` |
| `npx eslint --quiet src/components/layout/sidebar src/pages/DesignTokensPage.tsx e2e/` | pass, 0 findings |
| `npx vitest run src/components/layout/sidebar` | **4 files, 37 tests passed** — `BuildingsColumn`, `UnifiedSidebar`, `AccountPlate`, `ConversationRow` |
| `npx vitest run` | 2 084 passed; the 8 failing files are WP4/WP5/WP6 files mid-flight (`components/message/*`, `components/home/*`, `pages/HomePage`), none of them WP2's |
| `npm run test:contrast` | 49 checks × 4 themes passed |
| `npm run test:a11y:static` | no WP2 finding (three open findings are WP4/WP5/WP6 files) |
| `npx playwright test` (mocked smoke) | see §6.1 |
| `npm run build` | see §6.1 |

### 6.1 Two gates blocked by concurrent packages

At the time of writing, four other packages are editing this worktree. Two
whole-tree gates cannot go green from WP2's side alone:

- `npm run build` fails in `src/components/message/messageLight.ts`
  (`dmRoomName` declared twice) — WP5's file, mid-edit.
- `npx tsc --noEmit` reports findings only in `components/message/*`,
  `components/rooms/lobby/*`, `pages/AppShell.tsx` and
  `pages/guild/VoiceStageChannel.tsx` — WP3/WP4/WP5 files.

Both were re-checked immediately before the WP2 commit and are unchanged by it:
deleting the old sidebar left no dangling import anywhere in the tree
(`grep` for `UserPanel`, `SpacesList`, `RecentList`, `AnchorNav`, `PinnedRail`,
`VoiceChannelOccupants` finds only prose in comments, listed in §8).

### 6.2 Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp2 npx playwright test e2e/design-review.spec.ts
# → output/design-reference/wp2/ (gitignored)
```

Twelve frames at **1440×900 and 390×844**: `column-{lobby,room,call,empty}` from
the tokens page, and `app-{lobby,room}` with the column in situ beside a real
main pane (on a phone the column is opened through the header control where the
route offers one, which is the honest §6 behavior). The desktop in-situ pass
also **asserts the exact selectors the mocked smoke uses** for the column
(`listbox "Buildings and rooms"` → `group "<building>"` →
`option "<building> lobby"`), so a rename cannot slip through while the smoke is
red for an unrelated package — which it currently is, at WP5's composer and
header copy (`Message #…`, `Pick up a conversation`, `Member List`), nine steps
before the sidebar assertion. 82 of the smoke's 84 checks pass.

---

## 7. Held against the reference renders

`output/design-reference/{Main,Lobby,Channel,Home}.png`, left column:

- **Rim strength.** The plate's lit ring is WP1's `--ring-lit-plate`; a dark
  server drops to the quiet tile highlight, exactly as `Main.html` draws the
  second server.
- **Thumbnail height.** 64px, the reference's `.thumb` height for a sidebar row,
  with the LIVE dot at 8px from the top-left and the occupant stack at 8px from
  the bottom-right.
- **Gaps.** 2px between rows, 6px under the plate, 16px above a section label
  (WP0's `SectionLabel` padding), 12px of street on every side of the column.
- **Truncation.** Every name is in a `truncate` span; a caption never wraps and
  never pushes the name — the trailing slot is `shrink-0` and the name owns the
  remaining width.

---

## 8. Left for later

- **WP3** owns the call surface. `sidebar/CallDock.tsx` still lives in this
  folder and now renders WP3's `OnAirDock` (their edit, landed while this
  package was in flight, so it is not part of WP2's commit); if WP3 moves the
  on-air pill into the header for good, the dock and its slot in the column
  footer should go with it (§7.1 draws only the account plate at the bottom).
  `UnifiedSidebar.test.tsx` stubs `./CallDock` for exactly that reason — the
  column owns the slot, not what sits in it.
- **WP8 sweep**: three stale prose references to deleted components survive in
  files this package does not own — `stores/pinnedStore.ts` ("`PinnedRail`
  renders entries"), `hooks/useUnifiedConversations.ts` ("so `SpacesList` can
  route"), `pages/GuildSettingsPage.tsx` ("opened from GuildHomeHeader /
  SpacesList"). Also `sidebar/CallDock.tsx`'s collapsed variant still paints
  `bg-accent-tint` and `ring-bg-secondary`.
- **Pinning.** `pinnedStore` is now read by `useUnifiedConversations` and drawn
  by nobody. Either a surface gains a pin affordance or the store goes; deleting
  it was out of WP2's scope because the hook's contract is shared.
- **Live sidebar thumbnails** are live only for the channel you are actually in —
  that is WP1's honest table, not a gap. Every other lit channel is a still plus
  the LIVE dot, and the reason is named in the model.
