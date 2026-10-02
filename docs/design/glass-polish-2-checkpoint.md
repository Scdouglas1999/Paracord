# Glass polish 2 checkpoint

Contract: `docs/glass-spec.md`. Read first: `docs/design/glass-summary.md`, and the checkpoints each item answers
(G18 sheets, G22 retire Lantern "Left for others", the watch-audio fix for the cover math). Branch `design/glass`,
nothing committed. Six items, all in `~/Documents/Paracord-glass`: the owner-approved defaults (pill above sheets,
camera crop anchor, reactions for screen readers) and the three open items G22 left (two buttons with one name, dialogs
closing at 768px, the call view with no cameras).

Everything below was checked in the running app: 15 browser checks in `e2e/glass-polish-2.spec.ts` (their own config and
ports, 4483/4485) and the screenshots listed per item, in `output/design-reference/glass-build/polish-2/`.

| # | Item | Result |
|---|---|---|
| 1 | The call pill stays visible and usable above every sheet, desktop and phone | A sheet draws the pill itself; the covered one goes inert |
| 2 | A camera crop falls toward the upper third (anchor `y: 0.35`) | `anchor` option on `CanvasRenderer`, both engines, the native tile, and the Linux shader. macOS keeps the center (see "Not done") |
| 3 | Reactions are announced to screen readers, politely, at most once every 2 s | A hidden live region in `StreamReactionsLayer` |
| 4 | An expanded pill had two buttons named "Watch Vincent's screen" | Merged: the preview is for the mouse, one button for AT |
| 5 | Dialogs closed when the window crossed 768px | The frame is one React tree for every layout now |
| 6 | The call view with no cameras | `CallEmpty`: faces large and centered, the call's name, "No one is sharing" |

## 1. The call pill above sheets

**The problem.** A sheet is a solid page over the conversation pane (G18), so it covers the conversation header and the
pill in it. Joined to a call, you could not reach the microphone or Leave until you closed the sheet.

**What it does now.** Every `SheetFrame` draws a `CallPill` of its own (`placement="sheet"`) in the place the header's
was:

- **Desktop.** Inside the sheet header, between the title and the buttons, right aligned to the column, 6px under the
  header's top and 52px tall, exactly where the conversation header has it, so it does not jump when a sheet opens. The
  title gives up to 40% of the row (as in the conversation header) and the pill the rest, so it gives up its labels in
  the same order (§5). In the search sheet the field keeps most of the row and the pill gets 34%. The header sits above
  the body (`z-index: 2`), so an expanded roster grows over the page as it does in the conversation.
- **Phone.** A row above the sheet's header, 12px in, edge to edge, where the conversation puts it. It is in the flow, so
  expanding it pushes the sheet down rather than overlaying it.
- **No overlap.** The close button hangs at the pane's edge, past the column's end where the pill stops. Measured in the
  browser (1440 and 390): the pill's box intersects neither the title, nor the search field, nor the close button, and
  lies inside the sheet.

**One pill to reach.** The pill under the sheet is not unmounted (its place and expanded state are as they were when the
sheet goes). While any sheet is mounted it is `inert` and `aria-hidden`, and it does not say what the sheet's says
(`pill/sheetCover.ts`: `SheetFrame` registers while mounted, its leave included; `CallPill` reads it). Any `SheetFrame` is
counted, whichever page opened it: search, people, the channel pages, reminders, and the dialogs the channel menu opens
(`TopBarOverlay`: summary, follows, inbox, shortcuts).

**Keyboard and focus.** The sheet is `aria-modal` with a focus trap, so the pill had to be inside it. It sits after the
close button in the document and before it on screen (flex order, and `order: -1` on the phone), so the first focus still
lands on the sheet's own first control and Tab reaches the pill's buttons and stays inside the sheet. **Escape on an
expanded pill now only puts its roster away** (`stopPropagation` in the pill's key handler): before, the same keypress
also reached the trap and closed the sheet under it. The next Escape is the sheet's.

**Which pill.** `SheetFrame` reads the route (`useParams`): the server and the channel for a channel, nothing for a DM, as
`ConversationPane` passes them, so a voice channel's own chat shows that channel's pill even with nobody in it (rule 0).
The row layout still hides the pill while a stage is open (the stage has the controls); so does the sheet's.

Files: `pill/CallPill.tsx`, `pill/sheetCover.ts` (new), `pill/index.ts`, `sheets/SheetFrame.tsx`,
`styles/glass-sheets.css`, `shell/slots.ts` (`CallPillProps.placement`, optional).

Tests: `sheets/SheetFrame.pill.test.tsx` (11, new): the pill is in the sheet's header; one region in the accessibility
tree and the covered one `inert`/`aria-hidden`; the header's pill returns when the sheet is gone; first focus on Close;
Tab reaches Join and "Show who's in" and stays inside; Escape collapses the roster and leaves the sheet; a voice
channel's route shows its pill with nobody in it; no pill means an empty slot; a closed sheet covers nothing; one
announcement, not two; the phone's row above the header.
Browser: `the call pill stays reachable over a sheet at desktop|phone`, `the pill sits beside the search field at
desktop|phone`, `a channel menu page keeps the pill too…`.

Screenshots: `sheet-pill-people-{desktop,phone}.png`, `sheet-pill-expanded-{desktop,phone}.png`,
`sheet-pill-search-{desktop,phone}.png`, `sheet-pill-media-desktop.png`, `sheet-no-pill-desktop.png`.

Read: the pill sits where the conversation header's does, right aligned, clear of the title and of the close button; the
expanded roster overlays the member list and is not painted under it; on the phone the pill is a two-row capsule above
"Members". One pre-existing detail shows in the expanded shot: a 1px sliver of the title's first letter at the pill's
left edge. The conversation's own expanded pill has the same sub-pixel mismatch (`fitColumn` rounds the width); it is
not new and was left.

## 2. Camera crop anchor

**The math.** `cover` scales the frame until it fills the tile and crops what overflows. It cropped evenly. An anchor
says where the crop falls, read as CSS `object-position`: `0` keeps the start of an axis (the top, the left), `1` the
end, `0.5` crops evenly (the default). Only the axis the picture overflows is cropped, so on a picture taller than its
tile `y` decides and `x` does nothing, and the other way round. A camera tile anchors at `{ x: 0.5, y: 0.35 }`: 35% of
what has to go comes off the top and 65% off the bottom.

**Canvas route** (`lib/media/video/canvasRenderer.ts`). `CanvasRendererOptions.anchor`, `resolveAnchor` (a value outside
0 to 1 or not a number throws `RangeError`: a bug in the caller is refused, not clamped into a crop nobody asked for),
`placeOnAxis(canvas, draw, anchor)` and `CENTER_ANCHOR`. `measureRenderSize` places the picture with the anchor under
`cover` and the center under `contain`, which crops nothing, so the default draws exactly what it drew.

**Plumbing** (option passed through only): `SubscribeVideoOptions.anchor` (`mediaEngine.ts`), `browserMediaEngine.ts`,
`tauriMediaEngine.ts` (to the renderer and to the native tile), `nativeVideoTile.ts` (sends `anchor` in
`native_render_attach` only for `cover`).

**Stage.** `CameraTile` (`stage/StagePeople.tsx`) requests `{ preferredTrackId: 'camera', fit: 'cover', anchor:
CAMERA_ANCHOR }`. Theater reuses that tile, so it did not change.

**Linux native shader** (`native_render/mod.rs`, `linux.rs`). `SurfaceFit` is now `Contain | Cover { anchor }` (the anchor
belongs to the fit that crops). `SurfaceFit::parse(fit, anchor)` reads strictly: an unknown fit, an anchor outside 0 to 1
or not a number, and an anchor with `contain` are all refused. `uv_window` returns the shader's window:
`sample = (uv - 0.5) * scale + center`, with `center = anchor * (1 - scale) + scale / 2` on a cropped axis (so the
anchor `0.5` is exactly `0.5`) and `0.5` elsewhere. `linux.rs` gains the `uUvCenter` uniform. The tile's top is
v = 0 (the quad maps v = 0 to the top), so an anchor of 0 shows the top row.
`native_render_attach` takes `anchor: Option<{x?, y?}>`.

**macOS** (`native_render/macos.rs`). **Not applied.** `AVLayerVideoGravityResizeAspectFill` has no anchor. Moving the
crop means hosting the display layer as a sublayer of a clipping view and laying it out from each frame's dimensions, a
rework of a file that cannot be compiled or run on the Linux toolchain (no macOS target is installed here either). The
anchor is read and validated, the surface crops about the center as before, and says so once per surface in the log when
the anchor is not the center.

**Tests.** TS: `canvasRenderer.test.ts` (+7: a tall frame anchored at 0.35 crops 59px off the top of 167, not 84; the ends
0 and 1; a wide frame along its width and the other axis untouched; no bar for any anchor over 72 shapes; contain
ignores it; bad values throw; GL viewport on the WebGL backend), `nativeVideoTile.test.ts` (+1), `tauriMediaEngine.fit.test.ts`
(+2: both routes), `browserMediaEngine.videoSharing.test.ts` (+1), `Stage.test.tsx` and `TheaterPeople.test.tsx` (the
camera asks for `anchor: { x: 0.5, y: 0.35 }`). Rust: `native_render::tests` +5 (the anchor read strictly, as the
webview sends it, a tall frame keeps its top, a wide frame moves its sides, no bar for any anchor over 216 shapes; the old contain-equals-the-shader test is kept) and the old ones moved to `uv_window`.

**Browser, the real renderer.** `holdPortraitCamera` gives the call an engine that draws a 540x960 portrait picture with
the real `CanvasRenderer` and whatever options the stage passes. The picture has a green band at 17 to 22% of its height,
a red band at 71 to 76% and a scale of labeled ticks. With the anchor the tile keeps green and loses red; the control
(same engine, anchor left out) keeps red and loses green, which is the old behavior:
`a portrait camera in a wide tile keeps its faces…` and `the same camera, cropped about the center…`.
Screenshots: `camera-anchor-desktop.png` (the tile shows 16% to 70% of the picture: the eyes are in it) and
`camera-center-control-desktop.png` (23% to 77%: only the chin).

## 3. Reactions for screen readers

`StreamReactionsLayer` keeps a visually hidden `role="status" aria-live="polite" aria-atomic` region next to the bubbles
(outside the `aria-hidden` layer, and always in the page, since a live region that appears with its text is not reliably
announced).

- **What it says.** "Brendan reacted with a flame" (a heart: "with a heart"). The name is the one on the bubble (display
  name, else username). A merged tap into a rising bubble has no one to name: "1 reaction".
- **When.** At most once every 2 s (`ANNOUNCE_INTERVAL_MS`). The first reaction is said at once; what arrives meanwhile is
  held and said together when the interval is up ("3 reactions", counting each tap, merges included). The line is
  replaced as a new node each time, so the same words twice are heard twice, and cleared after 6 s.
- **Never your own** (`own` bubbles are skipped and not counted), never what was already on screen when the layer
  mounted, never another stream's.
- It is derived from the bubbles the store already holds, so the store is untouched.

Tests: `StreamReactionsLayer.test.tsx` (+11 in "for screen readers": the region and its attributes, the sentence, the
username fallback, never your own, the 2 s throttle and the merged "3 reactions", multi-tap counts, busy-stream merges,
nothing for what was already there, repeat as a new line and the clear, no timer after unmount, the sentence function).
Browser: `reactions are announced politely, once every two seconds, never your own` (a real 2 s wait: one flame, then
three held and said as "3 reactions").

## 4. One Watch button in an expanded pill

The G22 checkpoint's "two buttons named Watch Vincent's screen". Fixed by merge, not by renaming. The bar's Watch button and
the preview open the same stage, and "Watch" alone is a poor name for the bar's button when its label is hidden at the
narrow levels. While the bar's button is drawn, the preview is `aria-hidden` with `tabindex="-1"` (still a big target for
the mouse, still focusable by script). Where the bar has no Watch button (the phone with the stage already open) the
preview is the only door and keeps its name.

Tests: `CallPill.test.tsx` (one button with that name in the tree, and it is the bar's; the preview keeps its name when
the stage is open; the preview still watches on click). Browser: `an expanded pill has one Watch button…`, with the
screenshot `pill-expanded-one-watch-desktop.png`. Every other spec that clicks "Watch Vincent's screen" does it from the
compact pill, where there was only one.

## 5. Dialogs closing at 768px

**Why.** `GlassFrame` returned `<PhoneFrame>` below 768px and its own tree above. Two component types at the root: React
unmounted one tree and mounted the other, so the conversation page, `Sheets` and the stage were rebuilt, and
everything held in their local state went with them (the message edit history dialog, a draft, a scroll position, a
sheet's page). Measured before the change (in the browser, the same test against the old frame): the `main` element
after the resize is a different node.

**The fix.** One tree for every layout:

- `GlassFrame` renders `.glass-frame` and, inside it, the conversation's wrapper, the stage `<section>`, `<main>` and
  `<Sheets>` at the same places in every layout. Only what a layout alone has is mounted and unmounted: the wide places
  pane, the phone's places screen and its scrim, the morph layers, the places overlay, the phone stage's chrome.
- The wrapper is the phone's conversation screen (`glass-phone__screen--conversation`, the same classes) on a phone, and on
  the wide and compact frames a `display: contents` element (inline style, no CSS file touched) holding places, stage and
  `main`, so they are still the frame's flex items and `stageTransition`'s `:scope > .glass-frame__*` measurements find
  them (the move's ref points at the wrapper there, and at nothing on a phone, which has no moves).
- `PhoneFrame` is gone. Its state, the move between the two screens and where focus goes after it are `shell/usePhoneFrame.ts`,
  called by `GlassFrame` in every layout and acting only while the window is a phone. The window becoming a phone plays no
  slide.
- `AppShell.tsx` needed no change.

**What survives a resize across 768px** (browser, 700 to 1000 and back, twice): the same `main` and page elements, the open
message edit history dialog, the draft in the message box and the scroll position (unit-tested on the DOM node). A sheet
stays open too; its host changes (the pane at 1000, the window at 700, G18's design), so the sheet remounts there and plays
its enter again, but it is not closed and its page and its route state are the store's.

Tests: `shell/GlassFrame.layouts.test.tsx` (7, new: the same nodes and a dialog across wide, phone, compact; `Sheets`
mounted once; the stage and its local state across a watch resized to a phone and back; a scroll position; only the
layout's own parts; the wide body takes no box; no slide for becoming a phone), `shell/GlassFrame.phone.test.tsx` (the 22
old `PhoneFrame` tests, ported to `GlassFrame layout="phone"`). Browser: `a window resized across the phone breakpoint
keeps its dialog, its draft and its sheet`, which fails against the old frame at the node-identity check.
Screenshots: `resize-1-wide-dialog.png`, `resize-2-phone-dialog.png`, `resize-3-wide-again-dialog.png`,
`resize-4-sheet-phone.png`, `resize-5-sheet-wide.png`.

## 6. The call view with no cameras

**Before.** "Nobody has a camera on." centered over an empty pane, with the people as 200x52 chips in a column at the end.

**Now** (`stage/CallEmpty.tsx`, used by `CallStage`'s empty branch; nothing else of `CallStage` changed): with nobody on
camera the people are the stage.

- **Faces**, large and centered in the area the stage leaves: 128px for one or two, 112 up to four, 96 up to six, 72 up to
  ten, 56 beyond; the rows share them out evenly (nine are five and four, not eight and one: `--call-columns`). Each has its
  name under it.
- **The talker** wears an amber ring (a dark gap, then amber, the theater's recipe) and a soft amber glow on its own
  layer, with the waveform beside the name, following the real voice level where this client hears it. Everyone else has
  a faint ring. "Mic on" is not drawn (it is what everyone is, and a screen reader still hears it); Muted, Listening in,
  Sharing screen and Talking are, in the chips' own words. A muted person has a mic-off badge on the face.
- **Under them**, quietly: the call's name (22/600, the same name as the title row and `aria-hidden` so it is not read
  twice) and the line (14, ink-3): "No one is sharing". The line is the existing `role="status"` and says what the
  situation is: "Join the call to see cameras and share your screen." and "Joining …" before you are in, "You are
  sharing your screen. Everyone in the call can watch it." when it is you, and "Vincent is sharing their screen" (and two or
  more) when someone else is.
- **Someone else sharing.** Their face is a button, "Watch Vincent's screen", ringed in amber with "Sharing screen"
  under it. A click switches the stage to their stream, as before. Yours never is.
- **The controls stay** in their row below it, and the title row (S, the call's name, Close) is unchanged.
- **A camera turning on** puts the tiles and chips back (`StagePeople`), and off puts the faces back.
- **Phone.** The card is 120px of room between the chrome over it, so the faces are 56px (48 for five, 36 for up to ten),
  one row of up to five, the talker's waveform under the name in place of the word (kept for a screen reader), and no name
  or line drawn (the card's chrome names the call; the line stays `sr-only`). Full screen is the same.
- **DM call.** The same, named for the person.

The old `.glass-stage__call-notice` rules in `glass-stage.css` are gone with the element.

Tests: `stage/CallEmpty.test.tsx` (15, new: the list and the call under it, the talker's ring and waveform, mute and
listening badges, a sharer's button and yours, no people, the phone, the sizes and the even rows, `callNotice` for every
case), `Stage.test.tsx` (the empty state on the stage; a camera turning on puts the tiles back; the DM names the person
in the new class). Browser: `the call with nobody on camera…` (desktop, someone starts sharing, phone card and full
screen, a DM) and `a camera turning on puts the tiles back…`; faces centered on the pane within 6px, no face outside the
phone card.
Screenshots: `call-empty-desktop.png`, `call-empty-sharing-desktop.png`, `call-empty-dm-desktop.png`,
`call-empty-phone.png`, `call-empty-phone-fullscreen.png`.

Read: calm and in the Glass language: dark pane, faces the only color, amber only on who is live. The first draft
overflowed the phone card (the faces ran under the back and full-screen buttons because the empty state ignored the
main area's padding) and six people wrapped five and one on the desktop; both are fixed above and re-shot.

## Verification

All from `~/Documents/Paracord-glass`; the client commands in `client/`, the Rust ones through
`~/Documents/Paracord-wt/tools/pc-cargo.sh` with `vpx` on (never disabled).

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | 407 of 408 files, 4,191 of 4,192 tests pass. The one failure is `PlanCard.test.tsx` (wall-clock dependent, see "Not done") |
| `npm run test:tokens` | pass: 796 files hold no literal color |
| `npm run test:motion-lint` | pass: 802 files animate only transform and opacity |
| `npm run lint` | 0 errors (214 warnings, none in a file this touched; the touched directories lint clean) |
| `npm run test:contrast` | pass: 52,950 comparisons |
| `npm run test:a11y:static` | pass |
| `pc-cargo.sh check/clippy -D warnings --all-targets` (`client/src-tauri`) | clean |
| `pc-cargo.sh test --all-targets` | 144 passed, 2 ignored (139 before: +5 anchor tests) |
| `cargo fmt --check` (`client/src-tauri`) | pass |
| `glass-polish-2.config.ts` (new, 15 browser checks) | 15 of 15 |
| Existing glass specs, each on its own config and ports, shots to `polish-2-regress/` (the G-level shots untouched) | `glass-pill` 12 of 12, `glass-stage` 8 of 8, `glass-theater` 9 of 9, `glass-sheets` 14 of 14, `glass-phone` 27 of 27, `glass-calls` 5 of 6. The one failure is the DM call's `Share your screen` assertion (`toHaveCount(0)`): the concurrent DM-calls agent turned that button on in `StageControls.tsx`, so the spec's old expectation is theirs to change |

## Not done, and uncertain

- **macOS applies no anchor** (item 2): centered crop as before, logged once. A real fix is a layer-hosting rework that has
  to be built and run on a Mac.
- **The Linux shader change was not run on a real GL surface here.** The math is unit-tested against the old shader's samples
  and the build is clean with the Rust tests passing, but the native-surface route needs the desktop app on a GPU; the
  browser proof above is the canvas route. The same goes for `native_render_attach`'s new argument against the webview's
  IPC: the TS side is tested to send it only for `cover`, and Rust refuses it otherwise.
- **A sheet remounts across the phone breakpoint** (its host changes, G18's design): it stays open but replays its enter
  animation and loses its own scroll position. Making the host stable would mean a portal into a node that moves between
  panes.
- **The expanded pill's 1px sliver** over a sheet's (or the header's) title is the existing rounding in `fitColumn`.
- `PlanCard.test.tsx` "shows the event…" fails when the suite runs after about 9 PM here: it expects "Today at" for an event 3
  hours ahead, which is tomorrow past midnight. It is time-of-day dependent and not touched by this work.

## Outside the file scope

Nothing was edited that the brief did not name, apart from these, each needed by an item and listed so they can be
rejected:

- `components/glass/stage/CallEmpty.tsx` and `CallEmpty.test.tsx` (new files in the stage directory, to keep the
  `CallStage.tsx` change to the empty branch while the DM-call agent edits that file); `Stage.test.tsx` and
  `TheaterPeople.test.tsx` (expectations for items 2 and 6).
- `components/glass/shell/slots.ts` (an optional `placement` on `CallPillProps`), `usePhoneFrame.ts` (new), and
  `PhoneFrame.tsx` / `PhoneFrame.test.tsx` removed (item 5; all under `shell/**`).
- `e2e/glass-polish-2.spec.ts` and `e2e/glass-polish-2.config.ts` (new files, own ports; the pattern G18 and G22 used).
- Stale references this leaves, not edited: `styles/glass-phone.css` (a header comment names `PhoneFrame.tsx`, and a
  `.glass-stage__call-notice { display: none }` rule now matches nothing), `docs/design/glass-summary.md` line 72
  (lists `PhoneFrame`), and the historical G20 and G22 checkpoints.
