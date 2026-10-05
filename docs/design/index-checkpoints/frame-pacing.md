# Checkpoint: the desktop window paced by the compositor (Linux, Wayland)

The owner, on `651430c1` (RTX 4080, KDE Wayland, 5120x1440 at 240 Hz): the
animations look low frame rate and jittery. The full account, with the
measurements, is "Second pass: frame pacing" in
`docs/design/desktop-framerate.md`. This page is what the next package needs.

## What changed (desktop shell only; no client code)

- `client/src-tauri/src/linux_frame_clock.rs` (new). On Wayland the main
  window's GTK frame clock is paced by KWin's frame callbacks: a
  `wl_surface.frame` request rides on every paint's commit, the clock is
  frozen until KWin answers, the answer thaws it as soon as a redraw is
  waiting (the toplevel's invalidate handler) or after one refresh, and the
  display's refresh interval is written into the frame timings so GTK stops
  assuming 60 Hz. Installed from `lib.rs` (`pace_main_window`) at setup;
  X11 keeps GTK's own clock.
- `native_render/linux.rs`: the webview is opaque in the ground color unless
  a native video surface exists (`sync_webview_background`), transparent from
  the first surface's creation until the last one is destroyed.
- `PARACORD_FRAME_TRACE=1` prints one line per presented frame
  (`wp_presentation`), the paint time and the frame-callback timing to
  stderr. It works on a real display (with the hardware vblank counter), so
  pacing can be captured on the owner's machine.
- `Cargo.toml`: `gdkwayland-sys` (already linked through tao).

## Result (nested KWin, RTX 4080, 5120x1412 at 239.9 Hz)

The Index motions (glide, place switch, composer FLIP) went from 45 to 54
frames a second with 50 to 64% of frame intervals changing length to 162 to
202 frames a second, 84 to 93% of them one refresh apart. Commit to screen
11 to 20 ms → 4 to 6 ms. App CPU in a glide loop 36% at ~58 fps → 28% at
~200 fps.

## For whoever is next

- Index motion must stay on WebKit's compositor thread (Web Animations or CSS
  on `transform` / `opacity`, which the motion lint already enforces) to get
  the display's rate. Anything driven by `requestAnimationFrame`, React
  re-renders or scrolling runs on WebKit's 61.5 Hz display-link timer and
  lands unevenly on a 240 Hz display; that is not fixable from the app.
- While a video surface exists the webview is transparent and each GTK paint
  costs 9 to 13 ms at 5120x1412, so the call view's theater moves still run
  at about 40 to 47 fps. The fix is the video in Wayland subsurfaces.
- Do not add code that assumes the window paints while minimized or fully
  covered: it does not (KWin sends no frame callbacks then), as with any GTK
  `wl_shm` window.
- The release binary was not built.
