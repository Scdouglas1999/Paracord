# WP6 — Home: the street outside your servers

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §7.5 (the
surface), §8 (BuildingPlate / RoomThumbnail / NeedsYouRow / EventCard), §6 (the
kill-list), §9 (accessibility). IA and data:
[`docs/layout-spec.md`](../layout-spec.md) §1 "App Home", §3 (unified list +
Needs-you scoring), §6 (narrow rules). Depends on [WP0](./wp0-checkpoint.md) and
[WP1](./wp1-checkpoint.md). Branch: `design/lantern-stage`.

Home is now the reference render: a time-of-day word, one sentence of fact, the
Around-now well, **your servers brightest first**, what is coming up, and — on
the right — what needs you and what you can pick back up.

**The ranking and the data did not change. The presentation did.** Needs-you is
still `scoreEntry` over `useUnifiedConversations`; every light is still
`useBuildingLights()`; Coming up reads the scheduled events that already exist.
No endpoint was added.

---

## 1. Where things live

| File | Role |
|---|---|
| `client/src/pages/HomePage.tsx` | The page: the hooks, the two-column grid, and the actions. No copy, no light derivation. |
| `client/src/components/home/timeOfDay.ts` | The title word, its **boundaries**, the date line, the lights-on sentence, `shortAgo`. |
| `client/src/components/home/homeCaptions.ts` | Every phrase §7.5 asks for that WP1's `lightCaptions` does not already own. |
| `client/src/components/home/homeModel.ts` | The selections Home makes over WP1's models — ordering and picking, never deriving. |
| `client/src/components/home/HomeAroundNow.tsx` | The Around-now well. |
| `client/src/components/home/HomeBuildingCard.tsx` | **Both** server shapes: the lit wide card and the quiet compact row. |
| `client/src/components/home/HomeComingUp.tsx` | `EventCard` (§8) and the section that omits itself. |
| `client/src/components/home/useComingUp.ts` | Scheduled events across every server, merged and ordered; the one RSVP action. |
| `client/src/components/home/HomeNeedsYou.tsx` | `NeedsYouRow` (§8), the ranking (`homeAttention`), and the attention-preview machinery. |
| `client/src/components/home/HomePickUp.tsx` | "Pick up where you left off". |
| `client/src/components/home/HomeAddBuilding.tsx` | The add-a-server row. |
| `client/e2e/design-review.spec.ts` | The `PARACORD_E2E_DESIGN_WP=wp6` capture path (two scenarios). |

### Deleted, with the presentation they carried

`HomeAroundStrip` · `HomeJumpInRow` · `HomePickUpRow` · `HomeResumeHero` ·
`HomeServersRail` (+ its test) · `HomeSetupChecklist` · `HomeSectionHeader`.

Nothing outside `pages/HomePage.tsx` imported any of them (checked before
deleting), and the only non-presentational thing among them — `homeAttention`,
the Needs-you ranking — moved nowhere: it still lives in `HomeNeedsYou.tsx` and
still calls `scoreEntry`.

Four affordances went with them, all of them reachable elsewhere in the v2
shell: the Get-set-up checklist, the Jump-in / Start-something grid, the
"New message" header button, and the Your-spaces rail. §7.5 names what Home is,
and the servers column (WP2) is where navigation lives now. **"Add a server
— join with an invite, or start your own"** replaces the create/join affordance
and opens the same `CreateGuildModal` (its Create / Join / Template tabs).

---

## 2. The title and its sentence

```
Tonight   Saturday 12 September · 30 people have their lights on across your 2 buildings
```

The boundaries are written down once, in `timeOfDay.ts`, and pinned by tests:

| Local hour | Word |
|---|---|
| 05:00 – 11:59 | **Morning** |
| 12:00 – 17:59 | **Afternoon** |
| 18:00 – 04:59 | **Tonight** |

The night wraps past midnight deliberately: at 02:00 you are still in the
evening you started, and "Morning" would be a lie about the light outside.

The sentence never dresses a zero up as activity (§6.9): with nobody lit it
reads "nobody has their lights on across your 2 servers", and with no
servers at all "you have not joined a server yet" — never "No data".

---

## 3. A server has two shapes, and the shape is state

`isLitBuilding(building)` is `building.brightestRoom !== null` — a **lit voice
channel**. That is the whole condition, because the wide card exists to show that
channel's thumbnail, and there is no honest thumbnail without a channel to look into
(§6.4).

**Lit** — a `Plate lit` holding WP1's `RoomThumbnail height={176}` (LIVE dot,
frames when the media pipeline has them and a still plus the dot when it does
not), the occupant `AvatarStack`, what they are doing, and **Join in white
light** — beside a panel carrying the server's mark and name, `24 in · 1 channel
lit`, the `WindowMap scale="home"` (12×16 cells) and the server's lit text
channels with `5 reading · 1 mention for you`.

**Quiet** — WP1's `BuildingPlate` itself, as a compact row: mark, name,
window map, `6 in · quiet`, and the one text channel somebody is actually reading,
wrapped onto its own line.

Three decisions worth stating:

1. **The lit card is not a `BuildingPlate`.** `BuildingPlate` *is* a plate, and
   §4 forbids nesting one in another; the wide card is the plate, and it
   composes `WindowMap` + `Lamp` directly. The quiet row is a `BuildingPlate`,
   which is exactly what that component is for.
2. **The counts sit outside the window map.** `WindowMap` renders its caption
   inside a truncating flex box next to the cells; at 390px the cells win and
   the counts disappear. Home renders them as its own element after the map, so
   the server *name* truncates instead — the half a reader can afford to lose.
   The map keeps its own screen-reader sentence, and the counts are announced
   once.
3. **"quiet" is the one phrase Home adds to a server caption.** WP1's
   `buildingCaption` is reused verbatim whenever something is lit; the middle
   state — people in the server, no channel lit — has no WP1 wording, and
   `24 in · Dark · nobody in` contradicts itself. `6 in · quiet` is the
   reference render's own copy.

---

## 4. Needs you

`NeedsYouRow` is §8's `32px 1fr auto`: a lit avatar, the reason in Gabarito, one
line of context, and **one** action — Open, Reply or Accept. The row itself is
not a button: a row with an action inside it and a click target around it is two
targets pretending to be one.

Order: friend requests first (somebody is literally waiting on an answer), then
`homeAttention` — the unified list's own scorer, with pinned entries and the
sidebar's overflow folded back in, because pinning must never hide work.

The reasons are in the metaphor, and one of them is a correctness rule:

| Row | Reason | Action |
|---|---|---|
| mention | `Priya mentioned you`, or `3 mentions for you` when the author is unknown **or is you** | Open |
| direct message | the person's name | Reply |
| thread | `New replies in build-log` | Open |
| unread | `New in build-log` | Open |
| live channel | `Shop floor lit up` | Open |

The attention-preview machinery is kept whole from the previous Home — the
scoped request, the database-history epoch guard, the retry/reconnect control,
the refusal of a preview from another channel or another account, and the rule
that Home never decrypts a message in the background. Its tests came with it.

The lead is a `LitAvatar` when a person is attached (the DM's peer, or the
author the attention feed named) and a **window** otherwise. That window is
light only for a live channel: an unread text channel draws dark, because nobody has
told us anybody is reading it and a light with no source is the one thing this
design never draws (§0). *(The row this replaces lit an amber window for every
unread channel.)*

**The quiet state tells the truth.** It only says "Nothing is waiting on you
right now." once the activity behind it is known; while read-state or channels
are still loading it says so, and after a failure it says so and offers Refresh.
That distinction is the previous Home's, kept.

---

## 5. Coming up

`useComingUp` fans `GET /guilds/:id/events` — the same feed
`components/guild/EventList.tsx` renders inside a server — across every
server, keeps scheduled and active events (an event that started in the last
three hours is still "now"), orders them by start and caps the list at three.
The server's own event list is the full one.

- The fetch is keyed on the servers' **identities**, not on the array: a call
  running anywhere gives `useBuildingLights()` a new identity every second, and
  that must not refetch every guild's events once a second.
- A server whose events cannot be fetched contributes nothing rather than an
  error banner. The section makes no claim of completeness, and one unreachable
  server must not blank the events of the others.
- One action per card (§8): `I'm going` / `You're going`, `PUT`/`DELETE` on the
  existing RSVP route, and it dispatches the `paracord:scheduled-events-changed`
  event the server's list already listens for.
- **With nothing scheduled the section does not render.** An empty "Coming up"
  heading over a blank space is the "No data" of section headers.

---

## 6. Phone

One column, and the order is a priority, not a layout accident: **work somebody
is waiting on you for leads, then the servers, then what you can pick back
up.** When nothing needs you, the servers lead.

Mechanically the right-hand column is `display: contents` below `lg`, so its two
blocks take their own places in the single column and reflow into one column
again at `lg` — no component is rendered twice. The Around-now well keeps the
faces and the count on its first line and wraps the sentence under them instead
of squeezing it into a column.

---

## 7. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint . --quiet` | pass, 0 findings |
| `npx vitest run` | **252 files, 2279 tests passed** |
| `npm run build` | pass |
| `npm run test:contrast` | 49 checks × 4 themes passed |
| `npm run test:a11y:static` | pass |
| `npx playwright test` (mocked smoke) | see the note below |

WP6's own tests:

- `components/home/timeOfDay.test.ts` — the three words, every boundary
  (04:59/05:00, 11:59/12:00, 17:59/18:00), the sentence at one/zero/none, and
  `shortAgo`.
- `components/home/home.test.tsx` — the activity line's four branches, the
  server caption's middle state, the mention caption; the Around-now faces'
  ordering and de-duplication; **the lit card vs the quiet row**, Join in white
  light, the text-channel lines and their mentions, one window per channel; the
  Coming-up card's one action and its absence when empty; Pick-up's context,
  its window light, and its absence when empty; and the no-literal-colour
  assertion WP0 established.
- `components/home/useComingUp.test.tsx` — the merge and its ordering, the
  status/past filters, the channel name, one unreachable server, the cap, that a
  light tick does not refetch, and the RSVP round trip.
- `components/home/HomeNeedsYou.test.tsx` — the previous Home's whole
  correctness suite, re-pointed at the new rows: the corrupt-history path, the
  ranking, cross-account ownership, encrypted previews, a preview from the wrong
  channel, a late response after the activity changed, the held pointer/keyboard
  order, overflow, the read cursor, an absent mention target, the edit/delete
  mutation paths, and `@you` rewriting. Plus the new reason table, the
  self-authored mention fallback, the friend-request row, and the three quiet
  states.
- `pages/HomePage.test.tsx` — the title and sentence, the Around-now wiring,
  servers in the hook's order, Join going to the **channel** and not the
  server, opening a server, the add-a-server dialog, the once-ever
  channel/people load, Coming up present and absent, the Needs-you/Pick-up split,
  the unknown-activity guard, and the phone ordering.

### The mocked smoke

The suite is green **except** one assertion that belongs to WP2 and is failing
on the shared tree independently of this package:

```
e2e/smoke.spec.ts:698
  building.getByRole('option', { name: /QA Guild lobby/i })
```

The sidebar renders that option as `"QA Guild With A Very Long Name That Should
Truncate Instead Of Breaking Layout lobby — Dark · nobody in"`, so the regex
never matches this fixture's deliberately long guild name. With that one locator
relaxed locally, **the whole smoke passes, including WP6's Home block**, and the
file was restored untouched afterwards. WP2 owns the fix.

WP6's own changes to the smoke keep its intent and update it to this surface:
`/app` is now recognised by "Your servers"; the Needs-you region still proves
that unread work outranks quiet copy (`3 mentions for you`, the preview, both
servers by name, no "is quiet" / "No data" / "Nothing is waiting on you"), no
horizontal overflow at 320/390/768/1280, and the row's one action still
navigates to the conversation it names.

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp6 npx playwright test e2e/design-review.spec.ts
# → output/design-reference/wp6/ (gitignored)
```

Two scenarios × two viewports (plus a full-page phone frame), all inspected
against `output/design-reference/Home.png`:

- `home-lit-evening-{1440x900,390x844,390x844-full}.png` — 21:30, a lit voice
  channel with a screen share, 24 lights on in one server and 4 in the other, an
  event tonight, a mention, a friend request.
- `home-quiet-morning-{1440x900,390x844,390x844-full}.png` — 08:30, the same two
  servers with nobody in.

Five things the screenshots caught and fixed:

1. **The Around-now well squeezed its sentence into a column at 390px.** The
   faces and the count now hold the first line and the sentence wraps under them.
2. **A quiet server's counts vanished at 390px**, truncated away inside the
   window map's caption box. They are rendered outside it now (§3, point 2).
3. **"last message now ago."** `shortAgo` returns "now"; Pick-up now says "last
   message just now".
4. **"+1 lights on" beside "Nobody's lights are on right now."** The overflow
   count is dropped when there are no faces to overflow past — the sentence
   already carries the fact.
5. **The activity line was truncated to "Mara Okafor is shari…"** beside the
   occupant stack on a 300px frame. Real display names are not four letters, so
   the line now sits above the stack instead of beside it.

Two things the harness cannot stage, stated so nobody reads the frames as a
product gap:

- **Amber "reading" light.** The mocked realtime stream is a finite SSE body:
  `connectionManager` drops any dispatch that arrives before a READY has taught
  the connection its history epoch (and tears the transport down for it), so
  only what rides *inside* READY survives — voice states and presences, via
  READY's own guild payload. Typing has no such carrier, and reading is derived
  from typing / authored / self-viewing (WP1 §3). The reading line and its
  mention count are covered by `components/home/home.test.tsx` instead.
- **Live thumbnail frames.** No media engine runs in the mocked suite, so the
  thumbnail is a still plus the LIVE dot — which is the honest `no-engine` state
  from WP1's table, not a degraded video path.

---

## 8. Left for later

- **The server name is no longer on a Needs-you row.** The row shows the
  server instead, which is what the reference render does and what the
  one-line context can carry. Two connected servers with identically named
  servers are ambiguous on this surface; the fix belongs with cross-server
  identity (WP1's "left for later"), not with a fourth line of meta.
- **Members are fetched per server on Home.** `lightsOn` — the "24 in" and the
  title's sentence — is counted from the server's members, so Home loads them
  once per server per session (the store dedupes). If the servers column
  ends up loading them too, one of the two call sites can go.
- **A text channel with a mention but nobody reading is not listed on a lit card.**
  §7.5 says "its lit text channels" and this follows it; the mention is still on
  the Needs-you row and in the server's window map. Worth revisiting if the
  card reads as empty in practice.
