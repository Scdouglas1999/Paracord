# Linux Screen-Capture Validation (Manual)

This page reproduces the end-to-end steps for validating native screen capture
on Linux for the Tauri desktop client. On Linux the capture path goes through
**xdg-desktop-portal** (the `ScreenCast` interface) and **PipeWire**, via the
`scap` capture engine. One step — the portal approval dialog — is inherently
**manual and cannot be automated**; it is called out explicitly below.

## Why this is a manual test

On Linux, `screen_capture::list_sources()` does not enumerate individual
displays/windows the way it does on macOS/Windows. It returns a single
portal entry (`id = "linux:portal"`, `requires_os_picker = true`,
title *"Choose a screen or window"*). The actual target is chosen inside the
compositor's **xdg-desktop-portal ScreenCast picker**, which the desktop
environment renders and the user must approve. That approval — selecting a
screen/window and granting the app permission — is a security boundary owned by
the OS/compositor and **stays manual**. Everything after the grant (PipeWire
negotiation, frame capture, VP9 encode, transport) is automatic.

## Prerequisites

- A Wayland or X11 session with:
  - **PipeWire** running (`systemctl --user status pipewire`).
  - **xdg-desktop-portal** plus a backend that implements the `ScreenCast`
    interface for your desktop:
    - GNOME: `xdg-desktop-portal-gnome`
    - KDE: `xdg-desktop-portal-kde`
    - wlroots (Sway/Hyprland/etc.): `xdg-desktop-portal-wlr`
  - Verify a backend is present:
    `busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop | grep -i ScreenCast`
- The desktop client built **with the `vpx` feature** (on by default — required
  for VP9 video; never disable it). See the "Building the Desktop Client"
  section of the top-level `README.md` for libvpx setup.
- A second Paracord client (any platform, including a browser tab) signed in to
  the same server to act as the viewer.

## Steps

1. **Launch the desktop client** built from this tree and sign in.
2. **Join a voice channel** (native media path) with another participant, or
   have the viewer client join the same channel.
3. **Start a screen share.** In the client this invokes the
   `voice_start_screen_share` command. On Linux this triggers the
   **xdg-desktop-portal ScreenCast dialog**.
   - **MANUAL / cannot be automated:** in the portal dialog, select a monitor or
     window and click *Share* to grant capture permission. If you deny or
     dismiss the dialog, capture is aborted (the client surfaces a
     `native_screen_share_event` with `kind: "error"`).
4. **Confirm capture started.** The client emits `native_screen_share_event`
   events on the `native_screen_share_event` channel; a successful start is
   followed by video frames flowing. Watch the client logs for the capture
   worker starting and no `error`/`ended` event immediately after start.
5. **Verify the viewer sees the stream.** On the second client, confirm the
   shared screen renders and updates in real time. This exercises the full
   pipeline: PipeWire capture → BGRA conversion → VP9 encode → E2EE → QUIC
   transport → decode/render on the viewer.
6. **Exercise controls:**
   - Move/redraw content on the shared screen and confirm frames update.
   - Stop the share (`voice_stop_screen_share`) and confirm the viewer's video
     ends and a `native_screen_share_event` with `kind: "ended"` is emitted.

## Audio note

Integrated screen **audio** capture is gated off on Linux
(`integrated_audio_capture()` is only enabled on macOS). Requesting audio
capture on Linux is a no-op for the integrated path — validate screen **video**
here; system-audio-over-screen-share on Linux is out of scope for this test.

## Troubleshooting

- **No portal dialog appears / start fails immediately:** no `ScreenCast`
  portal backend is installed or `xdg-desktop-portal` is not running for the
  session. Install the backend for your desktop (above) and restart the portal
  (`systemctl --user restart xdg-desktop-portal`).
- **Black frames / immediate `ended`:** PipeWire is not running or the portal
  grant was revoked. Confirm `pipewire` is active and re-run, re-approving the
  dialog.
- **Build has no video:** the client was built without the `vpx` feature — do
  not disable it; fix the libvpx build environment instead (see `README.md`).
