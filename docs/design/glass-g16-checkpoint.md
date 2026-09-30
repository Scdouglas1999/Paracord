# WP-G16 checkpoint: clips

Contract: `docs/glass-spec.md` §6.4 and §9. Plan: `docs/design/glass-plan.md` (the WP-G16 row, §5, §6).
Stub contracts: `glass-g14-checkpoint.md`. Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

Clip works end to end on a real relay. Sean watched Vincent's stream from the pill without
joining, pressed Clip, and posted to General. The posted file downloads as a 31.4 s VP9 WebM
that ffprobe decodes (741 frames) and Chromium plays: Vincent's scene shows at the start and
after a seek to the end. With a sharer whose stream carries its own audio, the clip also holds a
non-silent Opus track (1,563 packets, mean −12.2 dB) that Chromium decodes. The live probe passed
56 of 56 checks on the final build, with one noted gap: watching **without joining**, the browser
never receives the stream's own audio. That is an engine bug outside this package, and its fix is
given below.

## What it does

- **Clip (the button, or C)** saves the last 30 seconds of the stream on the stage without
  touching it. The window starts at the newest keyframe at or before now − 30 s, so a clip
  covers at least the last 30 s whenever that much is held. It is 30 s plus the lead-in to the
  keyframe (live: 30.2 to 31.4 s). With less held, for example after watching for 10 s, the clip
  is what there is, and the toast says so ("Saved the last 10 seconds").
- **The toast** is centered at the top of the stream, 488 px wide, 72 px down. It has a still of
  the stream, "Saved the last 30 seconds", "From Vincent's screen, 9:14 PM", **Post to
  General** (text, named after the conversation beside the stage), and Dismiss. Posting shows
  "Posting… 40%", then "Posted to General" and "Your clip is in the conversation", and the toast
  goes after 6 s.
- **Posting** uses the conversation's own attachment path:
  - A normal channel: `fileApi.upload` and then `sendMessage(channelId, '', undefined, [id])`.
  - An end-to-end encrypted conversation: the encrypted producer (`sendMessage(…, { files,
    maxCiphertextBytes })`). The file is encrypted on the device, exactly as `MessageInput` does
    it, and never takes the plaintext upload path.
  - Where the person may not attach files, the reason from `runtimeAttachDecision` is shown.
- **Upload limit.** A clip larger than the limit is refused with its size and the limit: "This
  clip is 62.1 MB and General takes files up to 50.0 MB, so it was not posted. Save it to this
  device instead." A server 413 is reported the same way, with the server's own words. The clip
  is never shortened. "Save to device" is offered instead, and it is also offered when no
  conversation is beside the stage.
- **The posted clip** renders as a media bubble: 16:9, 240 px, its first picture, a play button,
  and "0:30 from Vincent's screen". It plays inline with controls. The file name carries the
  meaning: `Clip 0m30s from Vincent's screen.webm`. That name reads well when downloaded, needs
  nothing new in the message or on the server, and travels inside the encrypted body in an
  E2EE conversation.

### Decisions

1. **Your own share is not clippable.** The control says "You can clip other people's streams,
   not your own." A clip taps a decoder's intake, and your own share never passes through one.
   Clipping it would mean tapping the encoder's output, a different path. That can come later
   if the owner wants it.
2. **The desktop keeps its ring in Rust for both video routes** (native-surface and WebCodecs
   passthrough), and for the stream audio. On the desktop the stream is decrypted, reordered
   and, on the native route, decoded in the native process, and stream audio always plays
   natively. So one Rust tap after the reorder stage covers every desktop route, and no JS tap
   exists in `tauriMediaEngine.ts`.
   - Browser: the ring is in JS (`clipIntake`). Desktop: the ring is in Rust (`clip_buffer.rs`).
   - The runtime decides which, by the same test `createMediaEngine` uses. It is one path per
     runtime, and neither stands in for the other.
3. **Clips are armed by the watch, not by the UI.** The ring is armed when
   `voiceStore.watchView` is live and freed the moment the watch stops, fails, or moves to
   another stream. An unposted clip is freed with it. A watch that moves into or out of the
   call keeps its ring: same sharer, new engine, continuing from that engine's next keyframe.
4. **Timeline.** The two clocks are handled separately:
   - Video plays at the sender's capture timestamps.
   - Audio plays at sequence × packet length.
   - Each is placed on this client's arrival clock by its fastest packet, so audio and video line
     up as they did live, and arrival jitter never reaches the file.
   - A lost audio packet becomes an Opus lost-packet marker (TOC only), which the decoder
     conceals, so the audio track stays continuous.
   - A pause in stream audio (sequence numbers do not advance while nothing is sent) starts a
     new segment, so the audio after it is not pulled early.
5. **Containers.** WebM carries VP9 or AV1, each with Opus. MP4 carries H.264 with Opus
   ("Opus in ISOBMFF", which Chromium plays). Nothing is transcoded.
   - A clip that spans an AV1 sequence-header or H.264 SPS change (the sharer changed resolution)
     starts at the keyframe where the change took effect, because those containers record one
     decoder configuration. The clip then states its real length.
   - VP9 needs no trimming: it carries its size in every keyframe.
6. **Muxer: written here, not added as a dependency** (`package.json` untouched).
   - The small permissive options (`webm-muxer`, `mp4-muxer`) are deprecated in favor of
     `mediabunny`, which is MPL-2.0 and far larger than what a finished clip needs.
   - The two writers here are about 600 lines. The frames are already encoded, the whole clip is
     known up front, and each output is checked by an independent reader in the tests, by
     ffprobe/ffmpeg/mkvinfo, and by playback in two Chromium builds.

### Memory budget

The ring holds at most **64 MiB** (`CLIP_BUFFER_MAX_BYTES`, the same in JS and Rust). That is 30 s
plus one GOP at about 16 Mbit/s. The stage's largest standard preset, 1440p60, is 18 Mbit/s.

- Past the budget, the oldest GOP is dropped first, and the clip says its real length.
- A single GOP larger than the whole budget is dropped, and the ring waits for the next
  keyframe.
- Audio is kept from 1 s before the oldest video.
- Nothing is kept while nothing is watched, and everything is freed on stop.

Live, a 30 s clip of the scene's 640×360 share was about 1.3 MB.

## Contract for others

- **G15 (C key):** call `triggerClip(): Promise<boolean>` from `lib/media/clips/useClip.ts` on C,
  when the stage is open and the key is not someone else's (typing, a menu, a dialog: the rules
  in `escapeBelongsElsewhere`). It does exactly what pressing Clip does and says what went
  wrong in a toast. It never rejects, and resolves `false` when nothing is on the stage.
  `aria-keyshortcuts="C"` is already on the button.
- **The Clip button needed no stage edit.** `StageControls` already reads `useClip(...)`, and
  `available` turns true once the watch is live (live: 0.5 s after Watch).
- **G20 (the phone's "30s" overlay):** use `useClip(target)` or `triggerClip()`. `ClipToast`
  registers the target on the phone stage too.
- **The timeline bubble needs one change in `MessageList.tsx`,** which is not in my scope.
  Without it, a clip in an unencrypted channel shows as a file row (Download / Delete), as the
  live shots show. In the non-image branch, just before `return (<GlassFile …`:

  ```tsx
  // at the top: import { ClipAttachment, isClipAttachment } from '../../lib/media/clips/ClipAttachment';
  if (src && isClipAttachment(att.filename)) {
    return (
      <GlassMedia key={att.id} joinTop={joinTop} width={16} height={9} badge={federatedNote}
        tools={<>
          <MediaTool label={`Download ${att.filename}`} busy={busyLabel} disabled={busy} onClick={download}><DownloadMark /></MediaTool>
          {isOwnMessage && !isFederated && (
            <MediaTool label={`Delete ${att.filename}`} disabled={busy} onClick={remove}><TrashMark /></MediaTool>
          )}
        </>}>
        <ClipAttachment url={src} filename={att.filename} />
      </GlassMedia>
    );
  }
  ```

  `clips.css` already drops the clip's own radius inside `.glass-media__frame`, so the frame's
  joined corners apply. An encrypted clip already renders as the bubble through
  `EncryptedAttachment`, then `FilePreview`, then `MediaPreview`, after its "open" action.

## Stream audio when not joined (engine gap, not fixed here)

Watching without joining, the browser's view session never receives the stream's own audio. So
the stream plays silent, and a clip cut then has no audio. Measured from Sean's client over the
Vite dev server:

| Case | `screen-audio` packets reaching the watch engine in 8 s |
|---|---|
| View session (not joined) | **0**. The engine did not know the `screen-audio` track when the view went live (`audioTrackKnownAtStart: false`). |
| View session, subscription registered by hand after its `track_publish` arrived | **201 in 4 s (50/s)**. The ring holds them and clips carry them. |
| Joined (the watch rides the call) | **400 in 8 s**. Proven live in the posted file: Opus, −12.2 dB, decoded by Chromium. |

**Cause:** `viewSessions.attach` calls `subscribeScreenShareAudio` as soon as the view is live.
With no published `screen-audio` track known yet, `browserMediaEngine.subscribeScreenShareAudio`
registers no relay subscription. The `track_publish` handler (`browserMediaEngine.ts`, `case
'track_publish'`) registers only video subscriptions, so the audio subscription is never sent.
The relay forwards a published track to a view only on a matching subscription, so nothing
arrives. A joined client works because its call engine already knew the track.

**Fix (G6/G6b owner, `browserMediaEngine.ts` track_publish case):** after `this.publishedTracks.set(...)`:

```ts
if (track.trackId === 'screen-audio' && track.kind === 'audio') {
  const pending = this.screenAudioSubscriptions.get(publisherUserId);
  if (pending) {
    pending.ssrc = track.layers[0]?.ssrc ?? pending.ssrc;
    void this.registerTrackSubscription({ streamId: track.streamId, trackId: track.trackId, requestedLayer: 0 }).catch(() => {});
  }
}
```

When that lands, `clip-live.mjs`'s `eric-watching` note should show an Opus track. The desktop
engine was not checked for the same race, because the desktop app was not run. See below.

## Files

New (all under my scope unless marked):

| File | What it is |
|---|---|
| `client/src/lib/media/clips/clipRing.ts` | The ring: GOPs, the window, the budget, audio in sequence order |
| `clips/clipTimeline.ts` | Window selection, the two-clock timeline, lost and paused audio |
| `clips/bitstream.ts` | VP9/AV1/H.264 sizes; `av1C` and `avcC`; AV1 OBUs; H.264 Annex B to length-prefixed |
| `clips/opus.ts` | TOC durations, stereo, the lost-packet marker, `OpusHead` |
| `clips/webmMuxer.ts`, `clips/mp4Muxer.ts`, `clips/clipMux.ts` | The containers and the codec dispatch (with the configuration span) |
| `clips/clipIntake.ts` | The browser intake registry the engine taps |
| `clips/nativeClipSource.ts`, `clips/clipSource.ts` | The desktop commands and their reader; the runtime's one source |
| `clips/clipStore.ts` | Arming by the watch, saving, the thumbnail, posting, dismiss |
| `clips/useClip.ts` | Filled contract: `useClip`, `triggerClip`, `CLIP_SECONDS` |
| `clips/clipFilename.ts`, `clips/ClipAttachment.tsx`, `clips/clips.css` | The clip name, the timeline wrapper, and the styles (tokens only) |
| `clips/__fixtures__/` | Real VP9/AV1/H.264/Opus frames made with ffmpeg (commands in `loadFixtures.ts`), and independent EBML/MP4 readers |
| `client/src-tauri/src/native_media/clip_buffer.rs` | The Rust ring, the track map, and the `media_clip_arm` / `media_clip_disarm` / `media_clip_cut` commands |
| `client/scripts/glass-scene/clip-live.mjs` | The live probe. **Outside the listed scope:** a new file beside G14's `stage-live.mjs`, touching nothing else |

Changed:

- `client/src/components/glass/stage/ClipToast.tsx`: the toast, filled.
- `client/src/components/file/MediaPreview.tsx`: the clip bubble (play button and label) for a
  clip's file name. The lightbox, which uses `autoPlay` and `videoStyle`, keeps the ordinary
  player.
- `client/src/lib/media/browserMediaEngine.ts`: one import and two tap lines. The video tap is
  in `routeReassembledVideoFrame`, after the decode gate. The audio tap is in
  `handleScreenAudioDatagram`, after decryption.
- `client/src-tauri/src/native_media/`:
  - `mod.rs`: `pub mod clip_buffer`.
  - `video_pipeline.rs`: one tap at the top of `deliver_decoded_frame`, which is after the
    reorder stage, before the hidden check, on every route.
  - `audio_pipeline.rs`: one tap after decryption, before the deafen check.
  - `events.rs`: `note_track` on TrackPublish and TrackLayers, `forget_track` on TrackUnpublish.
- `client/src-tauri/src/lib.rs`: three registration lines.
- `client/src/components/glass/stage/Stage.test.tsx` (G14's): one assertion. With no watch, Clip
  now says "Waiting for Vincent's screen." instead of the stub's "not available". G17 will
  change the flame line of the same test.

`tauriMediaEngine.ts` and `package.json` are unchanged.

## Commands (run in `~/Documents/Paracord-glass/client` unless noted)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 414 files, 4,209 tests (the whole client, other packages' work in progress included) |
| `npx vitest run src/lib/media/clips src/components/glass/stage src/components/file` | pass, including 66 new clip tests: ring 11, timeline 9, mux 9, sources 7, store 16, bubble 7, toast 7 |
| `npm run test:tokens` / `npm run test:motion-lint` | pass / pass |
| `npm run lint` | 0 errors, 254 warnings (the tree's). `npx eslint` on every file of mine: 0 problems |
| `CLIP_MUX_OUT=<dir> npx vitest run src/lib/media/clips/clipMux.test.ts`, then `ffprobe` and `ffmpeg -f null` | VP9 and AV1 WebM, and H.264 MP4, each with Opus: they decode with no warnings, and `mkvinfo` is clean. They play in Playwright's Chromium and in `/usr/bin/chromium` with decoded audio, and seek via a blob URL |
| `pc-cargo.sh clippy --manifest-path client/src-tauri/Cargo.toml --all-targets -- -D warnings` (vpx on) | pass |
| `pc-cargo.sh test --manifest-path client/src-tauri/Cargo.toml --all-targets` | 135 passed, 2 ignored. That includes 8 new `clip_buffer` tests: window, budget, oversized GOP, codec and clock restarts, the sequence wrap, the cut layout, and arming/disarming |
| `cargo fmt -- --check` (client/src-tauri) | pass |

## Live proof (2026-09-30, the embedded build, a real relay)

Setup:

- `npm run build`, then `touch crates/paracord-server/src/embedded_ui.rs`, then
  `pc-cargo.sh build --release --bin paracord-server`.
- The served `assets/index-BHqS4s_a.js` matched `client/dist`.
- `live-env.mjs --port 18760` with its data in the scratchpad, then `glass-scene.mjs --hold`.
- `ERIC_SETTLE_MS=5000 node scripts/glass-scene/clip-live.mjs --base http://127.0.0.1:18760 --scene …/scene.json`.
- Result: **56 of 56 passed, 1 note**. Log, shots, downloaded clips and `results.json` are in
  `output/design-reference/glass-build/g16/live/`.

What the run showed:

- **Before watching.** There is no Clip control. After Watch, Clip becomes available in 0.5 s,
  and watching does not join the call.
- **Vincent (not joined, video-only share).**
  - After 36 s, Clip showed the toast 39 ms later: "Saved the last 30 seconds", "From Vincent's
    screen, 2:28 PM", a still, and Post to General. "Posted to General" followed.
  - General has Sean's message with `Clip 0m31s from Vincent's screen.webm` (1.28 MB,
    `video/webm`). The download is byte-identical.
  - ffprobe: WebM, 31.37 s, VP9 640×360, 741 frames, no audio track (correct: the share has no
    audio).
  - Chromium plays it (31.37 s). Vincent's teal and amber scene is on screen at 2.5 s and after a
    seek to 30.7 s.
- **Freed on switch.** A second, unposted clip was cut at once. Switching the stage to Eric freed
  it, and its toast went.
- **Eric (shares with a pulsing tone).**
  - Not joined: the clip is 30.2 s of VP9 that plays, with **no audio** (NOTE, the gap above).
  - Sean then pressed Join on the stage and kept watching Eric. That clip is 31.3 s, VP9 plus
    **Opus: 1,563 packets, 1 channel, mean −12.2 dB**. Chromium plays it and decoded 202,979
    audio bytes.
- **Stop watching** closes the stage and its clip. There were no page errors in Sean's client.

Shots: `vincent-toast.png` (compare `screens/04`), `vincent-posted.png`,
`eric-joined-posted.png`, and `visual-toast-bubble.png` / `visual-bubble-playing.png`. The last two
show the bubble with a real posted clip, rendered through the dev server.

Everything I started was stopped: the scene holder by SIGINT (it left the call), live-env and
its server, the Vite dev servers, and every Playwright browser. Ports 18760, 18761 and 1623 are
free.

## Against the reference (`screens/04`, `GlassV14Side.dc.html`)

| | Reference | Mine (live, 1440×900) |
|---|---|---|
| Toast box | 258,100 488×74, radius 22, solid, deep shadow | 258,100 488×74, radius 22, `--solid`, `--sh-pane` |
| Thumbnail | 96×54, radius 12, 1 px light ring | same (`--r-ctl`, `--glass-fill` ring) |
| Title / subtitle | 15/600; 13 ink-2, "9:14…" truncated | the same; the time truncates the same way |
| Post to General | 36 high, text, 15/600 | 36 high, text, 15/600, padding 10 (not 12) |
| Dismiss | 32 circle, ink-2 X | 32 circle, ink-2 X, 4 px closer to Post |
| Posted bubble | 240×135, radius 20 joined, 44 px play circle (glass blur), label with text shadow | 240×135, the frame's radius, 44 px play circle (**solid `--pill`**, no blur), label on a **solid `--pill` chip** |

Differences, each deliberate:

1. **The toast's inner spacing.** The prototype's title overflows its column by a few pixels
   ("Saved the last 30 seconds" needs 181 px; the column is 175 px). Instead of overflowing, the
   text button uses the Glass text-button padding (10) and Dismiss sits 8 px closer. The title
   then fits exactly, and longer titles still ellipsize.
2. **The bubble's play circle and label are solid.** There is no blur in the timeline (the
   WebKitGTK cost, plan §6), and the label is legible over any picture, which §9 requires
   (4.5:1).
3. **The thumbnail on the desktop native-surface route** is G8's 32×18 native sample, upscaled,
   so it is soft. The frames route (browser, WebCodecs passthrough) samples the real picture.

## Not done, and follow-ups

1. **The desktop app was not run** (WP-G23). The Rust ring, the taps and the commands are
   compiled with vpx on, clippy-clean and unit-tested, and the JS reader is tested against the
   Rust layout. No Tauri or WebKitGTK clip was cut live. WebKitGTK playback of the posted WebM
   and MP4 is also unverified.
2. **Stream audio when watching without joining** (above; a G6/G6b fix in `browserMediaEngine.ts`).
3. **`MessageList.tsx` line** (above), so that unencrypted clips render as the bubble.
4. **A/V sync was verified by construction and unit tests, not measured live.** The scene's tone
   is not tied to its picture.
5. **B-frames.** The MP4 writer assumes decode order equals presentation order (no `ctts`),
   which holds for the real-time encoders Paracord uses. A hardware H.264 encoder configured with
   B-frames would need `ctts`, and the wire carries no composition offsets today.
6. **The Rust track map** (`clip_buffer` `tracks`) forgets a track only on TrackUnpublish. A
   session torn down without unpublishes leaves a small entry per stream it saw, about 100
   bytes each.
