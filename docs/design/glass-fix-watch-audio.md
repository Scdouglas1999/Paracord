# Glass fix: stream audio when watching without joining, the clip bubble, camera cover

Three follow-ups to the stage work (G14, G15, G16, polish-1 item 7). Branch `design/glass`,
nothing committed. All three are proven live on the embedded build against a real relay:
**29 of 29 checks passed**. Sean watched Eric's share (which carries its own audio) without
joining. His view session subscribed to the stream audio and received it at 50 packets/s, with no
voice packets and no voice key. It played 50 decoded buffers/s on a running AudioContext, and a
clip cut then has a non-silent Opus track. The clip posted to General renders as the clip bubble.
After Sean joined, Brendan's camera fills its tile.

## 1. Watching without joining plays the stream's own audio

Plan §8: Watch is the stream's video **and its own audio**, never the voices.

**The bug** (found in G16):

- `viewSessions.attach` calls `subscribeScreenShareAudio` as soon as the watch is live.
- At that moment the view engine has not yet received the sharer's `screen-audio` `track_publish`.
  Live, the view sends `session_join` 3 ms after its transport opens, and the relay's
  `track_publish` arrives 4 ms after that. `connect` has already resolved by then.
- So no subscription was sent, and the `track_publish` handler only registered video.
- The relay forwards a track only on a matching subscription, so the view never received the
  stream audio. G16 measured 0 packets.

**Browser** (`client/src/lib/media/browserMediaEngine.ts`):

- `track_publish` now routes a `screen-audio` audio track to `onScreenAudioTrackPublished`, before
  the video handling, and stops there.
  - If someone is already listening for that person's stream audio, it adopts the published SSRC
    and sends `subscribe_stream` for the track.
  - An unchanged repeat is left alone, because the relay re-sends a publish after every key
    announce, and re-subscribing only makes it replay the stored key. A changed track (a new SSRC)
    re-subscribes.
  - Delivered keys are applied as before.
- **Latent bug, found by the new test and fixed by the same routing.** A `screen-audio` publish fell
  into the video branch. `videoSubscriptionFor(user, 'screen-audio')` falls back to a bare
  per-person video subscription, so such a subscription was switched onto the audio SSRC and its
  decoder was reset. The watch-audio test shows it before the fix: `expected 'screen-audio' to be
  'screen'`.
- `subscribeScreenShareAudio`'s SSRC derivation no longer overwrites a published SSRC that arrived
  while it was hashing. It re-reads the published track instead of the one captured at call time.
- **Defense in depth for "no voices to a viewer".** A view-role engine now drops any audio datagram
  that is not the watched stream's. It is no longer buffered as an orphan or materialized as a
  participant. Before this, it was materialized but never played: a view has no playback context
  and never holds a voice key. The relay filter (`ViewTarget::allows`) and G6b's key rules are
  unchanged.

**Desktop** (`client/src/lib/media/tauriMediaEngine.ts`):

- The same gap existed. `subscribeScreenShareAudio` registered the relay subscription only if
  `media_list_published_tracks` already had the track. The `media_track_publish` listener handled
  only video, so a watch that went live first never subscribed, and the native mixer had nothing to
  play.
- Now `registerScreenAudioTrack` is called both from the subscribe path and from the publish
  listener. It holds one registration per listener, leaves an unchanged repeat alone, and renews on
  a change. Release unregisters whatever was registered.
- **Rust native path: no change needed.** For a Watch session (`SessionRole::Watch.plays_audio()`),
  `audio_pipeline.rs` resolves an unknown SSRC against the stream registry, which `TrackPublish`
  fills. It then builds a stereo decoder and plays through the cpal mixer. The only missing piece
  was the relay subscription, which comes from the JS engine.
  - The desktop app was **not run** (WP-G23). This conclusion rests on the code and the new unit
    test, not on a live desktop watch.

## 2. Posted clips render as the clip bubble in normal channels

`client/src/components/message/MessageList.tsx`, the non-image branch, as G16 described:

- An attachment whose name `isClipAttachment` recognizes (`Clip 0m30s from Vincent's screen.webm`)
  renders as a `GlassMedia` 16:9 frame. It has the same Download and Delete `MediaTool`s as a
  picture (Delete only on your own) and the same `joinTop` corners.
- Inside it, `ClipAttachment` (G16) shows the first picture, the play button and "0:30 from
  Vincent's screen", and plays inline.
- `clips.css` already drops the clip's own radius inside `.glass-media__frame`.
- Two small additions for consistency with pictures (G13):
  1. The reactions chip bites the clip's corner. `biteMedia` counts a clip as the message's picture.
  2. With previews off (`lowBandwidthMode`), a clip stays a file row with "Preview off", as a
     picture does. The alternative was to fetch the whole clip anyway.
- Encrypted clips were already bubbles (`EncryptedAttachment`, then `MediaPreview`). They are
  untouched.

## 3. Camera tiles fill (cover) instead of letterboxing

- **Type.** `MediaEngine.subscribeVideo` now takes `SubscribeVideoOptions` (`mediaEngine.ts`):
  `{ preferredTrackId?, fit?: 'contain' | 'cover' }`. The default stays `contain`.
- **Canvas route.** Both engines pass `{ fit }` to `new CanvasRenderer`. Each surface has its own
  renderer, so the fit is per surface even when a covered tile and a contained thumbnail share one
  decoder (tested).
- **Native-surface route.** `NativeVideoTile` takes `fit` and sends it to `native_render_attach`
  (`fit: Option<String>`). It is read strictly by `SurfaceFit::parse`: `contain`, `cover`, or
  absent, and anything else is refused. It is fixed at attach, like the canvas renderer.
  - **Linux** (`native_render/linux.rs`). The shader's per-axis letterbox branch is replaced by one
    uniform, `uUvScale`: `sample = (uv - 0.5) * scale + 0.5`. It is inside the frame when both axes
    are in [0, 1].
  - `SurfaceFit::uv_scale` computes the scale in Rust, so it is unit-tested. One test shows that
    `contain` gives the old shader's sample at every row. Others check that `cover` crops evenly,
    and that across a grid of tile and frame shapes `cover` never leaves a bar and `contain` never
    crops.
  - **macOS** (`native_render/macos.rs`). `cover` sets the layer's `videoGravity` to
    `AVLayerVideoGravityResizeAspectFill`. `masksToBounds` was already on, so the overflow is
    cropped. **This is compile-unverified**, like the rest of that file: it cannot build on this
    Linux toolchain.
  - The trait's `new` gains `fit`. The mock in `video_pipeline.rs` tests and `SampledSurface` follow.
- **Stage.** `CameraTile` (`components/glass/stage/StagePeople.tsx`) requests
  `{ preferredTrackId: 'camera', fit: 'cover' }`. Theater's `TheaterPeople.tsx` reuses
  `CameraTile`, so its talker tile covers too, and that file needed no change. The shared screen
  (`StreamSurface`) stays `contain`.

## Tests (each new one run against the old code first)

| Test | Before the change | After |
|---|---|---|
| `browserMediaEngine.watchAudio.test.ts` (new, 5) | 4 fail: `expected [] to deeply equal [ 'stream:200:screen:screen-audio' ]` (×3); the bare video subscription hijacked, `expected 'screen-audio' to be 'screen'`. "Nothing after release" passes both ways, as it should | 5 pass |
| `tauriMediaEngine.watchAudio.test.ts` (new, 3): subscribe on publish; repeat, renew, release; nothing but the stream audio | 3 fail (`expected []`) | 3 pass |
| Fit: `tauriMediaEngine.fit.test.ts` (new, 2: canvas route, native route), `nativeVideoTile.test.ts` (+1), `browserMediaEngine.videoSharing.test.ts` (+1), `TheaterPeople.test.tsx` (+1), `Stage.test.tsx` (one assertion gains `fit: 'cover'`) | 6 fail | pass |
| `MessageList.bubbles.test.tsx` (+4): the bubble (16:9, play button, label, video, tools, no file row); your own (Delete, joined corner); the reactions chip on its corner; another video stays a file, and a clip with previews off is a "Preview off" row | 4 fail | 4 pass |
| Rust `native_render::tests` (+4): strict parse, contain equals the old shader, cover crops evenly, no bar or crop across shapes | new | pass |

## Commands

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx vitest run` (whole client) | **417 files, 4,226 tests pass**. WP-G20's work in progress was in the tree during the run |
| `npm run test:tokens` / `npm run test:motion-lint` | pass / pass |
| `npx eslint` on every file I touched | 0 errors. There is 1 warning, React Compiler's existing `useVirtualizer` note in `MessageList.tsx`, not from this change |
| `pc-cargo.sh clippy --manifest-path client/src-tauri/Cargo.toml --all-targets -- -D warnings` (vpx on) | clean |
| `pc-cargo.sh test --manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on) | 139 passed, 2 ignored (G16 had 135; +4 fit tests) |
| `cargo fmt -- --check` (client/src-tauri) | pass |

## Live proof (2026-09-30)

**Setup.**

- Built the client with `npm run build`, then `touch crates/paracord-server/src/embedded_ui.rs`
  and `pc-cargo.sh build --release --bin paracord-server`.
- The served `assets/index-BbuDFA8C.js` matched `client/dist`. The engine chunk
  `browserMediaEngine-Cze-c-p3.js` is byte-identical (sha256).
- `live-env.mjs --port 18930`, with its data in the scratchpad, then
  `glass-scene.mjs --hold --no-typing`: Vincent sharing, Brendan on camera, Nick muted, 3
  connected at about 200 video packets/s.

**The probe.** `watch-audio-live.mjs`, kept with its evidence in
`output/design-reference/glass-build/fix-watch-audio/` (gitignored). It is not in the repository.

- It installs an instrument before the app loads. For every WebTransport the page opens, the
  instrument records which view it is (the auth token's `view` claim), every control message sent
  and received, and datagrams by SSRC. It also counts every decoded buffer Web Audio starts, with its
  RMS and its context's state.
- The build under test is the minified embedded one, so nothing in the app is patched.

Final run, **29 of 29** (`probe-run2.log`, `results.json`):

- Eric joins Lounge and shares with a pulsing 660 Hz tone. Sean opens General, presses Watch and
  switches the stage to Eric. The watch goes live, and **Sean is not in the call** (the relay's
  roster).
- **Eric's watch view session:**
  - The relay described `screen-audio` (SSRC 1388449253, equal to the derived value). The view sent
    `subscribe_stream` for it 1 ms after that `track_publish`.
  - It subscribed to nothing but `stream:<eric>:screen` (screen, screen-audio).
  - **502 screen-audio datagrams in 10 s (50.2/s).**
  - The only audio SSRC seen was the stream's. **No voice datagram arrived**, checked against every
    cast member's derived voice SSRC.
  - **0 `key_deliver`.** The only `stream_key_deliver` messages were Eric's screen and screen-audio
    keys.
- **Playback: 502 decoded buffers started in 10 s (50.0/s)**, all above RMS 0.01 (peak 0.388), all
  on a `running` AudioContext.
- **Clip without joining.**
  - `Clip 0m31s from Eric's screen.webm`: 30.8 s, VP9 640×360, 722 frames, **plus Opus, 1,541
    packets, mean −12.2 dB**.
  - G16's same step had no audio track (its NOTE). Its joined clip also measured −12.2 dB.
- **The posted clip in General** renders as the bubble:
  - A play button labeled "Play clip, 0:31 from Eric's screen".
  - A 240×135 media frame, and no file row for it.
  - `clip-bubble.png` and `clip-bubble-row.png`. `joined-stage.png` shows two runs' clips stacked,
    with joined corners.
- **Camera cover.**
  - After Sean joins from the stage, Brendan's 1280×720 camera draws in a 736×223 tile (aspect 3.30).
    `contain` would leave 170 px bars left and right.
  - The fraction of pure-black pixels in all four edge bands is **0.000**: the picture fills the
    tile and is cropped top and bottom (`camera-tile.png`, `joined-stage.png`).
- No page errors in Sean's client.

**Before and after.** The "before" for item 1 is G16's measurement on the same scene: 0 packets,
and a clip with no audio. I did not re-run the old build live. The unit tests are the controlled
before and after.

**Stopped.**

- The holder by SIGINT (it left the call), then live-env and its server.
- The probe closed its browsers and stopped Eric's share.
- Port 18930 is free. The user's own `paracord-server` was not touched.

## Not done, and notes

1. **The desktop app was not run** (WP-G23). Three things are verified by unit tests, compiled with
   vpx on, and clippy-clean, but not observed live:
   - desktop stream audio for a watch without joining,
   - the Linux shader's cover,
   - the native tile's `fit` plumbing.
   The macOS `videoGravity` line is compile-unverified.
2. **Cover crops faces in very wide tiles.** Side by side with three or more people, a camera tile
   can be 3.3:1. There, centered cover keeps the middle 54% of a 16:9 camera's height, and the face
   is cut at the eyes and chin (`joined-stage.png`).
   - That is what `cover` means, and it is what the brief asked for.
   - If the owner wants faces kept, a camera-specific vertical anchor (upper third) would need to
     be added to both the canvas renderer and the shader. It is a design call.
3. **The live build included WP-G20's work in progress** (shell, AppShell, MobileBottomNav, phone
   CSS), as the full unit run did. None of it was touched here.
4. `clip-live.mjs` (G16's probe) still treats "stream audio when not joined" as a NOTE. It now
   finds an Opus track. Making that step a PASS is a one-line change in G16's script, which is
   outside this package's files.

## Files

Changed:

- `client/src/lib/media/browserMediaEngine.ts`: the screen-audio publish handler, the SSRC race,
  the view voice guard, and `fit`.
- `client/src/lib/media/tauriMediaEngine.ts`: `registerScreenAudioTrack`, the publish listener, and
  `fit` to the renderer and the native tile.
- `client/src/lib/media/mediaEngine.ts`: `SubscribeVideoOptions`.
- `client/src/lib/media/video/nativeVideoTile.ts`: `fit`, sent to `native_render_attach`.
- `client/src/components/message/MessageList.tsx`: the clip bubble and its bite.
- `client/src/components/glass/stage/StagePeople.tsx`: `fit: 'cover'` on `CameraTile`.
- `client/src-tauri/src/native_media/native_render/{mod.rs,linux.rs,macos.rs,sample.rs}`: `SurfaceFit`
  and the shader scale.
- `client/src-tauri/src/native_media/video_pipeline.rs`: the test mock's `new` signature only.

Tests:

- New: `client/src/lib/media/{browserMediaEngine.watchAudio,tauriMediaEngine.watchAudio,tauriMediaEngine.fit}.test.ts`.
- Changed: `browserMediaEngine.videoSharing.test.ts`, `video/nativeVideoTile.test.ts`,
  `components/message/MessageList.bubbles.test.tsx`, and
  `components/glass/stage/{Stage,TheaterPeople}.test.tsx`.
