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
