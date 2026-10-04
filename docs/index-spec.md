# Index — Paracord's interface

This is the contract for the "Index" interface, approved by the owner on
2026-10-04 after five rounds of review. It succeeds Glass
([`glass-spec.md`](glass-spec.md)). Where this document and the reference
prototype disagree, the prototype wins on look and this document wins on
behavior, accessibility and performance.

Reference material (in `output/design-reference/index/`, gitignored):

| File | Shows |
|---|---|
| `paracord-index.html` | Interactive prototype: 1280×800 app stage scaled to fit. Step button drives the story; dock, channels, room card (Join / Open call / Back to chat / Leave), "Plan a night", the message box (type and press Enter) and the busy channel's scroll are live |
| `s0.png` | Quiet: a new server (Fuel), `general` opens on "Fuel is ready" with three action cards |
| `s1.png` | Someone arrives: the live room card appears at the top of the sidebar, `clips` gets an unread dot |
| `s2.png` | Joined: the card becomes your call card with controls |
| `s3.png` | The call open over the main column, grown out of the card |
| `s4.png` | Another server (Game Night) while still in Fuel's call: your call card pinned on top with its server name, Game Night's own live card (someone streaming: "Watch Vincent") below its header |
| `s5.png`, `s6.png` | Busy Fuel (five in the call, grouped bubbles, time dividers); People with a DM open |

The prototype's names, messages and hues are placeholders. Real avatars and
server icons replace the monograms when they exist; nothing here should be
tuned to the placeholder data.

**Code names.** New Index code uses the prefix `ix`: components under
`client/src/components/ix/`, styles in `client/src/styles/ix-*.css`, CSS classes
`ix-*`, e2e files `client/e2e/index-*.spec.ts`. The layout store stays
`stores/glassStore.ts` (it already owns stage, sheet and screen state; Index
changes its fields, §7.1). Glass modules that Index keeps (stage internals, sheets,
cards, clips, reactions) keep their `glass` paths; renaming them is churn with
no user value and would collide with the parallel native-video branch. The
stored theme ids `glass` and `glass-contrast` stay as opaque wire values (they
mean "the dark look" and "the high-contrast look"); no migration.

**Words.** "Place" in this document means "the server or People view the
sidebar shows"; it is never UI copy. The UI says servers, channels, rooms (the
approved label for voice channels in the sidebar), People and instance.

---

## 1. Principles

1. **The sidebar is the server, organized around what's happening.** Top to
   bottom: who you are with right now (the live room card), what was said
   (channels with their last line), where else you could go (rooms), and every
   other place you belong (the dock).
2. **Quiet at rest, alive on events.** Nothing moves unless something
   happened: someone arrived, spoke, posted, went live, or you acted. No idle
   loops, no breathing glows, no floating marks. The only continuous motion is
   the talking waveform, and only while someone is actually talking.
3. **Calm, not barren.** Empty places offer the next good action ("Fuel is
   ready" with three cards), previews show what each channel is up to, and
   counts say who is here. Never a blank pane with nothing to do.
4. **Amber means live; white means it's for you; cream is the one action.**
   Amber: live rooms, talking, the live dot. White: unread dots and mention
   counts. Cream (`#f4f2ed`, dark text): Join / Watch, Post it, Send with text,
   your own bubbles. One cream button per surface.
5. **Not Discord.** No server icon rail (the dock is horizontal, at the foot,
   inside the sidebar). No uppercase TEXT/VOICE sections, no `#` glyph lists,
   no voice occupants nested under a channel row, no "voice connected" panel in
   a corner, no server name with a dropdown chevron, no "This is the start of
   #x". Section labels are sentence case ("Channels", "Rooms").
6. **Symmetry.** Sibling surfaces share geometry. The sidebar and main column
   are both flush inside the window, separated by a hairline; overlays inside
   main (call, sheets) share one inset (10px) and one radius (24px).
7. **Flat tonal identity.** Avatars and server marks are flat tonal fills with
   a lighter same-hue letter and a hairline. No glossy radial "bubbly"
   monograms, no glows around faces, no bobbing.
8. **One path.** Every capability has one deterministic implementation; errors
   are loud (a visible error state with a retry), never a silent downgrade.
9. **CPU is a design constraint.** On the WebKitGTK desktop the app at rest
   costs about 5% of one core. Only `transform` and `opacity` animate
   (`npm run test:motion-lint`); no registered custom property animates on a
   root; no `backdrop-filter` over scrolling content.

---

## 2. Tokens

All values live in `client/src/styles/tokens.css` (the Index block replaces the
Glass block) so `npm run test:tokens` (literal-color audit) keeps passing. JS
passes numbers (hues), never color strings.

### 2.1 Ground and ink

| Token | Value | Use |
|---|---|---|
| `--ix-ground` | `#0c0d0f` | Window behind everything |
| `--ix-main` | `#0e0f11` | Main column base |
| `--ix-side-end` | `#111215` | Sidebar gradient end, dock, rings that "bite" (dot rings) |
| `--ix-ink` | `#f2f3f5` | Primary text, unread dot, dock indicator |
| `--ix-ink-2` | `rgba(235,238,242,.74)` | Secondary text, read channel names, people rows |
| `--ix-ink-3` | `rgba(235,238,242,.62)` | Tertiary: previews, times, labels, placeholders. Must pass 4.5:1 on every surface it sits on at every server hue; `scripts/contrast-audit.mjs` sweeps hues 0–359 in 15° steps. If any pair fails, raise the alpha for all (never per surface) and record it here. **Recorded by IX-1: the prototype's .5 fails (others' bubble 4.34, event card 4.23, the selected row 4.11 at hue 0); .62 is the smallest step that passes every surface at every hue (the selected row near the top of the list at hue 60 needs .615)** |
| `--ix-line` | `rgba(255,255,255,.08)` | Hairlines |
| `--ix-fill` | `rgba(255,255,255,.06)` | Quiet controls, tool chips |
| `--ix-fill-2` | `rgba(255,255,255,.10)` | Hover of quiet controls |
| `--ix-bubble` | `#26272b` | Others' bubbles |
| `--ix-card` | `#2a2b2f` | Event, poll and file cards in the conversation |
| `--ix-cream` | `#f4f2ed` | The one action, your bubbles |
| `--ix-cream-ink` | `#141414` | Text on cream |
| `--ix-cream-press` | `#e8e3d8` | Cream pressed |
| `--ix-amber` | `#ffc27e` | Live, talking |
| `--ix-amber-rgb` | `255,170,90` | Live card tints (`rgba(var(--ix-amber-rgb), a)`) |
| `--ix-danger-ink` | `#ffb3a8` | Leave, destructive confirms, error text |
| `--ix-danger-fill` | `rgba(255,90,90,.14)` | Leave background (`.16` in the call view) |
| `--ix-call` | `#08080a` | Call surface |
| `--ix-focus` | `2px solid rgba(255,255,255,.85)`, offset 2 | Every focus-visible ring |

### 2.2 Server hue

Every window is tinted by the **current place's hue**, a number 0–359:

- a server: `guild.hue` (new nullable column, §11) when set; otherwise
  `paletteHue(guild.id)`;
- People (DMs and friends): `210`.

`paletteHue(id)` maps a snowflake deterministically onto a curated list that
excludes purples (owner rule: no purple defaults):
`[350, 8, 22, 36, 150, 162, 176, 190, 200, 214, 226]` (index = `id mod 11` over
the decimal string's last 9 digits). Admins pick a hue in Server settings ›
Overview ("Server color": the same eleven swatches plus "Match icon", which
computes the icon's dominant hue on the admin's client once and saves the
number). The hue is data, not a theme: high contrast keeps it.

Hue-derived colors (written as `hsl(var(--ix-hue) …)` in CSS; `--ix-hue` is set
on each tinted layer, never animated):

| Use | Value |
|---|---|
| Sidebar background | `linear-gradient(180deg, hsl(h 24% 14%), hsl(h 10% 10%) 45%, var(--ix-side-end))` |
| Main glow | `radial-gradient(900px 340px at 25% -140px, hsl(h 55% 40% / .26), transparent 70%)` over `--ix-main` |
| Selected channel | `hsl(h 50% 60% / .17)` with `inset 0 0 0 1px hsl(h 60% 72% / .12)` |
| Action-card glyph tile | background `hsl(h 50% 55% / .18)`, glyph `hsl(h 80% 80%)` |
| Event weekday | `hsl(h 75% 78%)`. **Recorded by IX-8: the prototype's 74 puts the 11px weekday at 3.8:1 on the day tile at hue 240 (a "Match icon" blue; the eleven palette hues pass); 78 clears 4.5:1 at every hue (§10)** |
| Message box focus halo | `0 0 0 4px hsl(h 60% 60% / .14)` |

### 2.3 Avatars and server marks

Real uploaded images always win: an avatar or icon renders as the image,
clipped to the same shape, with the same hairline. Monograms are used only
when there is no image.

**Person (circle).** Hue = `paletteHue(user.id)` (replaces today's eight
`--color-avatar-N` fills from `lib/colors.ts` `getIdentityColor`). Letter =
first grapheme of the display name, uppercase (one letter, not two).

```
border-radius: 50%;
background: linear-gradient(180deg, hsl(h 30% 30%), hsl(h 27% 23%));
color: hsl(h 75% 85%);
box-shadow: inset 0 0 0 1px hsl(h 45% 75% / .13);
font-weight: 550; font-stretch: 90%; letter-spacing: -.02em; line-height: 1;
font-size: round(size × .44)   /* .36 at 88px and above */
```

**Server mark (rounded square).** Hue = the server hue (§2.2). Letter = first
grapheme of the server name, uppercase.

```
border-radius: 28%;
background: linear-gradient(150deg, hsl(h 44% 38%), hsl(h 40% 23%));
color: hsl(h 85% 90%);
box-shadow: inset 0 0 0 1px hsl(h 60% 80% / .16);
font-weight: 600; font-stretch: 85%; letter-spacing: -.03em;
font-size: round(size × .44)
```

Sizes in use: 24 (room card people, mentions), 30 (bubble groups), 32
(toolbar), 34 (dock), 38 (DM rows), 40 (sidebar header), 76 (welcome, radius
22px for marks), 88 (call tiles). No glows, no rings except the talking ring
(§4.4) and presence (§4.11). The Glass `Face`/`FaceStack` and every glossy or
radial avatar style are retired.

**Presence.** A 10px dot at the avatar's bottom-right with a 2.5px ring in the
surface color: online `--ix-ink` at 100%, idle `--ix-ink-3`, do not disturb a
ring-only dot (`--ix-ink-2` 1.5px stroke, hollow), offline none. No red, green
or yellow (one danger color only, for destructive actions and errors).

### 2.4 Type

Instrument Sans variable (self-hosted, `wdth` 75–100, `wght` 400–700) as Glass.

| Role | Size / weight | Notes |
|---|---|---|
| Channel title (large) | 36 / 700 | tracking −.03em |
| Welcome title | 24 / 600 | tracking −.018em |
| Call title | 18 / 700 | |
| Sidebar server name | 17 / 700 | tracking −.01em |
| Event title | 16 / 700 | |
| Toolbar folded title | 15 / 600 | |
| Body, bubbles | 15 / 400, line-height 1.42 | |
| Channel name | 14.5 / 600 | |
| Room card head, people, room rows, Join | 14 / 600 (Join 700) | |
| Search field, action labels | 13.5 / 500–600 | |
| Preview, system line, secondary | 13 / 400 | |
| Section label, header line, bubble name | 12.5 / 600 (label), 400 (line, name) | sentence case, never uppercase |
| Time divider, card meta | 12 / 500 (day part 600, `--ix-ink-2`) | |
| Row time, kbd | 11.5 / 400, 11 / 500 | tabular numbers |
| Event weekday | 11 / 700 | `letter-spacing: .06em`, the only uppercase in the product chrome |

Times, durations, counts: `font-variant-numeric: tabular-nums`.

### 2.5 Shape and depth

Radii: call surface and sheets 24; message box 24; event/poll cards and call
tiles 20; bubbles 19 (joined corners 7); action cards 18; room card 16; channel
rows 12; room rows 10; controls 10–11; dock items 14 (marks 28%); search 10;
tool chips 8.

Shadows (static, never animated): room card `0 10px 30px rgba(0,0,0,.25)`;
your call card adds `0 0 34px rgba(var(--ix-amber-rgb),.12)`; event card
`0 12px 30px rgba(0,0,0,.3)` + `inset 0 1px 0 rgba(255,255,255,.07)`; call
surface `0 0 0 1px rgba(255,255,255,.07), 0 30px 70px rgba(0,0,0,.55)`.

### 2.6 Glyphs

24×24, stroke 1.7, round caps and joins (the prototype's set). Speaker (rooms),
mic, camera, screen, x, search, people, dots, invite (person-plus), plan
(calendar), hello (speech), attach, poll, event, send (arrow up), plus. The
Glass verb glyphs (listen, watch, clip, flame, theater) stay for the call view
and are restroked to 1.7.

---

## 3. Layout (desktop)

The window is two flush columns on `--ix-ground`:

```
┌──────────── 316 ───────────┬──────────────── 1fr ────────────────────────┐
│ Sidebar (current place)    │ Main (the open channel / DM / page)          │
│  ┌ pinned call card ┐ (opt)│  toolbar 58 ─ folded title ─ search members me│
│  header 40 mark            │  large title 36/700 + subtitle               │
│  search 34                 │  conversation column                         │
│  live room card (opt)      │                                              │
│  Channels                  │                                              │
│  Rooms                     │  message box 52 (98 open)                    │
│  Coming up (opt)           │                                              │
│ dock ───────────────────── │  call view / sheets: inset 10, radius 24     │
└────────────────────────────┴──────────────────────────────────────────────┘
```

- Sidebar 316px, full height, hairline `inset -1px 0 0 rgba(255,255,255,.05)`
  on its right edge. Main fills the rest. No outer gutters (the window is the
  frame). The desktop title bar (Tauri decorations) is unchanged.
- **Conversation column.** Main content (title, feed, message box) sits in a
  column of at most 920px, centered in main; side padding 48px inside it (the
  prototype at 1280 shows the 48px padding with the column filling main). The
  message box is 24px wider than the feed (12px each side: margin 36 vs 48).
- **Widths.** ≥ 1024px: as above. 768–1023px: sidebar 280px, column padding
  32px, action cards wrap to one column under 640px of column width. Below
  768px (the existing `DEFAULT_MOBILE_MAX_WIDTH`): the phone layout (§9). The
  Glass "compact" overlay (768–859px, `PlacesOverlay`) is retired: there is no
  overlay sidebar and no third mode.
- Bubbles max 520px (or 78% of the column, whichever is smaller).

### 3.1 Metrics (from the prototype, at 1×)

| Element | Metrics |
|---|---|
| Sidebar pane | padding 16 12 8; scroll with hidden scrollbar (keyboard and wheel still scroll); children never shrink |
| Header | padding 4 6 0, gap 12; mark 40; name 17/700; line 12.5 ink-3 ("2 members · 2 here now"); options button 30×30 radius 9, `--ix-ink-3`, hover `--ix-fill` |
| Search field | margin 14 0 4; height 34; radius 10; background `rgba(255,255,255,.055)`; padding 0 11; glyph 15; 13.5 ink-3 "Search Fuel"; `kbd` "Ctrl K" (macOS "⌘K") 11/500, padding 2 6, radius 6, hairline |
| Section label | padding 16 8 6; 12.5/600 ink-3; optional count right-aligned 500 |
| Room card | margin-top 12; radius 16; padding 12; background `linear-gradient(rgba(amber,.11), rgba(amber,.04))`; edge `inset 0 0 0 1px rgba(255,194,126,.24)`. **Yours**: `.17 → .06`, edge `.4`, plus the amber glow |
| Room card head | 14/600, speaker glyph 16 amber, gap 8; right: 12/500 amber tabular ("just now", "live 34 min", "You're in", "Listening") |
| Room card server line | only when pinned in another server: 12/500 ink-3, margin −2 0 0 24 |
| People rows | grid gap 2, margin 10 0 2; row 32 tall, padding 0 6, radius 9, gap 10, 14 ink-2 (talking: ink); avatar 24; trailing: waveform (talking) or screen glyph 14 ink-3 (sharing) or mic-off 14 ink-3 (muted) |
| Card actions | margin-top 10, gap 6. Cream button: flex 1, height 36, radius 11, 14/700. Control: 36×36, radius 11, `rgba(255,255,255,.09)`, hover `.14`, glyph 16 ink-2. Wide control: flex 1, 13.5/600 ink. Leave: `--ix-danger-ink` on `--ix-danger-fill` |
| Channel row | grid `1fr auto`, gap 1 10, padding 8 10, radius 12, **fixed height 52**; name 14.5/600 ink-2 (selected or unread: ink); time 11.5 ink-3; preview 13 ink-3 (unread: ink-2), one line, ellipsis; unread dot 6px ink at left −1, top 15 |
| Room row | height 36, padding 0 10, radius 10, gap 10, 14 ink-3, glyph 16; tail 12 ("Empty", "3 here"); busy: ink-2 with amber glyph; hover `rgba(255,255,255,.035)` and ink-2 |
| Dock | padding 10 12 14; top hairline `0 -1px 0 rgba(255,255,255,.05)`; gap 6. Item 42×42 radius 14; mark 34 (font 15); separator 1×24 `--ix-line`, margin 0 2; add: 34 square radius 11 with `inset 0 0 0 1.5px rgba(255,255,255,.14)`, plus glyph 16 ink-3. Indicator 16×3 radius 2 ink, 7px from the dock's bottom. Live dot 10px amber at top 1 right 1, ring 2.5px `--ix-side-end`. Unread dot 8px ink at top 3 left 2, same ring. Mention count: 16px-tall white chip (`--ix-ink`, text `#111214`, 11/700) at top-left instead of the dot |
| Main toolbar | 58 tall, absolute over the scroller, padding 0 20 0 40, gap 10; folded title 15/600; tools 34×34 radius 10 ink-2 (hover `--ix-fill`); your avatar 32 |
| Large title | padding 8 48 0; h1 36/700; subtitle 14 ink-3, margin-top 4 |
| Feed | padding 14 48 16; gap 3; bottom-anchored (content sits on the message box when short) |
| Time divider | centered; 12/500 ink-3, first word 600 ink-2 ("**Today** 9:41 PM"); margin 14 0 8 |
| Group (others) | grid `30px 1fr`, gap 10, align end, margin-top 6; avatar 30 at the group's bottom; name 12.5 ink-3, margin 0 0 3 13 |
| Bubble | max 520; padding 9 14; radius 19; `--ix-bubble`; 15/1.42; stack gap 3; joined corners 7 on the avatar side (first: bottom; middle: both; last: top) |
| Your bubble | right-aligned, cream, `--ix-cream-ink`; mirrored joined corners on the right |
| System line | centered, gap 8, 13 ink-3, glyph 14 (amber for voice), margin 8 0 |
| Welcome | mark 76 (radius 22, font 34); title 24/600 margin-top 20; line 15 ink-3 margin-top 6; cards `repeat(3, 196px)` gap 12 margin-top 24 |
| Action card | padding 16; radius 18; `rgba(255,255,255,.045)` + hairline; gap 10; glyph tile 38 radius 12; title 15/700; line 13 ink-3 1.4 |
| Event card | width 400 (max 100%); radius 20; `--ix-card`; padding 16; grid `auto 1fr`, gap 4 14; day tile 48×52 radius 12 `rgba(255,255,255,.07)`; actions margin-top 10 gap 8, buttons padding 8 12 radius 10 `rgba(255,255,255,.08)` 13.5/600, primary cream |
| Message box | margin 0 36 18; radius 24; `rgba(255,255,255,.055)` + hairline; 52 closed, 98 open; row padding 0 8 0 18, gap 10; input 15; send 36 circle `rgba(255,255,255,.08)`, cream with text; tools row padding 0 12 12, gap 6, chips padding 6 10 radius 8 `--ix-fill` 12.5 ink-2 glyph 14; open edge `inset 0 0 0 1px rgba(255,255,255,.18)` + focus halo |
| Call surface | inset 10 inside main; radius 24; `--ix-call`; header padding 18 20 gap 12 (speaker amber, name 18/700, server 13 amber, spacer, "Back to chat"); tiles gap 12 padding 0 20 16, 2 columns (3 when more than 4); tile radius 20, background `radial-gradient(120% 100% at 50% 0%, hsl(person-h 30% 24%), #121316 70%)`, avatar 88; talker `inset 0 0 0 2px amber` + `0 0 40px rgba(amber,.16)`; name 14/600 at 16/14 from bottom-left with waveform; controls centered gap 10 padding 0 0 20, buttons height 46 radius 23 min-width 46 padding 0 16 `rgba(255,255,255,.08)` 14/600 |

---

## 4. Components

### 4.1 Sidebar header

Mark, name, line, options. The line is "`N member(s) · M here now`" where
*here now* counts members whose presence is online (not idle, not offline).
The whole header is one button region: clicking the name or mark opens the
server's **Overview** in main; the "…" button opens the **server menu** (§6.2).
No chevron. Right-click on the header opens the same menu.

For People the header is your avatar, "People", "Friends and direct messages",
and "…" opens the People menu (Add friend, Start a group, Settings).

### 4.2 Search field ("Search Fuel  Ctrl K")

A button styled as a field. Click or Ctrl K (⌘K) opens the **quick switcher**
anchored over the sidebar's top (width 420, near-solid `rgba(22,23,26,.98)`,
radius 16), scoped first to the current server: channels, rooms, members, then
other servers and DMs, then a last row "Search messages in Fuel for '…'"
that opens the search sheet (§6.3). Typing filters; arrows move; Enter opens;
Esc closes. Ctrl F (⌘F) opens message search for the current conversation
directly.

### 4.3 Live room card

Shown when any voice or stage channel in the current server has people in it.
**One card per server**: the room with the most people (ties: the earliest
`started_at`). If you are in a call in this server, your room is the card.
Other occupied rooms appear in the Rooms list as busy rows. In People, the card
shows an active DM or group call you are in, or an incoming call (§4.10).

States:

| State | Head right | People rows | Actions |
|---|---|---|---|
| Live, nobody streaming | "just now" (< 1 min) / "live N min" | everyone | `[listen]` control + **Join** (cream, flex) |
| Live, someone streaming | same | streamer first, screen glyph | **Join** wide control (text) + **Watch Vincent** (cream, flex). Two or more streamers: "Watch" opens the call view on the busiest stream |
| Listening | "Listening" | you appear as "You — listening" in ink-3 | `[listen]` control active (amber glyph) + **Join** (cream) |
| Yours (joined) | "You're in" | everyone including "You" | mic, camera, screen (controls) + **Open call** / **Back to chat** (wide) + leave (danger, x glyph) |
| Yours, pinned in another server | "You're in" + server line under the head | same | same |

- People rows: stable join order (streamers first, then join order). At most
  6 rows; beyond that the sixth row reads "and 9 more" with up to 5 overlapped
  24px faces (−7px overlap, 2px ring in the card color). Clicking it opens the
  call view (joined) or the people sheet filtered to the room (not joined).
- Clicking a person row opens their profile card. Right-click: profile menu
  (and moderator actions when permitted: mute, move, disconnect).
- The talking ring and waveform (§4.4) follow real voice activity
  (`VOICE_SPEAKING`, already fanned out to guild members outside the call).
- "live N min" comes from the room's start time (the earliest current
  `voice_states.joined_at`, §11) and updates on one shared minute tick.
- Mic control: toggles mute; right-click or long-press opens the device menu
  (input, output, Deafen, Voice settings). Camera and screen open the existing
  pickers. Leave confirms nothing (one click), matching Glass.
- Listen: receive-only listen-in (glass-spec §7) where the channel allows it
  (`listen_in_enabled`); the control is absent where it does not. Stage
  channels have no listen control: **Join** joins the audience (suppressed, as
  today) and "Request to speak" lives in the call view (§7.2).
- The card's accessible name: "General, live, 3 people, Vincent talking".

### 4.4 Talking ring and waveform

- Ring: on the 24px avatar, `0 0 0 2px <card-dark>, 0 0 0 3.5px amber`, drawn
  as an absolutely positioned ring element whose **opacity** fades 150ms in,
  300ms out. Never animate the shadow.
- Waveform: four bars 2.5×12px, gap 2, radius 2, amber, `scaleY(.35 ↔ 1)` at
  1, .8, 1.15, .9s. Driven by the shared 100ms voice-level grid
  (`lib/motion/voiceLevel.ts`) when a level is available; otherwise the CSS
  loop runs **only while the person is talking** and the element is removed when
  they stop. Reduced motion: static bars at mid height.

### 4.5 Channels

Section label "Channels" (or the category name, sentence case, for channels in
a category; uncategorized first). A hover-revealed `+` at the label's right
creates a channel (Manage Channels only). Clicking a category label collapses
it (chevron appears only on hover/focus, rotates 90° in 200ms); collapsed
categories still show unread rows.

Rows: name (no `#`), time of the last message (today: "9:41 PM"; this week:
"Tue"; older: "Sep 28"), preview of the last message ("Jeremy: who's up for a
run tonight?", "You: …", "Nick posted 4 photos", "Movie night · Fri 9 PM" for
an event post, "No messages yet" when empty, the topic in ink-3 when there is
no message and a topic). End-to-end encrypted channels show no server preview:
the client's locally decrypted cached preview if one exists, else "Encrypted"
(ink-3, lock glyph 12). Unread: white dot, ink name, ink-2 preview. Mentions:
a white count chip under the time. Muted channels: ink-3 name, no dot.
Selected: the hue highlight that glides (§5). Forum channels preview the latest
post's title; announcement channels show a small megaphone glyph after the
name (12, ink-3). Threads do not appear as rows.

Right-click (or the row's long-press on touch): mark read, mute, notification
level, copy link, edit channel (permitted), delete (permitted, confirm).

### 4.6 Rooms

Section label "Rooms". Every voice and stage channel not shown as the card, in
category order then position. Row: speaker glyph (stage: a podium glyph), name,
tail ("Empty" or "3 here"; busy rows ink-2 with an amber glyph and up to three
16px faces before the count). Click joins (the prototype's behavior). Right-
click: Listen in (where allowed), Open chat (the room's text chat in main),
copy link, edit, delete.

### 4.7 Coming up

Shown only when the server has events in the next 7 days, under Rooms, at most
three rows: a 32×36 date tile (weekday 10/700 hue, day 15/700), title 14/600,
"Fri 9:00 PM · Lounge" 12.5 ink-3, and "Live" in amber for an event in
progress. Click opens the event sheet. The server menu has "Events" for the full
list.

### 4.8 Dock

People first (your avatar, 34px circle), separator, servers in the user's
order, then `+` (Join or create a server). Behavior:

- Click switches place (§5.1). Hover: lift −2px (350ms spring) and a name
  tooltip above after 400ms (near-solid, radius 8, 12.5/600).
- Current: indicator under it, mark at `scale(1.08)`; others at opacity .82.
- Live dot (amber) when any room in that server has people; pings once (§5)
  when a server goes from not live to live while you are not looking at it.
- Unread: white dot (top-left) when any unmuted channel has unread messages;
  becomes a white count chip for mentions. People shows unread DMs plus pending
  friend requests the same way.
- Order: the order the client has today (join order). Paracord has no server
  ordering or folders yet; drag-to-reorder is a follow-up (§13), not part of
  this build.
- Overflow: the dock scrolls horizontally (wheel vertical maps to horizontal,
  no visible scrollbar) with 16px static edge fades (mask); People and `+` stay
  fixed; the current server is scrolled into view on switch.
- Keyboard: the dock is one roving-tabindex toolbar (Left/Right, Home/End,
  Enter); Ctrl+Alt+Up/Down (⌥⌘↑/↓ on macOS) switches place; Ctrl+1…9 jumps to
  the nth server.
- `+` opens the **Add a server** sheet: Create (from a template), Join with an
  invite link, Discover servers (when the instance has discovery on).

### 4.9 Main toolbar

Right side: search (message search sheet for this conversation), members
(people sheet: this channel's members or the DM's participants), your avatar
(account menu, §6.4). Left side: the folded title (appears when the large title
scrolls away), which is a button that opens the channel menu, exactly like the
large title. In a DM: a call button (phone glyph) joins the left of search;
in a channel with threads, pins etc. those live in the channel menu, not the
toolbar. Until the conversation has scrolled 40px the toolbar is transparent;
past that it takes `rgba(16,17,19,.92)` and a bottom hairline (color
transition 300ms; no blur, §1.9).

### 4.10 Calls in People (DMs)

- Starting a DM call: the toolbar call button. Your call card then appears in
  the People sidebar's card slot (and pinned in other places).
- **Incoming call**: a card in the card slot of whatever place you are in
  (pinned style, top of the sidebar) with the caller's 24px face, "Jeremy is
  calling", and **Decline** (wide control) + **Accept** (cream). It enters with
  the room-card motion and stays until answered, declined or timed out (the
  existing ring timeout). A system notification fires as today when the window
  is not focused. The ringtone is unchanged.

### 4.11 Conversation

- **Large title**: channel name, or the person's / group's name in a DM.
  Subtitle: the topic; "Direct message"; "Group · 4 people"; for an encrypted
  conversation, a lock glyph and "End-to-end encrypted" after the topic.
  Clicking the title opens the channel menu (DM: the person's profile).
- **Messages** group by author: same author, no divider between, within 5
  minutes. A **time divider** precedes a message when the calendar day changes
  or more than 30 minutes passed: "Today 9:41 PM", "Yesterday 6:20 PM",
  "Tuesday 6:20 PM" (within 6 days), "Sep 28 6:20 PM", "Sep 28, 2025 6:20 PM".
- **Your messages** are cream bubbles on the right, no avatar or name.
- **Mentions of you**: the bubble keeps `--ix-bubble`; the mention itself is a
  white chip (`--ix-ink` on `#111214`, radius 6, padding 0 5). Other mentions
  are ink with 600 weight.
- **Hover** (or focus within) on a bubble: the time appears beside it (12 ink-3,
  outside the bubble on the far side), and an action capsule floats at the
  bubble's top trailing corner: react, reply, thread, more (28×26 each,
  near-solid `rgba(30,31,35,.98)`, radius 10). More: edit (own), copy, pin,
  forward, remind me, mark unread, copy link, delete (own or permitted).
- **Reactions**: one chip that bites the bubble's top trailing corner (top-right
  for others, top-left for yours): `#34353a` with a 3px ring in the main color,
  emoji + count per reaction, yours highlighted with a white count. Click
  toggles; hover lists who reacted.
- **Replies**: a 13px quoted line above the bubble ("↩ Jeremy: who's up for…",
  ink-3, one line); clicking jumps to and briefly highlights the original.
- **Threads**: under the thread's starter bubble, "3 replies · 9:41 PM" in
  12.5/600 ink-2; opens the thread pushed in main (title + back).
- **Edited**: "edited" in 11.5 ink-3 after the bubble's text.
- **Attachments**: images and video as media bubbles (no padding, radius 19
  with joined corners, max 360×360 fit, click opens the media viewer); files as
  a card bubble (`--ix-card`, glyph tile 38, name, size, download); link embeds
  as a card bubble under the text bubble. Clips keep the Glass clip bubble.
- **Polls**: a poll card (event-card family): question 16/700, options as rows
  with a fill bar (`transform: scaleX`), your vote checked, "12 votes · ends Fri"
  ink-3, Vote (cream, one per card).
- **Events in messages**: the event card (§3.1): day tile, title, "Friday at
  9:00 PM · in General", actions "I'm in" (cream) / "Maybe" / details.
- **System lines** (§3.1): voice joins in the channel's own room ("You joined
  General" — your own joins and leaves only, so busy rooms do not flood the
  feed), pins, thread created, member joined (the server's system channel), call
  started/ended in DMs. Amber glyph only for voice.
- **Typing**: a bubble with three dots beside the typist's avatar at the
  bottom; two or more typists: overlapped faces and "Nick and Maya are typing".
  Dots animate only while visible.
- **New messages divider**: when you open a channel with unread messages, a
  divider at the first unread: hairlines either side of "New" in white 12/600,
  and a "Mark read" text button right-aligned. Fades out 2s after you reach the
  bottom.
- **Jump to latest**: when scrolled more than one screen up, a capsule above
  the message box ("↓ 12 new" / "↓ Latest"), near-solid, 34 tall.
- **Loading history**: three skeleton bubbles at the top (static, no shimmer).
- **Encrypted conversations** keep their current lock and unlock states;
  "Locked: unlock your vault to read" uses the empty-state layout with one
  cream "Unlock".

### 4.12 Message box

Capsule (§3.1). Placeholder "Message general" / "Message Jeremy". Row: input,
emoji button (ink-3 glyph, opens the picker with Emoji / GIF / Stickers tabs),
send. **Open** state (on focus, or when it has text, attachments or a reply):
98px tall with the tools row: Attach, GIF, Poll, Event (each only when
permitted) and Format (swaps the row for the formatting bar). Attachments queue as 52px thumbnails inside the box above the input
row (the box grows to fit, max 3 rows of content then scrolls). Replying: a chip
"Replying to Jeremy ×" leads the tools row. Slash commands and @/#/: completion
open a near-solid popover above the box (radius 16, max 6 rows). Editing a
message happens in place in its bubble (Esc cancels, Enter saves). Read-only
channels replace the box with a centered ink-3 line ("Only moderators can post
in announcements"). Slowmode shows "Slow mode: 12s" in the tools row. Drag and
drop over main shows a full-main drop target (`rgba(14,15,17,.9)`, dashed
`--ix-line` 2px radius 24 at inset 10, "Drop to share in general").

Sending: the send flight from `feat/send-flight` (its own spec in that branch)
is the only send motion. Index does not change send behavior.

### 4.13 Empty and new places

- **The server's first channel, when the server has no messages at all**:
  "`<Server>` is ready", "Three good ways to start it.", and three action cards:
  - **Bring your people** — "A link that works for anyone, on any device."
    Creates (or reuses) a never-expiring invite and copies it; the card title
    crossfades to "Link copied" for 2s; a second click opens the invite sheet.
    Needs Create Invite.
  - **Plan a night** — "Pick a time; everyone gets a nudge before it starts."
    Morphs into a draft **event card** in the conversation (§5.6): "Game night",
    next Friday 9:00 PM local, in the server's first room; **Post it** (cream)
    creates the scheduled event and posts it; **Edit** opens the event sheet
    first. Needs Manage Events.
  - **Say hello** — "The first message sets the tone." Fills the message box
    with a short greeting, selects it, and focuses the box; the user sends it.
    Needs Send Messages.
  Cards the user lacks permission for are omitted (the row centers the rest).
- **Any other empty channel**: "`<channel>` is ready", the topic or "Nothing
  here yet." as the line, and the cards that fit (Say hello; Plan a night in a
  channel the user may post events to). The welcome replaces itself once the
  first message lands (crossfade 300ms).
- **New DM**: the person's 76px avatar, their name (24/600), "You're friends"
  or "You share Game Night", one card: Say hello.
- **Nothing selected** (People with no DMs): the Friends page.

---

## 5. Motion

Curves: **spring** `cubic-bezier(.32,.72,0,1)`; **ease** `cubic-bezier(.2,.8,.2,1)`.
All durations below are for full motion; reduced motion replaces every move
with a 150ms opacity crossfade, removes pings and lifts, and stills the
waveform. Every animation is transform/opacity (Web Animations or CSS) and is
triggered by an event; nothing loops at rest. Animations are canceled and
committed if a newer event of the same kind starts (no queueing).

| # | Moment | Motion |
|---|---|---|
| 5.1 | **Switch place** (dock) | Old sidebar pane `translateX(−dir×40%)`, opacity 1→0, 450ms spring, then removed; new pane from `translateX(dir×60%)`, opacity 0→1, 550ms spring (`dir` = sign of the dock index change). The pinned call card does not slide (§5.4). Window tint: the new hue's sidebar background and main glow are separate layers that fade in over the old ones, 900ms ease, then the old layers are removed. Dock indicator glides to the new item, 550ms spring; marks scale 1↔1.08, 450ms spring. Main: title and feed enter as 5.2 with `dir` = 1 |
| 5.2 | **Switch channel** | Selection highlight `translateY` to the new row, 450ms spring (fixed row height, so no height animation). Main title from `translateY(dir×14+4px)` + fade, 420ms spring; feed from `translateY(dir×22px)` + fade, 480ms spring (`dir` = sign of the row index change; 0 for a jump from elsewhere) |
| 5.3 | **Preview changes** (new message in another channel) | The preview line from `translateY(9px)`, opacity 0, 520ms spring; time fades in 400ms. Unread dot scales 0→1, 450ms spring (also 1→0 when read) |
| 5.4 | **Pinned call card** | When the card is above the header (another place), switching between other places leaves it still. Switching to or from the call's own server moves it between "above the header" and "under the search" with a FLIP translate, 550ms spring, while the panes slide beneath |
| 5.5 | **Room goes live / someone joins** | The card enters: `translateY(−8px) scale(.97)`, opacity 0 → none, 600ms spring; content below it moves down with a FLIP translate, 600ms spring. A person row enters the same way, 500ms spring. A person leaving: row fades and scales to .97, 250ms ease, then rows below FLIP up, 450ms spring. The room emptying: the card reverses (300ms ease) and the list FLIPs up. Dock: live dot scales in, 450ms spring, and **pings once**: an amber 2px ring around the dot from `scale(1)`, opacity 1 to `scale(2.2)`, opacity 0, 1200ms ease (only when that server is not current) |
| 5.6 | **Plan a night** | The draft event card grows out of the clicked action card: FLIP from the action card's rect (translate + scale), opacity .5→1, 650ms spring; the welcome crossfades out (300ms) |
| 5.7 | **Join** | The card swaps to "yours": the yours layer (stronger tint, edge and glow, drawn as a second background layer) fades in 400ms ease. Your row flies from the toolbar avatar to its place: translate + scale from the avatar's rect, 750ms spring, above the other rows; the rest of the card's new content holds at opacity 0 until 45% then fades in. A "You joined General" system line pops into the room's own channel if it is open |
| 5.8 | **Open call / Back to chat** | Open: the call surface grows out of the card: from the card's rect (translate + non-uniform scale, `transform-origin: 0 0`), opacity .3→1, 600ms spring; the tiles and controls fade in from 40% (they do not scale with the surface; they are in a counter-layer that only fades). Back to chat: the reverse into the card, 450ms spring, then hidden. The card's wide control label crossfades between "Open call" and "Back to chat", 200ms. Native video surfaces show their poster frame during the move and attach after it settles (§7.6) |
| 5.9 | **Theater** (T) | The call surface FLIPs from main's inset to the window's inset 10 over the sidebar, 600ms spring; the sidebar dims to opacity .4 beneath. Reverse the same |
| 5.10 | **Message arrives** (from others) | The new group or bubble from `translateY(14px) scale(.96)`, opacity 0, 550ms spring, `transform-origin` at the avatar side; earlier content FLIPs up when it was at the bottom |
| 5.11 | **Send** | Owned by `feat/send-flight` (arc out of the message box, 620ms). Index composes with it and changes nothing in it |
| 5.12 | **Message box opens** | The capsule is three slices (top cap, stretchable middle, bottom row) so the corners never distort: the top cap translates up 46px and the middle scales from 0 to 1 in Y, 500ms spring; the tools row from `translateY(6px)`, opacity 0, 300ms opacity with 80ms delay and 450ms spring translate. The layout height changes once at the start; the feed above it FLIPs from its old position, 500ms spring, so nothing jumps. Closing reverses in 350ms. The focus edge and halo fade in (opacity of a ring layer), 250ms |
| 5.13 | **Send button** | Quiet → cream when text appears: background color transition 200ms (color transitions are allowed) |
| 5.14 | **Title fold** | Scroll-linked, no timer: `t = min(1, scrollTop/60)`; large title `scale(1 − .1t)`, opacity `1 − .9t`, `transform-origin: 0 50%`. Past 40px the folded title enters from `translateY(6px)` + fade (250ms opacity, 350ms spring) and the toolbar background appears (300ms color). Updates on `scroll` with one `requestAnimationFrame` per frame at most |
| 5.15 | **Hover lifts** | Dock items −2px (350ms spring); action cards −3px (400ms spring); rows and controls: background one step lighter, 120ms ease (color only) |
| 5.16 | **Copy feedback** | Label crossfade 200ms ("Link copied"), back after 2s |
| 5.17 | **Sheets** | People, search, channel pages slide in from the right edge of main: `translateX(24px)`, opacity 0 → none, 380ms spring; out 250ms ease. Menus and popovers: `scale(.97)` + fade from their anchor, 180ms ease; out 120ms |
| 5.18 | **Toasts** | Top center of main under the toolbar: from `translateY(−8px)` + fade, 300ms spring; out 200ms; 4s default |
| 5.19 | **Talking ring** | Opacity 150ms in, 300ms out (§4.4) |
| 5.20 | **Category collapse** | Rows fade (150ms) and the rest of the sidebar FLIPs up, 450ms spring; chevron rotates 200ms |

The motion lint's existing allowances keep applying; any new allowance needs a
named reason in `scripts/motion-lint.mjs`. The FLIP helpers in `lib/motion`
(`flip.ts`, `flipList.ts`, `sharedElement.ts`) are reused; Index-only helpers
live in `client/src/components/ix/motion/` so they never collide with
`feat/send-flight`'s edits to `lib/motion`.

---

## 6. Menus, sheets and pages

### 6.1 Sheets and pages in main

- **Sheets** (people, message search, channel pages, reminders, scheduled
  messages, event, invite, add a server) open inside main on its right: inset
  10 (the call view's inset), width 400 (search 480), radius 24, background
  `rgba(20,21,24,.98)` (fully opaque with Reduced transparency), hairline edge;
  header 58 with the title 17/700 and a close button; content scrolls. The
  conversation stays usable to the left. When main is narrower than 760px the
  sheet takes main's full inset. One sheet at a time (the existing
  `sheetStore`); Esc closes and focus returns to the opener. The Glass
  `SheetFrame` stops drawing a pill.
- **Pages** replace the conversation in main and use the same large-title
  layout (36/700 title, 14 ink-3 subtitle, the same toolbar, the title fold):
  Overview, Events, Friends, Inbox, Forum, Sports, Daily word, Game servers,
  Discover, Admin, Developer. A **pushed page** (a thread, a sports game, a
  forum post) adds a back chevron at the toolbar's left before the folded
  title; Esc or Alt+Left goes back.

### 6.2 Server menu

Opened by "…" in the header, right-click on the header, or right-click on the
server's dock mark. Popover 240 wide, radius 14, near-solid
`rgba(24,25,28,.98)`, rows 36 (14/500, glyph 16 ink-3), separators as
hairlines: Overview · Invite people · Events · Notifications ▸ (All messages /
Only mentions / Nothing) · Mark as read · Mute server · Create channel ·
Create room (both need Manage Channels) · Server settings (permitted) · Copy
link · Leave server (danger ink, confirms).

### 6.3 Search

- **Quick switcher** (Ctrl K / ⌘K, the sidebar search field): the existing
  `CommandPalette` restyled and anchored over the sidebar's top (§4.2), server-
  scoped first. Its commands (New message, Add a friend, Settings, Admin,
  Developer, …) stay, listed after places when the query matches.
- **Message search** (toolbar search, Ctrl F): the existing `SearchOverlay`
  (filter chips `from:` `in:` `has:` `before:`, grouped results) as a 480px
  sheet. Results open the message in main with the highlight.

### 6.4 Account menu

Your avatar in the toolbar (phone: in the sidebar header). Popover 280 wide:
your avatar 40, name, username; status (Online / Idle / Do not disturb /
Invisible); Set a custom status; Profile; Reminders; Settings (Ctrl ,);
Keyboard shortcuts (Ctrl /); Admin (instance admins); Developer portal; Copy
username; Sign out.

### 6.5 Channel menu

The large or folded channel title. Popover: Summary (catch up), Pinned,
Threads, Media, Follows (announcement channels), Leaderboard (when the
server's economy is on), Notifications, Edit channel (permitted), Copy link.
Each item opens the channel sheet on that page (the existing `ChannelSheet`
pages; its tab strip becomes a segmented control at the sheet's top).

### 6.6 People menu and pages

"…" in the People header: Add friend, New message, Start a group (the
existing `DmPickerModal`). The People sidebar (§9 for phone): header, "Search
people" (opens the switcher scoped to people), then two utility rows styled
as channel rows: **Friends** (preview "3 online · 1 request", white count when
there are requests) and **Inbox** (mentions, replies and reminders; preview of
the newest; white count), then "Messages": DMs and groups as two-line rows with
a 38px avatar (groups: two overlapped 26px faces), name, time, preview, unread
dot. Friends and Inbox open as pages in main.

### 6.7 Settings

User settings and Server settings keep their overlays, routes and sections and
are restyled: full-window surface on `--ix-ground`, left navigation 240px
(sentence-case group labels 12.5/600 ink-3, rows 34 radius 10, selection in
hue 210 for user settings and the server hue for server settings), content
column 720px with a 28/700 section title, close (Esc) at the top right.
Additions: Server settings › Overview › **Server color** (§2.2); User
settings › Voice & video › **Join calls muted** (the Glass pill's mute
preference, now a setting). Appearance keeps High contrast, Transparency
(standard / reduced), Motion (system / full / reduced), Density (comfortable /
compact, §6.13), language and Custom CSS.

### 6.8 Notices: toasts, banners, errors

- Toasts: §5.18; near-solid capsule, 13.5/600 ink, optional one text action;
  errors use danger ink text, never a red fill.
- Banners (connection lost / reconnecting, server restarting, update ready):
  a 36px strip across the top of main above the toolbar (the existing
  `BannerStack` and `--pc-banner-inset`), `--ix-card` with a bottom hairline,
  13/600 ink, one text action ("Retry now", "Restart to update"). Never amber.
- Section errors (`ErrorBoundary variant="section"`): the empty-state layout
  with "Something went wrong showing messages" and a cream "Reload".
- Missing channel or server (`GuildStateScreens`, `BuildingNotFound`): the
  empty-state layout ("This channel is gone") with a cream "Go to general".

### 6.9 Profile card

Popover 340 wide, radius 20, near-solid: banner (when set) 96 tall, avatar 76
overlapping it with a 4px ring in the card color, name 20/700, username and
pronouns 13 ink-3, status and activity line, About, roles as fill chips, mutual
servers as 24px marks, actions: **Message** (cream), Call (control), "…"
(block, report, verify keys, copy id). Key verification stays here.

### 6.10 Media viewer

The existing lightbox restyled: `rgba(8,8,10,.96)` full window, the image
grows out of its bubble (FLIP, 450ms spring) and shrinks back on close; close
and arrows as 40px controls; caption line at the bottom.

### 6.11 Pickers and popovers

Emoji / GIF / Stickers: one popover with a segmented control, 360×420,
radius 16, near-solid, anchored above the message box's emoji button. Reaction
picker: the same popover anchored to the action capsule. Tooltips: near-solid
`rgba(30,31,35,.98)`, radius 8, 12.5/600, 400ms delay.

### 6.12 Dialogs

Centered, max 440 wide, radius 20, `--ix-card`, title 17/700, body 14 ink-2,
actions right-aligned: a text Cancel and one cream confirm; destructive
confirms use `--ix-danger-ink` text on `--ix-danger-fill` instead of cream.
Enter: `scale(.97)` + fade, 220ms spring; scrim `rgba(0,0,0,.5)` fades 200ms.

### 6.13 Density

Compact density (existing setting): bubble padding 6 12, stack gap 2, group
margin 4, bubble line-height 1.35, group avatar 24, channel rows keep 52 (the
sidebar does not change with density).

### 6.14 Auth and onboarding pages

Login, register, connect (instance picker and `OnboardingWizard`), first-owner
setup, account setup / unlock / recover, invite, bot authorize, legal: the
ground with the main glow at hue 210, a centered 400px column, the Paracord
mark, title 28/700, fields 44 tall radius 12 `rgba(255,255,255,.055)` with a
hairline, one cream primary, text secondary actions. `BrandSplash` unchanged.

---

## 7. Call view

### 7.1 State

`glassStore.stage` keeps one shape: `mode: 'none' | 'main' | 'theater'`
(Glass's `side` becomes `main`), `chat: boolean` (H), target
`{ guildId, channelId, streamerId | null }`. Watching without joining is the
stage open with a `streamerId` while not joined (the existing `startWatch` /
`stopWatch` view session). `browseOpen`, `pillExpanded` and
`placesOverlayOpen` are removed.

### 7.2 Layout (desktop)

The call surface (§3.1) over main at inset 10:

- **Header**: speaker glyph (amber), room name 18/700, server name 13 amber
  ("Direct call" for DMs), spacer, then icon controls: chat (H), theater (T),
  and the **Back to chat** text button (Esc).
- **Content**:
  - No stream in focus: the people grid (2 columns, 3 above 4 people, 4 above
    9; tiles 16:9 when anyone has a camera, otherwise as the prototype's tall
    tiles). Camera on: live video fills the tile (`cover`), name and waveform
    bottom-left. Camera off: the 88px avatar centered on the person-hue
    gradient.
  - A stream in focus (someone shares, or you clicked their tile): the stream
    16:9, radius 20, fills the content area above a 112px filmstrip of people
    tiles (camera video or a 52px avatar chip); click any tile to focus it;
    the stream's overlay shows "Vincent's screen", volume and quality
    (`StreamSound`) on hover.
  - With **chat** on (H): the room's own text chat as a 360px column at the
    content's right, an inner panel `rgba(255,255,255,.03)` radius 20 with the
    same bubbles and a narrow message box. In DM calls it is the DM.
- **Controls** (centered capsule buttons, §3.1):
  - joined: mic (right-click/long-press: device menu with Deafen), camera,
    screen (when sharing: "Stop sharing" text), then, when a stream is in
    focus, flame, heart and **Clip**, then **More** (Soundboard, Watch
    together, Invite people, Microphone and speaker, Stream volume and quality,
    Connection check), then **Leave** (danger).
  - watching, not joined: flame, heart, Clip, then **Join** (cream).
  - stage channels: speakers as tiles, the audience as one "12 listening" row
    of faces; members without Speak see **Request to speak**; moderators see
    requests in the chat column header (the existing `StageChannelPanel`).
- **Theater** (T): §5.9, the surface over the whole window at inset 10; the
  chat column, when on, stays inside it; when chat is off, new messages surface
  over the stream bottom-left (the existing `SurfacingMessages`).
- Clip toast, stream reactions and the Together stage keep their Glass
  behavior (glass-spec §6.4, §6.5) inside the call surface. The Together stage
  replaces the people grid while a watch-together session plays; a
  listen-together "now playing" line also shows under the room card's head.

### 7.3 Opening, closing, leaving

Open call (card), clicking a person's screen glyph, and Watch open the call
view (§5.8). **Back to chat** and Esc close it: the
call continues, the card returns to "Open call". Closing the call view
**unsubscribes all video** (screen and cameras, and the stream's own audio);
voices continue. Not joined, closing stops watching. **Leave** is the only way
out of a call. Joining from watch keeps the view open.

### 7.4 Keyboard

While the call view is open: Esc (theater → main → closed), T theater, H chat,
C clip (when a stream is in focus). Glass's S (browse) is retired. Global voice
keys (Ctrl+Shift+M mute, Ctrl+Shift+D deafen, push-to-talk) are unchanged.

### 7.5 DM calls

A DM or group call uses the same card (in People, and pinned elsewhere), the
same call view (title = the person or group, "Direct call") and the same
controls. The toolbar's call button starts it; while it runs the button reads
as active and clicking it opens the call view.

### 7.6 Native video (desktop)

On the desktop, video draws into native surfaces beneath the webview
(`feat/native-video`). Index follows its rules and owns none of its files:

- The call view composes `StreamSurface`, `CameraTile` (`StagePeople.tsx`),
  `useNativeUnderlay` and `useStreamPoster` from `components/glass/stage/`
  unchanged.
- No native surface is visible while the call surface morphs (§5.8, §5.9):
  each tile shows its poster frame (last decoded frame, or the avatar) during
  the move and the surface attaches when the move settles.
- Anything drawn over native video (controls, toasts, reactions, the clip
  toast) is legible without `backdrop-filter`: near-solid fills.
- The `data-native-underlay-clear` contract on the shell root is kept.

---

## 8. Where every feature lives

Everything the Glass client does has a place below. "Kept" means behavior and
data are unchanged and the surface is restyled to Index tokens.

### 8.1 Routes

| Route (page) | Index |
|---|---|
| `/app` (`HomePage`: For you, Live now, Around now, Coming up, Pick up) | **Retired.** `/app` redirects to the last place (last server channel, or the last People item). "Needs you" (requests, mentions) → People › Inbox and the Friends row; cross-server live → the dock's live dots and each server's card; Coming up → each server's Coming up and Events; Pick up → channel previews |
| `/app/guilds/:g` (`ServerHome`, Overview) | Overview page in main (header click, server menu). Widgets kept in a two-column grid under the large title; its `LiveNow` block is removed (the card shows live) |
| `/app/guilds/:g/channels/:c` text, announcement | Conversation (§4.11) |
| … forum (type 7) | Forum page: posts as two-line rows (title, author · replies · time), **New post** cream; a post opens pushed |
| … voice / stage channel | Its text chat in main (room row right-click › Open chat; the call view's chat column). Joining never navigates |
| … thread (type 6) | Pushed page: title, "Thread in general", back |
| `/app/guilds/:g/settings` | Server settings (§6.7) |
| `/app/guilds/:g/sports`, `…/sports/:sport/:league/:eventId`, `/daily-word` | Pages in main, reached from the Add-ons rows (§8.3) |
| `/app/dms`, `/app/dms/:c` | People place; `/app/dms` opens the most recent DM (Friends when there is none) |
| `/app/friends` | Friends page (People) with a segmented control Online / All / Requests / Blocked and **Add friend** (cream) |
| `/app/admin`, `/app/developers`, `/app/oauth2/authorize` | Pages in main from the account menu; bot authorize keeps the auth layout |
| `/app/discovery`, `/app/templates` | The dock's `+` sheet: Create (templates inside), Join with a link, **Discover** (opens the Discover page in main) |
| `/login`, `/register`, `/connect`, `/setup-server`, `/setup`, `/unlock`, `/recover`, `/invite/:code`, `/terms`, `/privacy` | Auth layout (§6.14) |
| `/design-tokens`, `/media-test` (DEV) | Index section added to `/design-tokens`; media test unchanged |

### 8.2 Shell and global surfaces

| Glass surface | Index |
|---|---|
| `GlassFrame` (two floating panes, 720 column), `useGlassLayout` | `components/ix/shell/IxFrame` (two flush columns, §3); phone screens §9 |
| `RoomBackdrop`, `useRoomSource`, `lib/room/**`, ambient view, `useStageGlow`, `PillPreview` | **Retired.** The hue tint (§2.2) replaces room light; the client stops opening ambient views |
| `PlacesOverlay`, `PlacesToggle` (768–859px) | **Retired** (§3) |
| `PlacesPanel`, `ServerTitle`, `PlaceRows`, `ComingUp`, `AddonRows`, `HomePlaces`, `Lead` (`Face`) | Sidebar (§4.1–4.7), People sidebar (§6.6), `Avatar` (§2.3). Data reused: `model.ts`, `rows.ts`, `usePlacesData`, `useChannelPreviews`, `useUnreadMessageCounts`, `hooks/useRoomMenu` |
| `ServerRow` | Dock (§4.8) |
| `ServerMenu` | Server menu (§6.2) |
| `CallPill` (compact, expanded, stacked), `PillRoster`, `pillMotion`, `sheetCover`, "Show the call" | Live room card (§4.3) and Open call (§5.8). Reused as data/actions: `pill/model.ts`, `useCallPill`, `pillActions`, `muteStore` |
| `ConversationHeader` (76px), "N NEW" kicker, `HeaderAvatar` | Toolbar (§4.9) + large title (§4.11); New divider (§4.11) |
| `useDmCall` + header call button | Toolbar call button (§7.5) |
| `Sheets`, `SheetFrame`, `sheetStore`, `PeopleSheet`, `ChannelSheet` pages, `RemindersSheet` | Sheets in main (§6.1), kept |
| `AccountMenu` | Account menu (§6.4), kept |
| `CommandPalette` (Ctrl K) | Quick switcher (§6.3), kept |
| `HelpOverlay` | Account menu › Keyboard shortcuts, Ctrl / |
| `InboxOverlay` (from the channel menu) | People › Inbox page |
| `BannerStack`, `ConnectionStatusBar`, `RestartBanner`, `UpdateNotification` | Banner strip (§6.8) |
| `IncomingCallBanner` | Incoming call card (§4.10) |
| `ToastContainer` | Toasts (§5.18) |
| `Modal`, `ConfirmDialog`, `InteractionModal` | Dialogs (§6.12) |
| `ImageLightbox` | Media viewer (§6.10) |
| `MotionDirector` ("lights on", "someone arrives") | **Retired** after the send-flight merge, unless `feat/send-flight` uses it; Index moments belong to their components (§5) |
| `ErrorBoundary` (section), `GuildStateScreens`, `BuildingNotFound` | §6.8 |
| Skip link, focus traps, `useKeyboardNavigation` | Kept; Ctrl+B (show places) is removed on desktop and means "back to the sidebar" on phone |

### 8.3 Servers

| Feature | Index |
|---|---|
| Server settings (every tab: Overview, Server hub, Channels, Emojis, Stickers, Soundboard, Events, Add-ons (Sports, Feeds, Daily word, Game servers), File storage, Roles, Members, Invites, Onboarding, Economy, Bot store, Bots, Webhooks, Bans, AutoMod, Mod templates, Reports, Audit log) | Kept, restyled (§6.7); Overview gains Server color |
| Invites (`InviteModal`) | Invite sheet (server menu, "Bring your people", call view More) |
| `CreateGuildModal` (Create / Join / Template) | Add a server sheet (dock `+`) |
| `GuildWelcomeScreen` (first visit) | Joiner welcome (§4.13): "Welcome to Game Night", the description, cards Say hello / See who's here (people sheet) / Pick roles (when onboarding has roles) |
| `GuildOnboardingGate` | Kept as a page in main before the server opens |
| Sports, Daily word, Game servers (Glass add-on rows) | Sidebar section **Add-ons** after Rooms: two-line rows like channels with a live line ("Cubs 3–2 Brewers · 7th", "Daily word · 4 solved today", "2 of 3 game servers online"); they open their pages in main. Game servers' popover becomes its page |
| Sports `ChannelPin` / `ChannelAmbient` (score pinned in a channel) | A thin card under the large title (event-card family, 52 tall) |
| Feeds | Posts in channels (card bubbles); settings unchanged |
| Events (`EventList`, scheduled events, RSVP) | Coming up (§4.7), Events page (server menu), event sheet, event cards in messages |
| Leaderboard (`GuildEconomyPanel`) | Channel menu › Leaderboard |
| Discovery | Discover page (dock `+`) |

### 8.4 Conversation

| Feature | Index |
|---|---|
| `MessageList` (virtualized, grouping, dividers, jump, typing, catch-up, context menu, edit history, forward, remind, deanonymize) | Kept and restyled in place (§4.11); grouping and dividers per §4.11 |
| `TimelineParts`: `DayDivider`, `TimelineAvatar`, `MessageActions`, `TypingBubble`, `ReplyChip`, `RoomLitEventRow`, `ThreadRow` | Time divider, `Avatar`, action capsule, typing bubble, reply line, system line, thread line |
| `messageLight.ts` (author light, lamp flicker) | **Retired** |
| `CatchUpDivider` | New divider |
| `ReactionBite`, `ReactionPeople` | Kept (§4.11) |
| `MediaFrame`, `FilePreview`, `MediaPreview`, `EncryptedAttachment`, `ClipAttachment` | Media bubble, file card bubble, kept clip bubble |
| `InlineChips` (channel, live, event chips) | Kept: channel chip `--ix-fill` ink 600; live chip amber tint; event chip `--ix-card` |
| `PlanCard`, `EventPlanCard` | Event card (§3.1) |
| `PollMessageCard` | Poll card (§4.11) |
| `MessageEmbed`, `GitHubEventEmbed`, `FeedPostCard`, `ScoreUpdateCard` | Card bubbles (event-card family) |
| `MessageComponents` (bot buttons, selects) | Index controls; a bot's primary button is cream only when it is the message's only primary |
| `EphemeralMessage` | Bubble with "Only you can see this" (12 ink-3) under it |
| Code blocks | `#18191c` block, radius 12, inside a full-width bubble |
| `MessagingQueuePanel`, `MessagingRecoveryNotice` | A quiet card (`--ix-card`, radius 16) directly above the message box, the box's width |
| System-audio-capture notice | A line under your call card's head ("Sharing system audio") |
| `MessageInput` (drafts, slash commands, mentions, role mention chips, uploads, polls, reply) | Message box (§4.12), restyled in place after the send-flight merge |
| `MarkdownToolbar` | A **Format** chip at the end of the tools row swaps the row for the formatting bar; Ctrl B / I / E shortcuts unchanged |
| Scheduled send, `ScheduledMessagesPanel` | Right-click / long-press on Send: "Send later…"; the scheduled list is a sheet from that menu |
| Emoji, GIF, Sticker pickers | One picker (§6.11) |
| `SearchOverlay` | Message search sheet (§6.3) |
| `ThreadPanel` | Pushed thread page |
| `ForumView` | Forum page (§8.1) |
| Pins, threads list, media gallery, summary, follows, notifications | Channel menu → channel sheet pages (§6.5) |
| E2EE placeholders, decrypting skeleton | "Encrypted message" bubble (lock glyph, ink-3) and a skeleton bubble |
| `ForwardPicker`, `RemindMeMenu`, `MessageEditHistoryDialog` | Dialogs and popovers (§6.11, §6.12) |

### 8.5 Voice

| Feature | Index |
|---|---|
| `Stage`, `CallStage`, `CallEmpty`, `StagePeople`, `TheaterPeople`, `StageControls` | Call view (§7) under `components/ix/call/`, composing the kept surfaces |
| `StageMenus` (mic menu with Deafen, More) | Kept, restyled (§7.2) |
| Browse (S), side by side with a 420px conversation | **Retired**; chat column (H) instead |
| `StreamSound` | Stream overlay on hover and More › Stream volume and quality |
| `ClipToast`, `StreamReactionsLayer`, `SurfacingMessages`, clips (C) | Kept in the call view |
| `StageChannelPanel` | Call view chat column header (moderators) |
| `ScreenSharePickerModal`, `useShareScreen` | Kept, restyled |
| Soundboard (`SoundboardPopover`, burst) | More › Soundboard |
| `VoiceConnectionCheck` | More › Connection check; Settings › Voice & video |
| Together (`TogetherHost`, sheet, player, stage, now playing) | More › Watch together; the Together stage in the call view; now playing under the card head |
| Listen in | Card listen control; room row right-click |
| Watch without joining | "Watch <name>" on the card |
| Mute preference (pill) | Settings › Join calls muted |
| Voice keybinds | Unchanged |

### 8.6 People

| Feature | Index |
|---|---|
| DMs, groups (`DMPage`, `HomePlaces`, `DmPickerModal`) | People place (§6.6) |
| Friends (`FriendsPage`) | Friends page |
| Group members (`GroupDmMembersPanel`) | People sheet in a group |
| Profiles (`UserProfile`, key verification, block) | Profile card (§6.9) |
| Presence, status, activity (`PresenceActivity`, `PersonRow`) | Presence dot (§2.3), account menu, people sheet rows |
| Member list (`PeopleSheet`) | Toolbar members → people sheet: here now first, then by role, "In Lounge" line for people in a room |

---

## 9. Phone (< 768px)

One React tree, as today: the sidebar and main stay mounted across the
breakpoint; `data-layout="phone"` switches screens and the hidden screen is
`inert` (the existing `phoneNav` store and `phoneMotion`).

- **Root screen = the sidebar** of the current place, full width. The **dock
  is a bottom bar**: 64px plus the safe-area inset, `--ix-side-end`, top
  hairline, 44px hit areas (marks 34), the indicator under the current place,
  horizontal scroll when it overflows. Your avatar sits at the header's right
  (account menu), with "…" left of it.
- The live room card and the pinned call card sit at the top, as on desktop.
- **Conversation is pushed**: tapping a channel, DM, Friends, Inbox or an
  add-on slides the page in from the right (360ms spring; the root moves
  −30% beneath; reduced motion 150ms fade). The dock goes with the root. The
  page has a 52px toolbar (back chevron, folded title, search, members), a
  30/700 large title that folds the same way, and the message box above the
  safe area. Edge swipe or the back chevron returns.
- **Call strip** (phone only, while in a call, on pushed pages): 40px under the
  toolbar: amber speaker, room name, up to 3 faces, the waveform while someone
  talks, and a mute control; tapping it opens the call sheet. An incoming call
  uses the same strip with Decline / Accept.
- **Call as a sheet**: Open call / Watch / the strip present the call view as a
  bottom sheet over everything (top inset: safe area + 8, radius 24 on the top
  corners, grab handle), rising from the card or strip (420ms spring). Drag
  down or Back to chat dismisses it. People tiles in one column (two above two
  people); a stream sits 16:9 at the top with people below; controls at the
  bottom above the safe area. Landscape or the fullscreen control shows the
  stream full screen (theater). No chat column on phone.
- Sheets (people, search, channel pages) are pushed full-screen pages; menus
  are bottom action sheets (radius 20, rows 52); the quick switcher is
  full-screen from the sidebar search field.
- Touch targets are at least 44px; the card's controls are 40px on phone.

---

## 10. Accessibility

- Landmarks: the sidebar is a `nav` named for the place ("Fuel"); the dock a
  `toolbar` named "Servers" with roving focus; main is `main`; the call view a
  `region` named "Call: General". The skip link goes to the message box.
- Every icon-only control has an accessible name that matches its tooltip.
  State lives in names: "clips, unread, 2 mentions"; "Game Night, live".
- One polite live region announces events at most every 2s: "Jeremy joined
  General", "Game Night is live", "Vincent started sharing".
- Grouped bubbles each carry the author and time in a visually hidden prefix
  ("Jeremy, 9:41 PM").
- Keyboard: Ctrl K, Ctrl F, Alt+Up/Down (channels), Alt+Shift+Up/Down (unread
  channels), Ctrl+Alt+Up/Down (places), Ctrl+1–9, Ctrl+Shift+M, Ctrl+Shift+D,
  Ctrl+/, Ctrl+, , Esc, and T / H / C in the call view (macOS: ⌘ for Ctrl).
- Contrast: text 4.5:1 on its real surface at every hue (audit, §2.1); the
  unread dot, live dot and selection edge 3:1.
- **High contrast** (`glass-contrast`): ink-2 `.9`, ink-3 `.78`, hairlines
  `.2`, bubbles `#303136`, hue tints at half strength, selection opaque, focus
  ring 3px.
- **Reduced transparency**: sheets, menus, popovers and the folded toolbar are
  opaque.
- **Reduced motion**: §5.

---

## 11. Server-side changes

| Need | Change |
|---|---|
| Server hue | `spaces.hue INTEGER NULL` (CHECK 0–359) on SQLite and PostgreSQL; `PATCH /guilds/{id}` accepts `hue` (null clears; Manage Server); guild objects, READY and `GUILD_UPDATE` carry it; contract and generated types; route tests on both engines |
| "live N min" on the card | `voice_states.joined_at TEXT NULL`, set on every join and listen join (moving channels resets it), carried on voice states in READY and `VOICE_STATE_UPDATE`; existing rows backfilled to the migration time (voice states are short-lived). The room's start is the earliest `joined_at` among its current members |
| Everything else | Exists: channel previews (G4), listen and view sessions (G5), `VOICE_SPEAKING` fan-out, stream reactions (G17), scheduled events and RSVP, invites, polls, read states |

Both columns ship in one migration pair (`migrations/` and `migrations_pg/`,
prefix `20261004000001`), `TEXT` timestamps, constant defaults then backfill,
booleans none (CLAUDE.md rules). The ambient view kind loses its only client
(room light) and becomes dormant on the server; removing it is a follow-up.

---

## 12. Retired from Glass, and what Glass still governs

**Retired:** room light (backdrop canvas, `--room-rgb` tokens, ambient view
use, stage side glow); the call pill in every form; the places panel UI and the
server circles with amber rings; the compact overlay; browse; the side-by-side
stage with a 420px conversation; the 76px header and "N NEW" kicker; the 720px
fixed column and floating panes with 16px gutters; Home's sections;
`messageLight`; `MotionDirector` (conditional, §8.2); Glass primitives
(`GlassButton`, `Kicker`, `Pane`, `GlassChip`) once nothing imports them; the
two-letter identity monograms and `--color-avatar-1..8`.

**Glass sections that still hold** (Index references them): glass-spec §2.3
font family and self-hosting, §6.4 clips (behavior), §6.5 reactions on the
stream, §7 listen in, §10 and glass-plan §8 (owner decisions that remain:
Watch = the stream, Listen = the voices; one danger color; Split pane retired;
events and polls as cards). Everything else in glass-spec is superseded by
this document.

---

## 13. Defaults decided for this build, follow-ups, owner questions

**Defaults decided** (each can be revisited without reworking the design):

1. Server hue is data (`spaces.hue`) with an id-derived default and a Server
   color setting (§2.2).
2. Room light and the ambient view are retired on the client (§12).
3. The cross-server Home is retired into People (Friends, Inbox, Messages) and
   each server's own card and Coming up (§8.1).
4. "Say hello" fills the message box; it never sends for you (§4.13).
5. Clicking a room row joins it (the prototype's behavior); Listen is the
   card's control or the row's right-click.
6. One live card per server: the busiest room, or yours (§4.3).
7. Closing the call view unsubscribes all video (CPU and bandwidth, §7.3).
8. No `backdrop-filter` on the folded toolbar (CPU, §4.9).
9. Theater covers the sidebar; browse is retired (§7).
10. Add-ons are a sidebar section of two-line rows (§8.3).
11. Categories are sentence-case labels; all rooms sit in one Rooms section.
12. The dock keeps today's server order; no reordering yet.
13. Monograms are one letter for people and servers.
14. The stored theme ids `glass` / `glass-contrast` are kept.
15. Banners are a strip in main, never amber (§6.8).
16. The pill's pre-join mute preference becomes Settings › Join calls muted.
17. Sidebar search is the quick switcher; toolbar search is message search.
18. Leave keeps the prototype's danger tint (one danger color).
19. Phone shows a call strip on pushed pages (§9).
20. The conversation column is capped at 920px and centered (the prototype
    only shows 1280px windows).

**Follow-ups (not in this build):** dock reordering and folders (needs a
server-side order); removing the dormant ambient view kind from the relay and
API; a server-side `unread_count` on read states; thumbnails for media
previews; event capacity ("1 spot left").

**Owner questions:** see the build plan, `docs/design/index-plan.md` §7.
