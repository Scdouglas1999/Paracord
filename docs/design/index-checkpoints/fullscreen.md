# Checkpoint: no voice join lines; a true full screen stream

Owner feedback, 2026-10-05, after using the installed app:

1. "We also don't need a 'X joined General' and 'X left General' message in the
   main text channel literally every time someone joins or leaves."
2. "There also does not seem to be a way to make a live stream truly full
   screen. The participants always live below the stream, which even in theater
   mode stays in a smaller windowed box in the app."

Contract: `docs/index-spec.md` §4.11 (system lines), §7.1, §7.2 (theater),
§7.4 (keys) and the new §7.7 (full screen). Worktree
`~/Documents/Paracord-index`, branch `feat/index-ui`.

## 1. Voice join and leave lines: gone everywhere

Where they came from: only IX-11's `components/message/voiceLines.ts`, a
session store of your own joins and leaves of a server voice channel, drawn as
system lines in that voice channel's own chat (also the call view's chat
column) and in its server's first text channel. Every rejoin, reconnect and
switch added a pair.

Not sources, checked:

- The server writes no message for a voice join or leave, today or in the
  owner's 2026-09-22 build (`615ef4cc`): no non-test caller of
  `create_message_typed` exists in any commit of the history, and the voice
  routes only emit `VOICE_STATE_UPDATE`.
- IX-18's polite live region ("Jeremy joined General") is `sr-only` and stays:
  screen readers hear it, nothing is drawn.

Removed: `voiceLines.ts` (+ test), the timeline's `voice` row
(`timelineRows.ts`, `useArrivals.ts`, `MessageList.tsx`), the `voice` system
glyph and its amber rule. The prototype (local, gitignored) no longer pushes
"You joined General" either, and `ref/` was re-rendered from it (s2 to s6
changed by that line only).

## 2. Full screen, and theater as "the stream, big"

- **State**: `glassStore.stage.fullscreen`, a layer over `mode` (leaving it
  never changes the layout under it). On only with a stream in focus; switching
  streams keeps it; Show everyone, T and closing end it.
  `stageFillsWindow(stage)` is the one rule: a stream in focus in theater or
  full screen.
- **Frame** (`IxFrame`, one attribute): `data-call-fill` puts the call host at
  inset 0; the sidebar is inert under it.
- **Entry/exit**: the header's Full screen (four corners), the same on the
  stream's hover overlay, a double click on the stream, F; Esc steps full
  screen → the layout under it → (theater → main → closed) as before.
- **Window** (`ix/call/windowFullScreen.ts`, mounted by `CallSlot`): Tauri
  `setFullscreen` on the desktop (capabilities: set-fullscreen, maximize,
  unmaximize, set-size, set-position), the Fullscreen API on the document root
  in a browser (the root, not the stream, so popovers portaled to the body
  still show). One queue so a quick on-off-on never overlaps. The previous
  window state is saved and put back when the window manager does not. An exit
  from outside (browser Esc, the compositor) is followed. A refusal is a toast
  and the view goes back (no fallback).
- **Layout** (`ix-call.css`, the last section): immersive (`data-immersive`
  theater | full) = the stream box is the whole surface, contain, on
  `--ix-letterbox`; the header (stream label, sound and quality, Show
  everyone, chat and theater in theater only, full screen, Back to chat), the
  controls and a `mini` filmstrip of 64px faces float over it on
  `--ix-chrome-scrim`, near-solid buttons. Theater with the chat column keeps
  a 384px column at the right. Settled, the page under the fill is
  `visibility: hidden` with its animations paused and transitions off; during a
  move (`<html data-ix-call-moving>`, set by `CallSlot` for every call move) it
  stays so the surface grows over it.
- **Chrome** (`useIdleChrome.ts`): `data-chrome` shown / hidden (80ms fade,
  `--duration-normal`, + 6px) / gone (`visibility: hidden`, cursor `none` over the stream). A real
  pointer move, a tap, a key or focus shows it; 2 s of stillness hides it. It
  stays while the pointer rests on one of its controls (hit-tested at the last
  pointer position when the timer fires, not `:hover`, which goes stale when
  the layout changes under a still pointer), a menu it opened is up, or the
  keyboard is on it. No clock is read (a timer per move), so the harness's
  pinned clock cannot freeze it. One timer at most; none once gone.
- **Mini filmstrip**: faces only, never a camera (one fewer native surface
  under a full-window stream, and no decode); the talker's ring, no waveform.
- **Motion**: entering and leaving is the theater FLIP (`ix-call:theater`,
  275ms) from where the surface was to the whole window.

### Native video

- Every change holds the move guard; the window controller holds its own
  until the page has seen the new size and painted it twice (max 900ms).
  Desktop trace (button in): shield and `data-native-moving` from the first
  sample (15ms), the hole closed by 56ms, the window full screen by 56ms, the
  hole reopened at 338ms on `0,0,1440x928`. Out: closed by 111ms, reopened at
  1088ms on the main box.
- **Found and fixed**: on Linux each surface is a `GtkGLArea` in a
  `gtk::Fixed`, and a visible GLArea's size is part of the window's minimum
  size. Leaving full screen with the stream still drawn screen-sized kept the
  client at 1440x928 under a restored title bar (dock cut off). The exit now
  waits four frames (+40ms) for the guard to have hidden every surface before
  `setFullscreen(false)`; a maximized window that still comes back at the
  wrong size is maximized anew. After the fix: one resize each way, 1440x900
  back every time (4 cycles), a 1307x760 unmaximized window back to 1307x760.

## Verification

- Unit (`client/`): full `npx vitest run` 445 files, 4560 tests, all pass
  (before the final additions; the call, store, keys, glyphs, timeline suites
  re-run after). New or changed: `glassStore.test.ts` (full screen layer),
  `useGlassKeybinds.test.tsx` (F, Esc order, H waits, phone), `CallSlot.test.tsx`
  (button, overlay button, double click, F, Esc, outside exit, theater
  immersive, Show everyone, refusal toast), `useIdleChrome.test.tsx` (5),
  `windowFullScreen.test.tsx` (4: maximized restore, re-maximize at the wrong
  size, size and position restore, outside exit, close ends it, guard),
  `MessageList.bubbles.test.tsx` and `timelineRows.test.ts` (no voice line,
  joins and leaves draw nothing), `TimelineParts.test.tsx`.
- On the tree after the speed-up (`2cb1571a`) and the send-flight commit: full
  `npx vitest run` 445 files, 4561 tests, all pass; `npm run test:e2e:index`
  **266/266** (19.5 min, ports 4813/4815); `npm run test:motion` **20/20**.
  `index-shell`'s theater case now expects the window-filling surface (inset 0,
  square corners, the sidebar inert and not drawn) with a stream in focus.
  The chrome's fade is `--duration-normal` (80ms) on the new scale.
- `npm run typecheck` clean; `eslint` on the touched files 0 errors (the
  known `useArrivals` render-phase warnings); `test:motion-lint`,
  `test:tokens` pass.
- E2E (ports 4813/4815, WP `ixfs`): `index-call` 5/5 including the new full
  screen case (button, Esc, double click, F, theater with and without the chat
  column, the chrome's hide and show, cursor, nothing running at rest),
  `index-timeline` 12/12 (no join line after your join, Nick's join and
  leave), `index-phone` 16/16. Shots in
  `output/design-reference/index-build/ixfs/` (`call-fullscreen`,
  `call-fullscreen-chrome`, `call-theater-stream`, `call-theater-stream-chrome`,
  `call-theater-stream-chat`, `s2-joined`), all read.
- Desktop: release `paracord-desktop` (vpx on, custom-protocol off, devUrl
  :1447) in a nested `kwin_wayland --virtual` 1440x928, its own HOME and
  D-Bus, `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`, under bubblewrap with an empty
  `/dev/snd` and the real PipeWire and PulseAudio sockets covered; its ALSA
  default was a private PipeWire graph with null nodes only (its playback
  stream linked to `fs_null_out`; the real graph saw 0 clients from the app in
  473 polls). It watched (never joined) Vincent's VP9 stream from
  `index-scene.mjs` (`PULSE_SINK=glass_g23_out`) on a throwaway instance on
  :18496. Shots `scratchpad/fs/desk/shots/`: `02-watch-main`,
  `03-fullscreen-chrome` (chrome gone), `04-fullscreen-chrome-shown`,
  `05-after-esc` (the size bug before the fix), `06-unmaximized-after`,
  `07-theater-chrome`, `08-theater`. Letterbox measured on the shots: the
  1440x810 picture at y 59..868 of 928 (full screen) and 73..882 of the
  client (theater), as contain puts it.
- CPU, % of one core, 30 s of `top -b -d 1` (host load 5 to 10 from other
  agents' work), chrome gone, a page sampler saw no animation at all in
  theater and full screen:

| State | WebKitWebProcess | App |
|---|---|---|
| Watching in the call view (main) | 5.8 | 11.6 |
| Theater, the stream filling the window | 4.5 | 12.6 |
| Full screen | 4.1, 4.2 (two runs) | 12.3, 10.9 |

## Left open

- **Native, not this package's file**: the same `gtk::Fixed` minimum size
  means that while any video is visible the window cannot be made smaller than
  the video's right and bottom edge (an unmaximize gave 1410x800, a
  `setSize(1200x760)` gave 1307x760). The fix belongs in
  `native_render/linux.rs` (a host that requests no size from its children,
  e.g. `gtk::Layout`); full screen works around it on exit only.
