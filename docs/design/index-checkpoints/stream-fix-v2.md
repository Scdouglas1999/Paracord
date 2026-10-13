# Checkpoint: stream fix V2, a re-share reaches everyone already watching

Package V2 of the stream fix round (`stream-audit.md`, B1): a viewer watching
with **Watch** froze on the last frame, still marked live, every time the
sharer stopped and shared again (18 of 18 in the audit). The viewer now picks
up the new share by itself, says when the share stopped, and a key that does
not arrive is logged and asked for again.

Machine: the audit's dev box (RTX 4080, KWin 6.7.5, WebKitGTK 2.52.6). Lab:
`scripts/stream-audit` with the new `drive/reshare.mjs`. Date: 2026-10-13.

## Result

Same lab, same driver, 720p30, viewer window 1920x1080, a share every ~20 s,
the share's source switched every fourth cycle, the viewer leaving at cycle
11 and pressing Watch again mid-share at cycle 13. The box was loaded (three
labs at once, load average about 22).

| | Before (HEAD `0a2fb8b5`) | After |
|---|---|---|
| Re-shares watched | 17 | 20 |
| Picture back within 15 s | **1 of 17** (only the viewer who pressed Watch again) | **20 of 20** |
| Picture back at all | 4 of 17, 12 to 18 s after the share began | 20 of 20 |
| Share start to first frame on the viewer's screen | median 16.7 s (the 4 that came back) | **median 1.05 s**, 0.57 to 2.6 s |
| Source switched (2560x1440, 5120x1440, 1920x1080 sources) | 0 of 4 | 4 of 4, 0.70 to 2.19 s |
| Viewer joining mid-share (Watch pressed 1.5 s after the share began) | 9.1 s | 9.3 s (11.2 s to first frame, view-session connect included) |
| "vincent stopped sharing." shown after a stop | 0 of 16 | 19 of 19 |
| Stopped share no longer claims a picture (`data-picture`) | 0 of 16 | 19 of 19 |

An earlier baseline run that also changed Share quality between shares
(1080p60, 720p30, 4K60, 1440p60) recovered 0 of 4 within 20 s.

"Back within 15 s" is the driver's strict check: frames reach the decoder,
the box is live with a picture and no notice. After the first frame, the
picture often stalled again for a few seconds at this load (median 5.6 s until
deltas flowed steadily): deltas lost after the opening keyframe wait for the
next keyframe. That is the audit's B3 (V1's package), not key delivery.

## What was wrong

Two causes, in sequence. Either one alone froze the picture.

1. **The new share's keyframes were thrown away as stale.** The viewer keeps,
   per track, the frame id of the newest keyframe it accepted from a stream
   (`remote_track_stream_high_water`, the L1 backpressure cull). A new share
   numbers its frames from 0 again, so every keyframe of the new share was
   "older" than the last share's mark and culled, until the new share's frame
   ids climbed past it. After a share of a few minutes, as in the audit, that
   is minutes: the picture never came back in practice. The mark was never
   cleared when the track was unpublished.
2. **The new share's key arrived after its opening frames.** The sharer makes a
   fresh key per share and seals from the first frame, but the key reaches
   viewers through the renderer (unwrap, IPC) 0.3 to 0.7 s later. Every frame
   before it, including the only keyframe, could not be opened, and nothing
   asked for a keyframe once the key landed: the picture waited for the next
   periodic keyframe (8 to 10 s at the real frame rate). The new key also
   reused the previous share's epoch, so those frames were tried against the
   old share's key ("wrong key"), and the one warning the decrypt diagnostic
   ever printed per SSRC never said which track, epoch or why.

On top of that the stream box kept showing the last frame as live after the
sharer stopped: the "stopped sharing" notice was only for a watch that had
ended, and a picture, once seen, was never taken back.

## What changed

Native (Rust):
- `video_pipeline::unbind_remote_video_track` (run on `TrackUnpublish`) drops
  the track's keyframe high-water mark, and re-arms the surface's first-frame
  event so the next share reports its first frame to the page.
- **Keyframe on a new key.** When a delivered stream key changes what an SSRC
  opens under, and the track is a subscribed video track, the receiver asks the
  publisher for a keyframe, and once more 350 ms later (the relay folds
  requests within 250 ms). `events::keyframe_request_for_new_key`,
  `request_keyframes_for_new_key`; `FrameDecryptor::set_peer_key` now returns
  whether the key changed. This also covers key rotations during a share (a
  viewer leaving, a member joining), which had the same race.
- **A restarted track never reuses its last epoch.** The session remembers each
  local track's last key epoch (`retired_track_key_epochs`); the next key for
  that track starts at the epoch after it. Frames of a new share that arrive
  before its key read as "no key", never as the old share's key failing, and a
  late delivery of an old key cannot overwrite the new one.
- **Unpublish drops the track's keys** on the receiver (all layers, all
  delivered epochs). Key material of an ended share is not kept.
- **Loud key failures.** `note_decrypt_result` now takes the packet's epoch
  and error, and the alert names the SSRC, the track (when it is a known video
  SSRC), the epoch and the reason (`no-key`, `wrong-key`, `replay`,
  `malformed`). It fires at 50 consecutive failures and **repeats every 2 s**
  while the run lasts (it used to fire once per SSRC, forever).
- Logs at every key step: a new local key (track, epoch), each announce
  (recipients), each install (SSRCs, changed or not), keys held for a track
  not yet published, keys dropped on unpublish, the keyframe request and why.

Renderer (TypeScript):
- `tauriMediaEngine` listens for `media_decrypt_failing`. For a key problem on
  a track this side receives (found by stream/track, or by SSRC among the
  published tracks for stream audio), it logs and **asks for the key again**
  by subscribing again: the relay answers a subscription with the newest key
  it holds for this receiver, or asks the publisher to wrap one, and requests a
  keyframe. With the 2 s repeat this retries until the key lands.
- `StreamSurface` takes `sharing`: when the streamer stops, the picture is
  dropped, and the next share is a picture only once its first frame arrives.
  `watchNotice` says "X stopped sharing." over a watch that stays connected
  (live phase, no picture); a frame that beats the voice state is still shown.
  The "Reconnecting video…" state for a live picture that stops moving is V1's
  stall event and veil, reused as is.

Key strength is unchanged: one fresh random key per share, wrapped per
recipient, no plaintext path. Asking again goes through the existing
`SubscribeStream`, whose key answer the relay already limits to authorized
recipients (a view session gets only the watched stream's keys).

Lab tooling: `drive/reshare.mjs` (the B1 check: re-shares, source switches by
restarting the synthetic screen at another size, a viewer joining mid-share,
`reshare.json`); `env.sh` takes `SA_SERVER_RUST_LOG`.

## Tests

- `events.rs`: a re-share end to end at the key level (stop, forget, new epoch,
  "no key" before the key, keyframe request on its arrival, frames open);
  stale key reads as wrong key; no keyframe for audio or unwatched tracks;
  alert threshold and repeat; bounded runs; fresh epoch per restart.
- `video_pipeline.rs`: a restarted share's opening keyframe is not culled.
- `crypto.rs`: `set_peer_key` reports a change.
- `tauriMediaEngine.reshare.test.ts`: re-subscribe on republish; asking for the
  key on a decrypt failure (video by name, stream audio by SSRC); nothing for
  replays or unknown SSRCs.
- `StreamSurface.test.tsx`, `stageModel.test.ts`, `engineShared.test.ts`.

Gates on HEAD + V2 only (the tree is shared with three other packages):
`cargo fmt --check`, `cargo clippy --workspace -D warnings`, `cargo clippy -p
paracord-desktop --all-targets -D warnings`, Windows cross clippy (`-p
paracord-desktop`, only the pre-existing `windows_h264.rs` and
`screen_capture.rs` warnings), `paracord-desktop` lib tests 232/232,
`paracord-codec` crypto 31/31, client typecheck, lint of touched files, and
unit tests (`CallSheet` "a short drag springs back" is timing-flaky under
load and passes alone, on HEAD too).

## Not covered, and what is left

- **Camera off and on** runs the same code (`teardown_camera_publish` clears
  the key and unpublishes; the next key gets a new epoch; receivers drop the
  old keys and ask for a keyframe on the new one), but the lab has no camera
  device, so it was not measured.
- **Switching what is shared** is a stop and a new share in this app (there is
  no in-place source switch); the lab's portal names one source, so a switch
  was simulated by restarting the synthetic screen at another size.
- After the first frame, steady video at load still depends on B3 (lost
  deltas wait for a keyframe) and B4 (decoder reset on resolution change), V1.
- The relay's "latest" stored key is the highest epoch number; across the
  255-to-1 wrap it would hand out the older key (pre-existing; reaching it
  takes 255 key changes on one track in one call).
- A sender crashed once in the lab inside `av_hwdevice_ctx_create` during a
  bitrate change (`SimulcastEncoder::set_top_layer_bitrate` → encoder rebuild),
  with the lab's LD_PRELOAD probe on the stack; not reproduced, noted for V3.
