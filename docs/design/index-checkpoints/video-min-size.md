# Checkpoint: a shown video no longer sets the window's minimum size (Linux)

Found by two passes (`fullscreen.md` "Left open", `docs/design/desktop-framerate.md`
findings): on Linux, while any native video surface was showing, the app
window could not be made smaller than the video's right and bottom edge. An
unmaximize landed at 1410x800 instead of 1280x800, `setSize(1200x760)` at
1307x760, and a stream drawn screen-sized kept the window screen-sized after
leaving full screen (which `windowFullScreen.ts` worked around on exit only).

## Cause

`native_render/linux.rs` hosts each `GtkGLArea` in a `gtk::Fixed`, the
`gtk::Overlay`'s main child under the transparent webview. A `gtk::Fixed` asks
for the union of its children's rects, and each GLArea's rect is its
`set_size_request(w, h)` at `move_(x, y)`. The overlay asks for what its main
child asks for, the window turns that into its minimum size
(`xdg_toplevel.set_min_size` on Wayland), and so the video, which follows the
page, was pushing the window that the page lays itself out in.

## Fix

`UnderlayFixed` (a private `gtk::Fixed` subclass in `linux.rs`) answers every
preferred-size query (width, height, and the for-height / for-width variants)
with 0x0. Everything else is the plain `gtk::Fixed`:

- allocation is unchanged: `GtkFixed::size_allocate` still gives each child its
  own requested size at its own position, so each GLArea lands exactly on the
  rect the page reported;
- it is still a no-window widget, so the stacking under the webview, the
  input shape and the drawing order are what they were;
- the GPU frame transport (`9812e663`, `GDK_GL=always` on NVIDIA under
  Wayland) is untouched; the verification ran on it.

The window's minimum size is the webview's again (940x560 from
`tauri.conf.json`).

`windowFullScreen.ts`: the four-frame wait for every surface to be hidden
before `setFullscreen(false)` is removed; it existed only for this bug.
`restore()` (re-maximize a maximized window that comes back at the wrong size;
put back an unmaximized window's size and position) stays as the general
restore, and the move guard still covers every change.

### macOS and Windows (code read only)

Neither has the pattern. macOS adds each surface as a frame-positioned
`NSView` subview below the `WKWebView` (`addSubview:positioned:relativeTo:`,
`setFrame:`); no Auto Layout constraints are added, so a subview's frame never
reaches the window's content minimum size. Windows draws through
DirectComposition visuals on the webview container's HWND; visuals take no
part in window sizing (`WM_GETMINMAXINFO` is not involved).

## Verification

Nested `kwin_wayland --virtual` 1440x928 on the NVIDIA render node (the
framerate pass's device-order shim), its config in its own
`XDG_CONFIG_HOME` (the real `~/.config/kwinoutputconfig.json` was backed up
first and is byte-identical afterward). The app: release `paracord-desktop`
(vpx on, no `custom-protocol`, devUrl :1447), its own HOME and D-Bus, in
`bwrap` with an empty `/dev/snd` and the real PipeWire and PulseAudio sockets
covered, its audio going to a private PipeWire graph with null nodes only.
`[webkit] frame transport: GPU (dmabuf)` (NVIDIA EGL on Wayland,
`GDK_GL=always`). It watched (never joined) Vincent's VP9 stream held by
`index-scene.mjs` (`PULSE_SINK=glass_g23_out`) on a throwaway instance (:18496),
as a separate account (Sam).

Same steps, `before` = the full screen pass's test build (the
`9812e663` tree), `after` = this change. Inner size in physical px:

| Step | Before | After |
|---|---|---|
| unmaximize (default 1280x800) | 1410x800 | 1280x800 |
| `setSize` 1200x760 | 1307x760 | 1200x760 |
| `setSize` 1000x640 | 1220x640 | 1000x640 |
| `setSize` 940x560 | 1070x560 | 940x560 |
| `setSize` 800x500 (below the minimum) | 940x560 | 940x560 |
| `setSize` 1300x850 | 1300x850 | 1300x850 |
| `setSize` 960x600 | 1270x619 | 960x600 |

After the change, also:

- compositor resizes (KWin `frameGeometry`, as a drag does) with the stream
  shown: 1360x860, 1000x680, 700x400 (clamped to 940x560 + frame); in theater
  (the stream filling the window) 1200x800 then 950x590: every one exact;
- maximize, theater, full screen from theater by the control, Esc back to
  theater (1440x900, maximized) four times; F in and out from a 950x562
  unmaximized window four times (back to 950x562 every time, without the
  removed wait); double click in and out; the compositor's own full screen
  exit (the window came back to 960x600 from a screen-sized stream);
  closing and reopening the call view;
- alignment: every step's screenshot was cropped at the stream box's four
  corners at 6x with the DOM rect drawn over it; the video's rounded corners
  sit on the hole's corners in every state, and the full-window states show no
  ground-color seam.

Shots (scratchpad, `rz/desk/shots/`): `02-before-watch`,
`03-before-after-resizes`, `10-fix-960x600` (+ `-corners`), `13-theater-fullscreen`,
`14-esc-to-theater`, `22-kwin-700x400`, `25-kwin-theater-950x590`,
`48-dbl-out` (+ `-corners`), and one per step listed above.

Gates: `cargo fmt --check`; `cargo clippy -p paracord-desktop --all-targets
-- -D warnings` (vpx on); `cargo test -p paracord-desktop` 162 passed, 2
ignored; `npm run typecheck`; `eslint` on `windowFullScreen.ts`; vitest
`src/components/ix/call` 5 files, 43 tests.

No unit test covers `UnderlayFixed` itself: it needs a GTK display, which the
crate's tests do not have.

## Left open

- Leaving full screen from outside the app is not followed on the desktop
  (Tauri's `isFullscreen()` on Linux returns tao's cached request). See
  `fullscreen.md` "Left open".
- A `Gtk-CRITICAL gtk_widget_get_scale_factor: assertion 'GTK_IS_WIDGET
  (widget)' failed` is printed once at startup, before any video; earlier
  builds print it too. Not investigated.
- The release binary is not built here.
