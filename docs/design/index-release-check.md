# Index release check, 2026-10-05

The last pass over `feat/index-ui` before the owner sees it (IX-20 in
[`index-plan.md`](index-plan.md)). It started at `f045e310` (IX-19's last
commit). It ran every CI gate `.github/workflows/ci.yml` defines that can run on
this machine, walked the desktop app (Tauri on WebKitGTK) through the main
states against a live instance, measured its CPU, and fixed what failed. The
Glass equivalent is [`glass-release-check.md`](glass-release-check.md).

Nobody else worked in the worktree during this pass.

## Commits from this pass

| Commit | What |
|---|---|
| `e97fbcfd` | `fix(index)`: the room card's **Back to chat** read "Back to ch..." at 1280. The wide control was 100px with 12px side padding, 76px for a 78px label. Its padding in the card is now 8px (the label is centered, so the padding is only a minimum). It reads in full at 1280 and in the 280px sidebar; `index-card.spec.ts` now asserts neither label is clipped at either width and crops the card with Back to chat at 1280. |
| `252d3d67` | `feat(index)`: Together's "Watching ..." line is drawn again. index-spec §7.2 and §8.5 put the now-playing line under the card head. The server sidebar keeps the server's listing current (`useGuildTogether`), and the card draws `Watching <title>` / `Listening to <title>` for a room you are not in; a call you hear keeps its listen-together line from the call's session. One unit test. |
| `da91615f` | `test(ws)`: `gateway_integration.rs:1965` compared a JSON value to an owned `String` (`clippy::cmp_owned` on local 1.98). It compares `as_str()` now; clippy passes on 1.91 and 1.98. |
| `f6233d7f` | `chore(scene)`: the Glass control paths in `client/scripts/index-scene/ui.mjs` are gone (pill join, stage open/close, `uiKind`), with what only they used: `shots.mjs`'s Glass branches, `scene-lib/call.mjs`'s `startCall` and `callAlreadyHeld`, `scene-lib/ui.mjs`'s `CONTROLS` and stage helpers, and `scene-lib/scene.mjs` (the Glass scene's data; its image table moved into `scene-lib/assets.mjs`). |
| `27b0f80f` | `fix(desktop)`: **CI would have failed.** `cargo clippy --workspace -- -D warnings` on 1.91 (CI's toolchain) rejects `!(in_call \|\| !in_view)` in `native_media/commands.rs` (`nonminimal_bool`). Written as `!in_call && in_view`; same logic. |
| `c9b9b9b4` | `test(client)`: `menus.test.tsx` "closes on Escape and gives focus back" failed once while the Rust build loaded the host (load 24). Focus returns after the menu's leave, so the assertion waits for it. 5/5 alone before and after. |
| `7f140b72` | `fix(client)`: the server header said "2 members" after five people joined. The count came from READY and nothing moved it. `GUILD_MEMBER_ADD` / `GUILD_MEMBER_REMOVE` now adjust it (never for your own join, never twice for a member the loaded roster already lists). One unit test. |
| `d46b5437` | `fix(desktop)`: **nobody ever showed as talking in a desktop call.** The native speaking detector filed speakers by SSRC; the renderer files them by user id (card rows, call tiles, `--voice-level`), as the browser engine reports them. It also sent a 0-1 level where the renderer reads -dBov, which would have pegged the waveform. The detector now maps each voice SSRC to its owner from the session roster (`derive_track_ssrc(user, "audio")`), sends the raw level, and repeats levels every tick while anyone talks. One unit test. |
| `0df8a440` | `fix(scene)`: after about 25 minutes the holder's REST tokens expired; its relay probes read the 401 as "nobody is in the room" and "healed" the whole cast, which broke the scene. The scene's API helper now signs a scene person in again on 401, a failed room read throws instead of reading as empty, and `setMic` waits for the microphone to stay as asked (a row join could apply the join-muted preference after the scene had unmuted). |
| `0b3a6aeb` | `fix(desktop)`: **a second join in the same page heard nobody.** Joining makes everyone in the call wrap a voice key to the new call key. On a warm connection those keys reached the webview while `start_voice_session` was still returning, before `TauriMediaEngine.connect` had registered its key listener; the events were dropped, nobody re-sends a key until the room changes, and every packet failed to decrypt (`no usable key`). The engine now registers its key, roster, track and transport listeners before it starts the session (the commands they invoke already wait on the native transition lock). A unit test pins the order (it fails without the fix). Live: four joins in one page, each heard Jeremy; before, the second never did. |
| `53b41edd` | `perf(client)`: with the speaking fix the real waveform finally ran, and cost about a quarter of a core: `voiceLevel.ts` ran its envelope every animation frame and the bars eased between levels, so the window repainted continuously. The level now ticks on the shared 100ms grid and the bars step with it. |
| `1c1054eb` | `perf(client)`: the waveform's CSS loop (someone talking in a room you are not in) stepped every 100ms because the four bars' phases were 100ms apart. Each bar steps every 200ms; with whole-step phases they change together, five paints a second instead of ten. |
| the commit that holds this file | `docs`: this check, the IX-20 checkpoint and `index-summary.md` |

## Gate results

"First run" is the tree at `e97fbcfd`..`f6233d7f` (before the desktop and
performance fixes); "Final" is `1c1054eb`, the code the binary below was built
from. Rust ran with CI's toolchain (`cargo +1.91`) unless noted.

| Gate (CI job) | First run | Final (`1c1054eb`) |
|---|---|---|
| `check_audit_exceptions.py` | pass | not rerun (no change) |
| `cargo audit` | | pass (14 allowed warnings) |
| `npm audit --audit-level=moderate` | | pass (0 vulnerabilities) |
| `security_gate_check.py` | pass (no tracker, skip by design) | |
| `ci_migration_sanity.py` (116 SQLite, 117 PostgreSQL), `check_release_version.py` (3.3.0), migration line endings, Python syntax, `bash -n` installers | pass | not rerun |
| SQLite upgrade from `v0.9.0`, SQLite query-plan smoke | | pass |
| actionlint (docker, pinned digest) | | pass |
| `npm run contracts:check` | pass | pass |
| `export-contracts --check contracts/api-contracts.json` | pass | not rerun (no contract change) |
| `npm run typecheck` | pass | pass |
| `npm run lint` | 0 errors, 213 warnings | 0 errors, 213 warnings |
| `npm run test:a11y:static`, `npm run test:contrast` | pass | pass |
| `npm test` (typecheck, unit, tokens, motion lint) | **1 failed** (menus focus under load, `c9b9b9b4`), 4,518 passed | 441 files, 4,521 tests pass |
| `npm run build` | pass | pass |
| `npm run test:e2e` (CI=1, mocked) | 120 passed | 120 passed |
| `npm run test:e2e:index` (CI=1) | 261 passed | 261 passed |
| `npm run test:motion` (CI=1) | 20 passed | 20 passed |
| `PARACORD_E2E_REAL=1 npx playwright test` (CI=1, `PARACORD_E2E_MEDIA_PORT=18159`, release server with this `dist` embedded) | 17 passed | 17 passed (server rebuilt from `1c1054eb`, embedded `index-nQM_eFtI.js` checked against `client/dist`) |
| `node client/scripts/live-drive.mjs` (instance on :18480) | | 25/25 |
| `cargo fmt --all -- --check` | pass | pass |
| `cargo clippy --workspace -- -D warnings` | **failed** (`nonminimal_bool`, `27b0f80f`) | pass (also on local 1.98 with `--all-targets`) |
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` (vpx on) | pass after `27b0f80f` | pass |
| `cargo clippy -p paracord-ws --all-targets -- -D warnings` | pass after `da91615f` (1.91 and 1.98) | pass |
| `cargo check --workspace --no-default-features` | pass | |
| `cargo check --manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on) | pass | covered by the desktop clippy |
| `cargo test --workspace --all-targets` | 111 binaries, 2,238 passed, 0 failed, 6 ignored | `paracord-desktop` rerun: 155 passed, 2 ignored (the only crate changed after the first run) |
| PostgreSQL 16 (throwaway `postgres:16` on :55432, removed after): upgrade from `v0.9.0`, `paracord-db` pool/migrations and query-plan smokes, `postgres_route_smoke`, the full `paracord-api --tests` suite (4 threads), SQLite to PostgreSQL migrator, archive restore (SQLite and PostgreSQL) | pass: 1, 1, 2, 805 (85 binaries), 109 tables, both restores [^pgtools] | no server SQL changed after |
| Not run locally | Windows and macOS jobs, the Docker image, coverage (`cargo-llvm-cov` is not installed), the Let's Encrypt (Pebble) smoke, the installer smokes | |

[^pgtools]: This machine has no `pg_dump`/`pg_restore`; they were shimmed to
`docker run --network host postgres:16-alpine`, as in the Glass check. The
migrator and restore smokes used a debug `paracord-server` built from this tree.

## Desktop

### How it was driven

As in the Glass check, with three differences.

- The app ran in a nested `kwin_wayland --virtual` (1440x928, its own D-Bus
  session, a throwaway `HOME`), maximized to a 1440x900 webview, with
  `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` (NVIDIA). The test build is the release
  `paracord-desktop` with `vpx` and without `custom-protocol`, so it loads its
  `devUrl` from a small server that serves the production `dist` and an in-page
  agent (same-origin command modules, no `eval`). The owner's display, the
  owner's server (UDP 8443) and the owner's installed client were not touched.
- The instance was the `live-env` environment on :18480 with a release server
  built from this tree. `client/scripts/index-scene.mjs` held the scene with
  `PULSE_SINK=glass_g23_out` (Vincent sharing a VP9 canvas in Game Night's
  Lounge, then the arrive, join and busy steps in Fuel). The desktop signed in
  as a separate account, Sam, a member of all three servers, so the scene's own
  viewer (Sean, headless Chromium) and the desktop never shared a call.
- **The desktop joined calls, with a microphone that provably could not be a
  real one.** A private PipeWire graph (`pipewire -c` with only a dummy driver
  and two null nodes, plus a WirePlumber with every device monitor disabled, on
  the socket `ix20-pw`) held the app's audio: the throwaway `HOME`'s
  `.asoundrc` points `defaults.pipewire.server` and `pcm.!default` at it, the app
  ran with `PIPEWIRE_REMOTE=ix20-pw` and with `PULSE_SERVER` aimed at a socket
  that does not exist. Before the first join, `arecord -D pipewire` in that
  `HOME` was linked from `ix20_null_mic` in the private graph and appeared
  nowhere in the real one. On every join `pw-dump` showed the app's capture
  stream linked only from `ix20_null_mic` and its playback only to
  `ix20_null_out`, and a poller found no client of the app's process tree in the
  real graph (86 to 103 polls across each join, 0 hits). What the app heard
  played into the private null output (recorded there to prove decoding: RMS
  4,291 with Jeremy talking). One caveat: cpal's ALSA device enumeration probes
  the PCM names ALSA lists, which include the hardware cards; that opens and
  closes them to read their formats, and never captures from them.
- `top -b -d 1` sampled `WebKitWebProcess` (the child of the app) and the app
  process for 30 s per state, first sample dropped; % of one core. A page-side
  sampler recorded over the same 30 s how often an infinite animation (the
  waveform loop) and any animation at all were running. Host load 1 to 4.

### Results

"Build" says which client the number was taken on: **1** is `f6233d7f`'s
client (before the speaking, key and waveform fixes), **2** adds the speaking
fix with the per-frame voice level, **3** adds the 100ms voice-level grid and
the key fix, **4** is the final client (200ms waveform loop). States that draw
no waveform did not change between builds.

| State | Build | WebKitWebProcess | App | Animating (share of the 30 s) |
|---|---|---|---|---|
| Quiet server (Fuel general, welcome) | 1 | **0.3** | 0.0 | none |
| Busy channel, nobody talking (Game Night, Lounge card live, Nick muted) | 1 | **0.5** | 0.0 | none |
| Busy channel, nobody talking (Basecamp general) | 3 | **1.6** | 0.1 | none |
| People (Friends) | 3 | 1.9 | 0.1 | none |
| Settings | 3 | 3.3 (median 2.0) | 1.3 | entrance only |
| A dialog (Keyboard shortcuts) | 3 | 5.4 (median 2.0, max 26 while it opened) | 3.0 | entrance only |
| Live card, the talker is the sharer (screen glyph, no waveform) | 1 | 2.2 | 1.3 | 5% (the ring) |
| Live card, Jeremy talking (CSS loop, 100ms grid) | 1 | 5.6 | 2.3 | waveform 98% |
| Busy channel, Vincent talking on the card (100ms grid) | 1 / 3 | 7.4 / 8.0 (another build-3 run read 9.7) | 2.9 / 4.6 | waveform 88-94% |
| Same, **200ms grid** | 4 | **6.0, 6.8** (two runs) | 4.2, 4.7 | waveform 93-96% |
| In a call, call view closed, Jeremy talking, voice level every frame | 2 | 25.5 | 17.1 | continuous |
| Same, **voice level on the 100ms grid** | 3 | **10.8** | 6.9 | ring 17% |
| ... with the waveform hidden | 3 | 6.6 | 4.5 | |
| ... with the waveform and the ring hidden | 3 | 3.0 | 1.8 | |
| In the busy call (6 people, Vincent talking), call view closed | 3 | 10.5 | 7.6 | ring 13% |
| Call view open, people grid, Jeremy talking | 3 | 12.2 | 7.0 | |
| Theater, people grid, Jeremy talking | 3 | 12.9 | 7.2 | |
| Watching Vincent's stream in the call view (not joined) | 1 | 6.8 | 9.1 | waveform 88% |
| Theater, stream | 1 | 9.6 | 9.7 | |
| Theater, stream, chat column | 1 | 9.0 | 9.1 | |
| Call view closed again (watch stopped) | 1 | 1.8 | 0.5 | |
| Dock switching every 1.5 s (transient) | 3 | 25.7 | 12.9 | the place moves |

The app process carries the native audio (decode, playback, capture into the
null source) and the native video, and on this shared-memory path it also
copies every frame WebKit paints, so it rises with paint count too.

- **Idle is well under budget.** At rest with nothing animating, the web
  process reads 0.3 to 1.9% of a core (Glass: 5.6). Nothing animates at rest:
  the sampler saw no animation in any quiet state.
- **The waveform's cost.** Somebody talking in a room you are not in costs
  about 5 to 6 points in the web process and 2 to 4 in the app (the CSS loop;
  5 paints a second after `1c1054eb`). In a call, the real voice level costs
  about 4 points and the talking ring about 3.6 on top of the call's own 3
  (the hide experiments above), about 11% in the web process with one talker.
  Before `53b41edd` that was 25.5% (a per-frame envelope and eased bars).
- **Video stayed on the native route.** Watching a stream: 6.8% (main), 9.6%
  (theater) in the web process, against Glass's 11.5 / 13.3 on the same route.
- Moves are transient: switching places every 1.5 s keeps the web process at
  about a quarter of a core while it runs.

### Screens

`output/design-reference/index-build/ix20/desktop/` (gitignored), all read:
`01-quiet-fuel`, `02-game-night-live`, `03-watch-vincent`, `04-theater`,
`05-theater-chat`, `06-someone-arrives`, `07-busy`, `08-gamenight-lfg`,
`09-yours` (taken while the speaking bug showed nobody talking),
`11-yours-jeremy-talking`, `12-call-view-joined` (Back to chat whole in the
card), `13-call-theater-joined`, `14-people`, `15-settings`,
`16-dialog-shortcuts`, `17-basecamp`, `18-busy-yours`, and
`19-final-binary-start` (the final binary on a fresh profile with nothing
serving :1420, so its UI is the embedded one).
`output/design-reference/index-build/ix20/card-*.png` are the room card crops
from `index-card.spec.ts`.

## The binary

`/home/scdouglas/Documents/Paracord-glass/target/release/paracord-desktop`,
built from `1c1054eb` with `npx tauri build --no-bundle`
(`beforeBuildCommand` `npm run build`, default features: `custom-protocol` and
`vpx`; `libvpx.so.12` is linked), `CARGO_TARGET_DIR` the shared Glass target.
The build embeds no commit id, so the docs-only commit after it changes
nothing in it. sha256:

```
e514c4c7810f6ead0ed9472217765682e681fbb04a57caff8bde388512346485
```

It was started once, in the nested session, to check that it shows the
embedded UI (`19-final-binary-start`). It was not installed and not run on the
owner's display.

## Left open

| Severity | Item |
|---|---|
| Medium | In a call on the desktop, one talker costs about 11% of a core in WebKitWebProcess (the call itself about 3, the real waveform about 4, the talking ring about 3.6). Halving the voice-level cadence or drawing the ring without a fade would cut it further, at a visible cost; that is a design call. |
| Low | The "busy channel" budget (5%) is met while nobody talks (0.5 to 1.9) and missed while someone on the card talks (6 to 7, the waveform loop). The plan's §5.4 treats talking as reported, not budgeted. |
| Low | The join-muted preference may still land after a person unmuted during a row join (the scene saw it once: unmuted, then muted ~1 s later). The scene now holds its state; the app was not changed, and it was not reproduced by hand. |
| Low | cpal's device enumeration opens and closes every ALSA PCM it lists, hardware cards included, whenever the native call starts (see "How it was driven"). Nothing is captured from them, but a privacy indicator could flicker. |
| Info | The scene's cast pages go idle after about 10 minutes without input, so a server's "N here now" drops to 1 in long runs. That is presence working as designed. |
| Info | `@someone` for people the client does not know, `lib/attention`'s light model, the engines' `ambient` token, the legacy classes pinned by `cascade.test.ts`: as IX-19 left them. |
| Info | Every process this pass started was stopped: the nested KWin and the app, the drive server, the scene holder and its browsers, the private PipeWire and WirePlumber, the instance on :18480, the PostgreSQL container. A Vite dev server left on :4173 by an earlier package (orphaned, parent gone) was stopped at the start so the e2e configs could start their own. |
