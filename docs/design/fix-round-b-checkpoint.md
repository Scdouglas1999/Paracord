# Fix round B — the Lobby, the Stage and touch

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §6 (kill-list),
§7.2 (Stage), §7.3 (Lobby), §8 (component recipes), §9 (hit targets).
Triage: group **B** of the QA fleet's open items (B1–B8), from
`output/qa-ui-desktop/REPORT.md`, `output/qa-ui-phone/REPORT.md` and
`output/qa-messaging/REPORT.md`.

Screenshots: `output/fix-round-b/` — `before/` is the release candidate as the
reviewers found it, `after/` is the rebuilt binary. Both were taken against a
real `paracord-server` on port 18340, seeded with two buildings, four dark voice
rooms, five text rooms and three accounts, at 1440×900 and 400×844, in Night and
Daylight.

---

## B1 — a dark room is a dark window, not an empty screen

### What was wrong

`output/fix-round-b/before/desk-lobby.png`,
`output/fix-round-b/before/phone-lobby.png`.

Every never-lit room reserved the lit card's full §8 `RoomThumbnail` — 168px of
window well — and filled it with nothing. The Lobby of a quiet community was
three or four identical ~250px voids plus an equally tall "Open a new room"
tile; on a 400×844 phone two cards and the header were the entire screen, and no
text room was above the fold. It read as broken images, which is the one thing
kill-list #4 asks a frameless tile never to do, and four of them side by side
are exactly the "identical-card tiling" #8 forbids.

§7.3 never asked for that well. It asks a dark room for four things: the name,
"Dark · nobody's in", "last lit 2 h ago", and Open.

### The sketch

A lit card is 250px because it is carrying a picture of people. A dark room has
no picture, so it is the height of its own words:

```
┌──────────────────────────────────────────────────────┐
│  ┌────┐                                              │
│  │▪ ▪ │   Quiet room                        [ Open ] │   68px
│  │▪ ▪ │   Dark · nobody's in · last lit 2 h ago      │
│  └────┘                                              │
└──────────────────────────────────────────────────────┘
   40px      name (display, secondary ink)     ghost + hairline
   façade    one meta line — §7.3's three facts, joined
```

Four decisions, each of them a rule rather than a taste:

1. **The mark is the room's façade, not an icon.** Four unlit panes built from
   `pc-window` — the same object the sidebar's window map, the building plate
   and the text-room rows use — inside a small recessed well. A dark room is
   marked with the same thing everywhere it appears, and the mark can never
   light: `DarkWindowMark` is only ever rendered for a room that is dark, so
   there is no state in which it glows without somebody behind it (§0, §6.1).
2. **A matte plate, not a well.** `--bg-plate` with a hairline
   (`--border-subtle`), hovering to `--bg-raised`. A recessed well is what a
   picture sits in, and a recessed *empty* well is what the defect looked like.
   No light token is spent at any interaction state (§6.3).
3. **Three facts on one line.** "Dark · nobody's in · never lit" replaces a
   caption at the top-left of a black rectangle, a "never lit" at the far right
   and a repeated invitation underneath. The invitation — "Turn the lights on —
   friends see it instantly", four times down a column — is gone with the
   constant; an offer repeated on every card is decoration.
4. **Two grids, not one.** The Lobby now draws lit cards in their own grid and
   dark rooms in a denser one beneath. In a single grid CSS stretches every
   dark card in a row up to the lit card beside it — which would have re-created
   the empty rectangle the moment one room lit up. `AddRoomTile` moved into the
   dark grid and matches its height for the same reason.

Both grids use the same column rhythm (`1 / sm:2 / xl:3`), so the surface reads
as one building whether its rooms are lit or dark, and the Lobby still mixes
three kinds of object — a lit card, a dark card, an add tile (§6.8).

### The result

`output/fix-round-b/after/desk-lobby.png`,
`output/fix-round-b/after/desk-lobby-daylight.png`,
`output/fix-round-b/after/phone-lobby.png`,
`output/fix-round-b/after/phone-lobby-daylight.png`.

A dark card is **68px** instead of ~250px. At 1440×900 four dark rooms and the
add tile occupy two rows, and the whole building — header, Around now, every
room, every text room with its last line — is on screen at once with room to
spare. At 400×844 all four rooms, the add tile and the first three text rooms
are above the fold, where before the screen held two empty rectangles.

---

## B2 — a text room row says who spoke last, and what they said

§7.3 asks each text room row for "window dot, name, **last author · time,
preview**, reader stack, mention chip". The rows had the dot, the name and a
stamp. The other half was missing because the Lobby could only read the
timelines the message store happened to be holding — a building you had not
read through was a column of bare names, and a room nobody had ever written in
was a name and three blanks, which reads as a row that failed to load.

`useRoomPreviews` opens a second, read-only door: one `limit=1` request per
room, at most twelve rooms, once per room per session, two at a time, cached.
It does **not** go through `messageStore.fetchMessages`, which aborts every
other channel's in-flight fetch when it starts — five rooms at once would cancel
four of them and race the open room's own history. It refuses ciphertext, and a
room it could not read keeps the name and stamp it already had.

A room with nothing in it says `Nothing said here yet`.

Two parts of B2 were **not** defects:

- The reader stack and "N reading" are implemented and presence-driven; the
  reviewer's building simply had nobody reading.
- The two-column flow is **row-major**, and the DOM order matches the visual
  reading order (left to right, then down). The reviewer read down the columns.

`output/fix-round-b/after/desk-lobby.png`.

## B3 — Around now shows the faces the count is talking about

The well drew no faces beside a bare "+1 lights on" chip at the far edge, ~800px
from the sentence it belonged to. Two causes: the faces came from
`useBuildingPeople`, which only knows who is *in a room*, while the count comes
from `building.lightsOn`, which knows everybody — so with somebody signed in but
in no room the picture and the number disagreed about the same person; and the
sentence carried `flex-1`, which pushed the count to the opposite edge.

The well now reads `building.people` and shows anybody who is lit **or** visibly
in a room, people in rooms first — they are who the sentence names, and a stack
that overflows the names it is printing is worse than no stack. The count sits
with the sentence. `HERE_NOW_MAX_FACES` (5) replaces a local 6.

The motion gate's "leaving is the mirror" case now asserts a departing face
leaves the **room**, not the page: their lights are still on, and the well is
about who is around.

## B4 — the room fills the Stage on a phone

One person, nobody sharing, 400×844: the tile stopped 198px down and ~390px of
empty plate sat between it and the control bar. The phone layout hands the
speakers their whole remaining region (measured: 579px), but `renderSpeakers`
wrapped them in a flex column with no height of its own, so it shrank to its
content. `h-full`; the desktop grid cell stretches its child either way.

The control bar still wraps to two rows at phone width and cannot do otherwise
— six controls at 50px with two split-button chevrons are 378px of ink before
any gap, against 376px of usable width — but both rows are centred on the
viewport (54–346 and 133–267 in 400px), which §7.2 asks for and the reviewer had
seen break. `output/fix-round-b/after/phone-stage-joined.png`.

## B5 — a thumb can hit the controls a thumb has to hit

`pc-touch` (primitives.css) keeps a control the size the design asked for and
carries its *hit area* out to 44px with a pseudo-element — the technique the
message-actions chip already uses — on coarse pointers only. It is on Button's
`sm` and `md`, the Lobby's text-room rows and the Friends filter chips.

A stacked row cannot borrow the space around it, so `--h-nav-row` grows to 44px
inside the phone token block, beside the controls and radii that already round
up there.

Measured at 400×844 with a coarse pointer: text-room rows 344×44 (ink 39), Open
50×44 (ink 28), Invite 44×44 (ink 38), Friends chips ×44 (ink 32), Settings rows
352×44. `elementFromPoint` at the four edge midpoints of each 44px box resolves
to its own control, including the IconButton 6px from Invite.

**Not fixed, on purpose:** the Stage's split-button chevrons (28×50). They are
welded to the mic and share buttons, so any hit area they grow is taken off the
control they are attached to. Fixing them means changing what the phone control
bar holds.

## B6 — the Delivered receipt stops being painted behind the message

`-mt-4` pulled the receipt a line up into the row above it, and the timeline's
rows are absolutely positioned — so they paint over any static element that
follows them, whatever the DOM order. With an attachment card last, the card's
background took the top 5px of the word: "Jelivered". Now `relative -mt-1 pb-5`.
Measured: 0px overlap at both widths, and `elementFromPoint` on the word returns
the receipt. `output/fix-round-b/after/{desk,phone}-delivered-receipt.png`.

## B7 — three sentences that were not telling the reader the truth

1. Losing send permission said the same thing twice, stacked. The blocker banner
   above the composer is already saying it and carries the way out, so the red
   echo is gone — except before the banner has settled, where the send still
   reports the reason rather than doing nothing silently.
2. The GIF picker said "GIF search is offline" with a "Try again" on a server
   that simply has no Tenor key. A 503 now reads "GIFs are not set up here" and
   offers no action; a real failure keeps both.
3. A reply whose parent was deleted said "Message not loaded", the string for a
   parent merely older than the window. `messageStore` remembers the ids it
   watched leave (bounded), and the chip says "This message was deleted". A
   parent deleted before this client saw it still reads "Message not loaded",
   which is honest once nobody knows.

`output/fix-round-b/after/desk-{permission-lost,gif-unconfigured,reply-to-deleted}.png`.

## B8 — a toast stops landing on the phone's navigation

Toasts were pinned to `bottom-4 right-4` of the viewport; on a phone the bottom
49px belong to the tab bar, and nothing cleared the home-indicator inset.
`MobileBottomNav` measures itself into `--h-mobile-nav` while it is on screen
(0px everywhere else, including ≥768px where it is `display:none`), and the
stack starts above that plus the safe-area insets on all four sides.

Measured: 400×844 toast bottom 779 against a nav top of 795; 1440×900 unchanged
at 16px. `output/fix-round-b/after/{phone,desk}-toast-placement.png`.

---

## Gates

`npm run typecheck`, `npx vitest run` (260 files, 2483 tests), `test:tokens`,
`test:a11y:static`, `test:contrast`, `npm run build`, `npx playwright test` (86
passed) and `npm run test:motion` (22 passed, 6 opt-in skips) all pass.

The last two were **red before this round started**, for reasons outside it:
`685a6bf` stopped the anonymous bootstrap refresh that both suites relied on for
their session, and `21fb6de` settled the product's vocabulary while the mocked
smoke still asserted the old word in five places. Both are repaired in the test
code only (`test(e2e): the mocked suite and the motion gate go green again`);
bisection pins the first to `685a6bf` exactly.
