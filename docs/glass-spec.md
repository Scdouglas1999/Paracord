# Glass — Paracord's interface

This is the contract for the "Glass" redesign, approved on 2026-09-29 after
fourteen rounds of design review. Where this document and the reference
renders disagree, the renders win on look and this document wins on behavior.

Default appearance update (2026-10-03, owner feedback): quiet pages use a muted
slate blue room tint (`82, 143, 219`) and soft blue primary actions (`#c7daed`,
hover `#d9e7f5`, press `#b8cee4`). This supersedes the amber fallback and cream
primary controls below; the warm/cool content-derived reference samples remain.
Home keeps a named list of joined servers even without activity and offers
Join, Create, and Friends actions when empty. On phones, Home opens its page;
the messages index continues to open the places list.

Lighting refinement (2026-10-03, owner feedback): panes keep their slate tint
and fine edge reflection, without the repeated right-side radial spotlight.
Static monochrome grain on the panels and ambient backdrop softens dark
8-bit gradient contours; high contrast omits the texture. The call pill has
a close, centered amber halo and rim instead of a displaced pool of light.
These refinements supersede the decorative pane glow and below-pill halo
in the original reference renders.

Reference material (in `output/design-reference/glass/`, gitignored):

| File | Shows |
|---|---|
| `screens/01-conversation.png` | Default: a server with a live voice channel, reading General |
| `screens/02-quiet.png` | A server with nothing live (Basecamp), room lit by its banner |
| `screens/03-listen.png` | Call pill expanded while listening in |
| `screens/04-side-by-side.png` | Watching a stream beside the chat, joined, a clip just saved |
| `screens/05-theater.png` | Theater, chat hidden, messages surfacing over the stream |
| `screens/06-browse.png` | Browsing servers while watching, not joined |
| `screens/07-phone.png` | Phone: watching and chatting |
| `source/*.dc.html` | Interactive prototype source (exact sizes, colors, states) |

The prototype's avatars and game art are placeholders. Real profile photos and
real video replace them; nothing here should be tuned to the placeholder art.

---

## 1. Principles

1. **Content is solid; controls are glass.** Bubbles, cards, rows, tiles,
   chips and toasts are solid tonal surfaces with no outlines. Translucency,
   blur and hairlines belong only to things you press: the call pill, buttons,
   the message box, stage controls. Panels are near-solid.
2. **What's live supplies the color.** The interface is neutral. The room
   behind it, and a small tint in every surface, come from the live stream in
   the current server, or from the server's banner when nothing is live.
3. **Amber means live. White means it's for you.** Amber: live channels,
   talking, "Listening", live rings. White: mentions, unread counts that need
   you, the one primary action. No red or green in the interface chrome.
4. **One filled button.** Join (cream `#f4f6f6`, dark text) is the only filled
   button on a screen. Everything else is glass, text, or an icon.
5. **Buttons by role.** Utilities are icon-only (mic, camera, share, layout,
   sidebar, search). Decisions are text (Watch, Leave, Stop watching,
   Post to General, Take the spot, Mark read). Product verbs that need to be
   learned keep icon + label (Listen, Clip).
6. **Symmetry.** Sibling panels share geometry: same radius, gutter, height.
   The owner explicitly rejected a flush sidebar next to a floating pane.
7. **Not Discord.** No server rail, no `#` channel list, no IRC log, no docked
   member list. This is a hard constraint from the owner.

## 2. Tokens

### 2.1 Surfaces (tinted by the room)

Every surface reads from these variables, which the room controller sets on the
app root. Values are the two reference tints; production derives them from the
sampled color (§4).

| Token | Warm (live stream) | Cool (banner, nothing live) | Use |
|---|---|---|---|
| `--pane` | `rgba(28,25,23,.94)` | `rgba(23,27,31,.94)` | Panels |
| `--bub` | `#2d2926` | `#272d34` | Others' bubbles, icon tiles, date tiles |
| `--raise` | `#38332f` | `#313840` | Cards one step above bubbles (plan card, mention bubble) |
| `--sel` | `#36312d` | `#2f363f` | Selected row |
| `--deep` | `rgba(20,18,16,.96)` | `rgba(16,18,21,.96)` | Stage surface, theater chat column |
| `--solid` | `#1c1917` | `#181c20` | Opaque pane color (used for "bite" rings) |
| `--glow` | `rgba(255,168,88,.07)` | `rgba(150,190,230,.07)` | Faint radial in each pane's far corner |

Tint strength is about 5% of the sampled color mixed into a neutral base
(`#131416`). The owner rejected earlier warm versions as "sepia/brown"; do not
exceed 6%.

Fixed colors: own bubble `#ecebe6` with text `#141516`; mention chip `#f3f5f5`
with text `#111214`; amber `#ffc27e` (text on dark: `#ffd6a8`); Join press
`#e8e3d8`.

### 2.2 Text

| Token | Value | Use |
|---|---|---|
| `--ink-1` | `#f3f5f5` | Primary |
| `--ink-2` | `rgba(240,243,243,.76)` | Secondary |
| `--ink-3` | `rgba(240,243,243,.64)` | Tertiary (never lower; ≥ #A3A3A3 equivalent) |

### 2.3 Type

Instrument Sans, variable, with the width axis (`wdth` 75–100, `wght` 400–700).
Self-host it (the desktop app must work offline).

| Role | Size / weight | Notes |
|---|---|---|
| Server title | 28 / 600 | `font-stretch: 92%`, tracking −0.025em |
| Channel title, window titles | 20 / 600 | tracking −0.01em |
| Section title | 17 / 600 | |
| Body, names, buttons | 15 / 400–600 | |
| Secondary | 13 / 400–500 | |
| Kicker (uppercase labels) | 12 / 700 | narrow cut, `letter-spacing: .1em`, uppercase |
| Badges | 11 / 700 | regular cut |

**Instrument cut:** timestamps, durations, dates, counts and "LIVE 42 MIN"
use `font-stretch: 82%` at 12px and up. Never the narrow cut below 12px.

### 2.4 Shape

Radii: panes 28, bubbles 20, rows and tiles 16, small controls and inline chips
8–12. Capsules only for the call pill, the message box, call buttons and pill
buttons. Bubble grouping uses joined corners (6px) on the side facing the
author's avatar: first bubble of a group joins at the bottom, middle bubbles
at top and bottom, the last keeps a 6px "tail" corner. Own messages mirror this
on the right.

Shadows: content `0 1px 2px rgba(0,0,0,.28)`; raised cards add
`0 10px 28px rgba(0,0,0,.2)`; panes `0 40px 90px rgba(0,0,0,.42)` plus
`inset 0 1px 0 rgba(255,255,255,.045)`.

### 2.5 Glyphs

Paracord's own verbs get custom 24×24 glyphs, 2px stroke, round caps and joins.
Stock icons (the repo's existing set) stay for search, people, plus, mic,
camera, share and close.

```
listen   <circle cx="5.5" cy="12" r="1.6" fill/> <path d="M9.5 8.8a4.6 4.6 0 0 1 0 6.4M13.4 5.9a8.8 8.8 0 0 1 0 12.2M17.3 3a13 13 0 0 1 0 18"/>
watch    <path d="M2.8 12c2.6-4.3 5.7-6.4 9.2-6.4s6.6 2.1 9.2 6.4c-2.6 4.3-5.7 6.4-9.2 6.4S5.4 16.3 2.8 12z"/> <circle cx="12" cy="12" r="2.7" fill/>
clip     <rect x="3.5" y="4.5" width="17" height="13" rx="3"/> <path d="M15.2 4.5h2.3a3 3 0 0 1 3 3v2.3z" fill/> <path d="M9 21h6"/> <path d="M8 8.5v5M11 8.5v5"/>
flame    <path d="M12 2.8c.7 3.3 5.2 5 5.2 10.1a5.2 5.2 0 0 1-10.4 0c0-2.2 1-3.6 2.3-4.7.1 2.1 1.1 3.2 2.4 3.6-.6-3-.9-6.1.5-9z"/> <path d="M12 19.6c1.2 0 2-.9 2-2 0-1.5-1.2-2.3-2-3.5-.8 1.2-2 2-2 3.5 0 1.1.8 2 2 2z" fill/>
theater  <rect x="3" y="3.5" width="18" height="11.5" rx="1.6"/> <path d="M5 20.5a1.6 1.6 0 0 1 3.2 0M10.4 20.5a1.6 1.6 0 0 1 3.2 0M15.8 20.5a1.6 1.6 0 0 1 3.2 0"/>
split    <rect x="3" y="5" width="18" height="14" rx="2"/> <path d="M15 5v14"/>
```

Talking waveform: five rounded bars, 3px wide, 2px gap, heights 7/12/14/11/6,
amber, each animating `scaleY(.35 ↔ 1)` at slightly different durations
(0.8–1.2s). Driven by real voice activity when available.

## 3. Layout (desktop)

Two floating panes on the room, 16px from the window edges and from each other:

- **Places panel** — 316px wide, full height (window − 32), radius 28.
- **Conversation pane** — the remaining width, full height, radius 28.
- Inside the conversation pane, the conversation is a **720px column,
  centered**. The channel title starts at the column's left edge; the call
  pill ends at its right edge; the message box matches the column width.
  Search, people and your avatar sit at the pane's right edge.
- Below a 1100px window the column becomes fluid (28px side padding). Below
  about 860px the places panel becomes an overlay opened from the header.

### 3.1 Places panel (`screens/01`, `02`)

Top to bottom:

1. **Server row**: Home/DMs (tray glyph, unread count badge), a hairline, one
   40px circle per server (uploaded icon), `+` (add or join). The current
   server has a 14×3px white bar 11px under it (not a ring). A server with
   something live has a 2px amber ring. Mention badges are white chips with
   dark text; plain unread counts are `#3a3b40` chips.
2. **Server title**: name (28/600, narrow) + chevron, and a line under it
   ("8 online, 3 in Lounge"). Opens the server menu.
3. **Channels**, as rows that show what's in them (no `#`):
   - Text channel: 64px row. 44px lead visual (the last speakers' faces
     overlapped, or the latest media thumbnail, or a glyph tile), name
     (15/600), one-line preview ("Jeremy: @Sean is movie night still on?"),
     time (instrument cut) and a badge (white `@` for mentions, count otherwise).
   - Live voice channel: a 92px row carrying the live stream (or the room's
     tint when voice only) behind a left-to-right dark gradient: name, amber
     "LIVE 42 MIN" kicker, the occupants' faces, the talking waveform and
     "Vincent is streaming". Clicking it opens the stage (§6).
   - Quiet channel (nothing new for a long time): a 44px one-line row, glyph
     and name in `--ink-3`, time on the right.
   - Selected row uses `--sel`. Hover is one step lighter.
4. **Coming up** (kicker), 32px below the last row: event rows with a 44px date
   tile ("TODAY / 9:30", "FRI / 2", instrument cut), title and a line
   ("Lounge, 1 spot left").

### 3.2 Conversation (`screens/01`)

- **Header** (76px): channel title (20/600) with the topic under it (13, ink-2)
  at the column's left edge; the call pill (§5) right-aligned to the column;
  search, members and your avatar (with presence dot) at the pane's right edge.
- **Messages** are bottom-anchored in the column, with a 28px fade under the
  header.
  - Others: 32px avatar at the bottom of the group, name (13/600) and time
    (instrument cut, ink-3) above the first bubble; bubbles `--bub`,
    padding 9×14, max width 78% of the column.
  - Yours: right-aligned, `#ecebe6` with dark text, no avatar.
  - A mention of you: the bubble uses `--raise` and the mention is a white chip.
  - Inline live channel chip: amber tint `rgba(255,170,80,.2)`, text
    `#ffd6a8`, amber dot, "Lounge 3 in".
  - Inline event chip: `#45464b`, calendar glyph, "Movie night Fri 9 PM".
  - Media: 20px radius with the joined corner; no outline, soft shadow.
  - **Reactions** sit as one chip biting the media's top-right corner: `#34353a`
    with a 3px ring in `--solid`, icon + count per reaction.
  - **Hover** on a message group shows react / reply / more (26×22 text
    buttons) beside the name and time. They also appear on focus-within.
  - **Typing** shows as a bubble with three dots beside the typist's avatar.
  - **Catch-up divider**: hairlines either side of "6 new since 8:58"
    (instrument cut, 600) and a "Mark read" text button.
  - **Plan card** (e.g. "Haz 5 run"): `--raise`, radius 20 with the joined
    corner; title, "Tonight at 9:30 PM in Lounge", slots (faces + names, a
    dashed circle for an open slot), and "Take the spot" as a text decision
    ("You're in" with a check once taken). Under 340px wide the slot names hide.
- **Message box**: capsule, 52px, glass, same width as the column; `+`,
  reply chip ("Jeremy ×") when replying, input, emoji, send. Send is a quiet
  circle until there's text, then cream.

## 4. The room (ambient light)

- The backdrop behind both panes is the live stream of the current server's
  busiest live channel, drawn once into a canvas at about 32×18, blurred
  heavily (~64px), saturation 1.1, brightness 0.6, then scaled to the window.
  Draw it once; do **not** use `backdrop-filter` on every pane (WebKitGTK on
  Linux cannot afford it; panes are near-solid, so they don't need it).
- Sample a few times per second and ease colors over 1–2 seconds; clamp
  saturation and luminance so fast-moving video never churns.
- With nothing live, sample the server's banner (or icon) instead. Switching
  servers crossfades over 1.2s.
- From the sampled average, derive the §2.1 tokens (about 5% mix into the
  neutral base) and set them on the app root.
- Reduced transparency: panes become fully opaque `--solid`, the backdrop
  stays but no blur is used anywhere.

## 5. Call pill

A black capsule (`rgba(6,6,7,.97)`, 30px blur, faint amber glow beneath) at
the top of the conversation, right-aligned to the column.

- **Compact** (52px): occupants' faces (24px, overlapped), channel name
  ("Lounge", or "Game Night Lounge" when you're in another server), the
  talking waveform, then controls:
  - not joined: **Listen** (glass, listen glyph + label; amber tint and
    "Listening" when on), **Watch** (text), mute preference (36px glass circle,
    mic or mic-slash; default muted), **Join** (cream).
  - joined: mic toggle, Watch, **Leave** (text).
- **Expanded** (click the faces or name): grows to exactly the column's width
  and about 222px tall (spring, 550ms). Shows a 256×144 stream preview
  (click to watch) and the roster: each person with their state ("Sharing
  screen" and "Talking" in amber, "Muted" in ink-2, "Listening in" for
  listeners). While listening: "Everyone in Lounge can see you're listening in."
- When space is short, it gives up, in order: the talking name, the Watch and
  Listen labels (icons stay), then everything but faces and Join.
- Popovers over text use a near-solid fill (`.97`) and heavier blur than panes.

## 6. The stage (watching)

Watch (on the pill, or the live channel row) grows a stage out of the pill
(shared-element transition: position, size and radius animate together over
650ms; nothing else moves abruptly). **Stop watching** (Esc) returns to the
conversation and the stage shrinks back into the pill. Watching never joins
the call and stopping never leaves it; **Leave** is the only way out of a call.

### 6.1 Side by side (`screens/04`)

- Stage pane on the left, 16px gutters, radius 28, `--deep`, with an ambient
  glow around it sampled from the stream (a soft teal/amber spill left and
  right).
- Stream: full stage width minus 24, 16:9, radius 18. Overlay at the top:
  sidebar button (S), amber live dot, "Vincent's screen" and
  "Game Night Lounge, live for 42 min"; on the right the theater toggle
  (icon, T) and "Stop watching".
- Under the stream: camera tiles for people with a camera (equal widths,
  radius 16, the talker has a 2px amber inner edge and an amber glow, name and
  waveform or mic-off at the bottom). People without a camera are 200×52 chips
  (`#1e1f22`-ish, avatar, name, state, mic-off) in a column at the end of the
  row.
- Controls row at the bottom, centered:
  - not joined: flame, heart, **Clip**, divider, mute preference, **Join**.
  - joined: mic, camera, share, divider, flame, heart, Clip, divider, **Leave**.
- The conversation stays on the right as a 420px pane. It keeps working
  (including a staged reply). Plan card names hide at this width.

### 6.2 Theater (`screens/05`)

- The stream fills the window. The conversation floats as a 380px column on
  the right (`--deep`), with the stage buttons moved left of it.
- Camera: only the talker gets a 168×112 tile, top left; everyone else is a
  52px face with a ring (amber for sharing/talking, faint for others) and a
  mic-off badge when muted; faces get a light ring on hover.
- Controls are a glass capsule centered on the visible stream area.
- The chat toggle (H) hides the conversation. While hidden, new messages
  surface over the stream at the bottom left (bubble tone at 92% with a 12px
  blur; a mention of you gets a 1.5px white edge) for a few seconds; clicking
  one brings the chat back.

### 6.3 Browsing while watching (`screens/06`)

The sidebar button (S) slides the places panel back in. In side by side the
stream slides right and grows (the stage becomes 1076px wide) and the
conversation steps aside; in theater the panel floats over the stream's left
edge and the tiles and controls move over. Picking a channel or server closes
the panel and brings that channel's conversation back beside the stream. The
stream keeps playing throughout.

### 6.4 Clips (C)

Clip saves the last 30 seconds of the stream you're watching without
interrupting anything. A toast appears centered at the top of the stream:
thumbnail, "Saved the last 30 seconds", "From Vincent's screen, 9:14 PM",
**Post to General** (text), and dismiss. Posting drops the clip into the
channel as your message (media bubble with a play button and "0:30 from
Vincent's screen"). Implementation: the client keeps a 30-second ring buffer
of the encoded stream it already receives; clips upload through normal
attachments. The relay does not change.

### 6.5 Reactions on the stream

Flame and heart (and later more) float up from the bottom right of the stream
for everyone watching, each with the sender's face in its corner, rising about
270px and fading. Sent as small gateway events scoped to the voice channel,
limited to one per second per person and merged when busy.

## 7. Listen in

Hear a voice channel quietly before joining (receive only, never send). Other
people in the channel see "Sean — Listening in" in the roster, so it never
feels like eavesdropping. Needs a listen-only voice state on the server that
shows in presence, and a per-channel setting to turn it off. Join from
listening is seamless (no reconnect gap).

## 8. Phone (`screens/07`)

Stacked: stream (16:9, radius 22, back / clip "30s" / fullscreen overlays,
"Vincent's screen" and "2 watching"), then the call pill as two rows (faces,
"Lounge", waveform and who's talking; then Listen, mute circle, Join filling
the rest), then the channel header ("General", "Game Night", "6 NEW" kicker),
the conversation, and the message box with the reply chip. No server rail;
the places panel is its own screen.

## 9. Motion and interaction

- Hover: one token step lighter (fill +4% white). Press: one step darker.
  120ms ease-out. Nothing scales on press. Join darkens to `#e8e3d8` on press.
- Layout changes (pill → stage, side by side ↔ theater, browse): 600–650ms
  spring on transform, size and radius. Content fades, never pops.
- The room eases over 1–2s; server switches crossfade over 1.2s.
- Reduced motion: layout changes become 150ms crossfades; the waveform and
  floating reactions stop animating (reactions appear briefly in place).
- Keyboard: S sidebar, T theater, H hide chat, C clip, Esc stop watching.
  Every control has an accessible name and a visible focus ring
  (`2px solid rgba(255,255,255,.85)`, offset 2).
- Text contrast is at least 4.5:1 against its actual surface.

## 10. What's new on the server side

| Feature | Needs |
|---|---|
| Room light | Nothing server-side (client samples decoded frames; banner as fallback). |
| Clips | Nothing new beyond attachments; client ring buffer. |
| Reactions on the stream | A voice-channel-scoped gateway event, rate-limited. |
| Listen in | A listen-only voice state visible in presence; per-channel setting. |
| Live channel rows, faces, previews | Existing channel/presence/voice data; last-message previews if not already served. |
| Plan cards ("Take the spot") | Only if a plans/slots feature exists; otherwise render events and polls with this card style and leave plans for later. |
