# Glass release check, 2026-10-04

The release-readiness pass over `design/glass`. It started at `dce83996`
(`main` was the same commit). It ran the CI gate as `.github/workflows/ci.yml`
defines it, measured the desktop app (Tauri on WebKitGTK) against a live
instance, and fixed what failed.

Another session committed to `design/glass` while this pass ran (`5cffcffb`,
`1bc00a09`, `019ecbc6`, `19db3e60`, `7dbcb1c5`) and kept uncommitted edits in
the worktree. This pass did not touch those files.

- The full gate was repeated on a clean checkout of `42db84a2` (this pass's
  performance commit, which includes `5cffcffb` and `1bc00a09`).
- The two Glass e2e configs that failed there were rerun on `7dbcb1c5` with
  `17af7324`.
- Nothing else after `42db84a2` was verified here.

## Commits from this pass

| Commit | What |
|---|---|
| `cb1d4929` | `chore(security)`: the `RUSTSEC-2023-0071` (rsa) exception in `.cargo/audit.toml` passed its 2026-09-30 review date, so `scripts/check_audit_exceptions.py` failed the Rust Dependency Audit job, and every other CI job waits on it. Re-verified that `rsa` is never compiled (`cargo tree -i rsa --target all -e all` prints nothing; it is only a `Cargo.lock` entry from sqlx's macro crate). Review date moved to 2026-12-31. |
| `11472ce4` | `fix(client)`: `npm audit --audit-level=moderate` failed (axios high, brace-expansion high, fast-uri moderate, dompurify low). `npm audit fix` updated these within the existing semver ranges: axios 1.18.1 to 1.20.0, dompurify 3.4.15 to 3.4.16, and the transitive packages. axios 1.20 types a response by its request params, so `GifPicker.test.tsx` failed `tsc -b`. It now uses one response helper per endpoint. |
| `4af47f73` | `test(client)`: Home opens its own page on a phone since `d8377004`. Five `glass-phone` e2e cases still expected places, and the real-server voice check tapped a face that was covered: the inert places screen sits under the page and Playwright reads it as visible. The specs now open the messages index when they need places and check Home's page, and the voice-check helper takes the way back first. |
| `42db84a2` | `perf(client)`: the waveform and the typing dots now step on one 100 ms grid. They were on 50 ms and 60 ms grids. Bar loops stay between 0.8 and 1.2 s. See "Desktop CPU". |
| `17af7324` | `test(client)`: `1bc00a09` removed the stream reaction controls and stopped mounting the reactions layer. `glass-phone` ("a reaction rises about 90px") and `glass-polish-2` ("reactions are announced politely") still asserted that layer, so both cases are removed. `StreamReactionsLayer.tsx`, its CSS, its unit test and `streamReactionStore` remain and are now unused. |

`cargo fmt` needed no changes: `crates/paracord-server/src/main.rs` and
`crates/paracord-api/tests/voice_listen_view_sse.rs` were already formatted.

## Gate results

The "First run" column is the worktree from `dce83996` up to `4af47f73`. The
"Final" column is a clean checkout of `42db84a2` with its own target directory.

| Gate (CI job) | First run | Final (`42db84a2`) |
|---|---|---|
| `check_audit_exceptions.py` (Rust Dependency Audit) | **failed** (expired review date), fixed in `cb1d4929` | pass |
| `cargo audit` | pass (warnings only: unmaintained/yanked/unsound advisories) | not rerun (no lockfile change) |
| `npm audit --audit-level=moderate` (Client Dependency Audit) | **failed** (4 advisories), fixed in `11472ce4` | pass (0 vulnerabilities) |
| `security_gate_check.py` | pass (no tracker present, skip by design) | not rerun |
| `ci_migration_sanity.py`, `check_release_version.py` (3.3.0), SQLite upgrade from `v0.9.0`, SQLite query-plan smoke, migration line endings, Python syntax, `bash -n` installers | pass | not rerun (no changes in these areas) |
| actionlint (docker, pinned digest) | pass | not rerun |
| `npm run contracts:check` | pass (37 types) | pass (in the worktree) [^contracts] |
| `export-contracts --check contracts/api-contracts.json` | pass | not rerun |
| `npm run typecheck` | pass | pass |
| `npm run lint` | 0 errors, 214 warnings | 0 errors, 214 warnings |
| `npm run test:a11y:static` | pass | pass |
| `npm run test:contrast` | pass (52,950 comparisons) | pass |
| `npm test` (typecheck, unit, tokens, motion lint) | 410 files, 4,216 tests pass (twice) | 410 files, 4,224 tests pass |
| `npm run build` | pass | pass |
| `npm run test:e2e` (CI=1, mocked) | 122 passed | see below |
| `PARACORD_E2E_REAL=1 npx playwright test` (CI=1, `PARACORD_E2E_MEDIA_PORT=18159`) | 16 passed, 1 **failed** (voice check, phone), fixed in `4af47f73`; that spec then 3/3 | see below |
| `e2e/glass-*.config.ts` (each on its own ports, one at a time) | calls 6, pages 25, pill 12, polish-2 15, room 6, sheets 14, stage 8, theater 9 pass; phone 22/27 (**5 failed**, fixed in `4af47f73`, then 27/27); longtail 17/18 [^longtail] then 18/18 | see below |
| `cargo fmt --all -- --check` | pass | pass |
| `cargo clippy --workspace -- -D warnings` | pass | pass |
| `cargo clippy -p paracord-desktop --all-targets -- -D warnings` (vpx on) | pass | pass |
| `cargo test --workspace --all-targets` | 2,208 passed, 0 failed, 6 ignored (110 test binaries) | 2,211 passed, 0 failed, 6 ignored |
| `cargo check --workspace` and `--no-default-features` | pass | not rerun |
| `cargo check --manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on) | pass | covered by the desktop clippy above |
| PostgreSQL 16 (throwaway `postgres:16-alpine` on :55432): `paracord-db` pool/migrations smoke, query-plan smoke, `postgres_route_smoke`, full `paracord-api --tests` suite (4 threads) | 1, 1, 2 and 805 passed | not rerun (no server SQL changes after `dce83996`) |
| `release_postgres_upgrade_from_tag_smoke.py v0.9.0` | pass | |
| `ci_pg_migrator_smoke.py` | pass (109 tables) [^migrator] | |
| `ci_restore_smoke.py` (SQLite and PostgreSQL) | pass [^pgtools] | |
| `ci_install_smoke.sh` | 66 assertions pass (`PARACORD_SMOKE_SKIP_ROOT=1`; no passwordless sudo here) | |
| Not run locally | Windows/macOS jobs, the Docker image, coverage (`cargo-llvm-cov` not installed), the Let's Encrypt (Pebble) smoke | |

[^contracts]: In the clean checkout `contracts:check` reports
`validators.js` stale. That checkout's `node_modules` is a symlink, and a
symlink leaks its real path into the generated comments (a known gotcha). The
same check passes in the worktree, where `node_modules` is a real directory.

[^longtail]: "command palette at desktop" timed out waiting for the app. The
run overlapped `npm audit fix` rewriting `node_modules` under the dev server.
The case passed on its own rerun.

[^migrator]: With the default 900 s budget, the script's own debug build
timed out while the host was at load 100. The smoke passed against the existing
debug binary (`PARACORD_MIGRATOR_BINARY`).

[^pgtools]: This machine has no `pg_dump`/`pg_restore`. They were shimmed to
`docker run --network host postgres:16-alpine`, the same major version as the
server.

### Final e2e (`42db84a2`)

| Run | Result |
|---|---|
| `npm run test:e2e` (CI=1, mocked) | 122 passed |
| `PARACORD_E2E_REAL=1 npx playwright test` (CI=1, release server built from `42db84a2`) | 17 passed |
| glass configs: calls, longtail, pages, pill, room, sheets, stage, theater | 6, 18, 25, 12, 6, 14, 9, 9 passed |
| `glass-phone`, `glass-polish-2` | 26/27 and 14/15 at `42db84a2`. The failing cases asserted the reactions overlay that `1bc00a09` removed (see `17af7324`). On `7dbcb1c5` + `17af7324`: 26/26 and 14/14. |

## Desktop CPU

### How it was driven

KDE Wayland gives no input automation, so the app was not clicked. A small
in-page agent drove it:

- The app is a release build of `paracord-desktop` with VP9 (`vpx`) on and
  `custom-protocol` off (`--no-default-features --features vpx`), so it loads
  its `devUrl`.
- A small Node server on `:1420` serves the production client build and
  injects one module script. That script long-polls the same origin for
  command modules and posts their results back. It uses no `eval`, so the
  app's CSP stays on, and it adds no product code.
- The window runs in a nested `kwin_wayland --virtual` (1440x928, its own
  D-Bus session), maximized to a 1440x900 webview. KWin scripting over that
  session places the window, and `spectacle` inside it takes screenshots.
- This is an NVIDIA box, so the app sets `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`
  as it does on the owner's desktop.
- The instance came from `scripts/live-env.mjs` on :18420. The scene came
  from `client/scripts/glass-scene.mjs`: Vincent shares a VP9 simulcast screen
  (320x180, 640x360, 1280x720), Brendan is on camera and talking, Nick is muted.
- The throwaway profile's `approved_origins.json` was pre-seeded with the test
  origin, so the native "Trust new Paracord instance?" prompt did not block the
  connection.
- `top -b -d 1` sampled each state for 30 s (first sample dropped). It
  measured the `WebKitWebProcess` child of the test app's pid and the app
  process itself. A counter on WebGL `drawArrays` recorded the stream canvas's
  presented frames per second over the same window.

The states:

- A, idle conversation: Basecamp General. Nothing is live in Basecamp, but the
  pill shows the Game Night call with its waveform.
- B, room light live: Game Night General, with the ambient view lighting the
  room.
- C, side by side: watching Vincent's screen.
- D, theater.
- E, stage moves: T every 1.5 s, side to theater and back.

### Results (percent of one core, mean of two alternating 30 s runs per build)

| State | WebKitWebProcess before | after | App process before | after | Stream fps |
|---|---|---|---|---|---|
| A idle conversation | 8.4 | **5.6** | 4.1 | **2.2** | none |
| B room light, live stream | 14.0 | **12.6** | 5.3 | **3.8** | none drawn (ambient) |
| C stage, side by side | 44.5 (38.6, 50.4) | **36.2** (36.5, 36.0) | 9.4 | 8.9 | 23.4 / 23.2 |
| D theater | 42.5 (39.0, 45.9) | **37.2** (38.6, 35.9) | 10.2 | 9.4 | 23.6 / 23.4 |
| E stage moves (transient) | 63.9 | 58.5 | 11.9 | 11.2 | 22.8 / 22.9 |

"Before" is the client at `4af47f73`, "after" is the same with `42db84a2`. The
desktop binary and the instance were the same for both. The two builds
alternated (before, after, before, after) at host load 3 to 4.

- A and B improved in every run.
- The C and D differences are within run-to-run noise: one "before" C run read
  50.4, the other 38.6.
- With the eq and typing loops paused outright, A measured 2% and 0%, so those
  loops were almost all of the idle cost.

Earlier runs in this pass are not in the table:

- Runs during a typing burst read B at 17 to 26%. The 60 ms typing dots cost
  2 to 12% on their own.
- Runs taken while the host was at load 80 to 100 were discarded. That load
  came from another project's test jobs and another session's build. The scene's
  publishers in headless Chromium also degraded and stopped sending video.

### Where the cost goes

Experiments in the running app hid or paused one thing at a time (20 s
samples):

- **The stream canvas is most of C and D.** With `.glass-stage__canvas`
  hidden, C fell from about 31 to 37% to about 10%, and D from 34 to 45% to 8%.
  Each presented frame (about 23 per second here) is a WebGL `texSubImage2D`
  from the WebCodecs `VideoFrame`: 2.5 ms on the main thread, about 6% of a
  core. On top of that come WebKit's composite and the shared-memory copy of
  the whole window.
  - Per-thread split in C: main thread about 13%, ThreadedCompositor 9%,
    SkiaGPU worker 5%, HeapHelper (GC) 4%, the decoder's `appsrc` thread 2.5%.
  - The renderer, frame taps (room sampler at a capped rate, `createImageBitmap`
    per sample) and React do no extra per-frame work.
- **Decorative loops.** Every stepped frame of the waveform or typing dots is a
  whole-window copy on this path. Before `42db84a2` they were about 9% in
  WebKitWebProcess and 7% in the app with the window otherwise idle.
- **Room tint.** `--room-rgb` changed about once a second with a live stream;
  freezing it saved about 6% in B.
- **The grain** added on 2026-10-03 (`--surface-grain` on panes and the
  backdrop) made no measurable difference. It is a cached tile.

### The native-surface route, for comparison

With `VideoDecoder` hidden from the page (the test-only `g23ForceNative`
switch), every remote video takes the native-surface route. The app decodes
and draws the video in the GL underlay beneath a transparent webview. This was
measured with the old (50/60 ms) loop grids, at low host load:

| State | WebKitWebProcess | App |
|---|---|---|
| A | 7.3 | 6.6 |
| B | 17.4 | 13.6 |
| C | 16.6 | 17.0 |
| D | 14.5 | 17.9 |
| E | 43.8 | 20.1 |

On this route, side by side and theater cost about 34% across both processes,
against about 46% on the WebCodecs route. WebKitWebProcess stays under 30% in
every steady state. The route is chosen once per subscription by the WebCodecs
probe (spec §2). This pass did not change that choice; see the open questions
below.

## Left open

| Severity | Item |
|---|---|
| Medium (owner decision) | Watching a stream on the Linux desktop keeps WebKitWebProcess at about 36 to 37% of a core (side by side, theater), above the ~30% budget. Most of it is WebKit presenting about 23 frames a second through the forced shared-memory path (NVIDIA). The native-surface route measured about 15 to 17% in WebKitWebProcess (about 34% with the app process included). Preferring it on Linux when `nativeRenderUnderlay` is available would change the route spec and move more of the stage onto the underlay path (shield and poster during moves, hole punching), so it was not changed in a release check. |
| Medium (unconfirmed) | On binaries built before `1bc00a09`, the watched stream sometimes froze until the client's 4 s stall detector re-registered the subscription. That happened about every 1 to 2 minutes while BWE moved between 320, 640 and 1280 layers. A frame arrived within milliseconds of re-registering, so the relay had frames. `1bc00a09` (another session) fixes phantom simulcast loss that starved bitrate, which may be the cause. Not re-tested on a newer build. |
| Low | Stage moves (E) run WebKitWebProcess at about 60% of a core while a move is in flight: a 650 ms full-window animation at 60 fps through the shared-memory copy. This cost is transient, not steady state. |
| Low | B (the room lit by a live stream) costs about 12.6% even with no stream on screen. That comes from the ambient decode, the room tint (about one restyle per second) and the waveform. |
| Low | `StreamReactionsLayer` (component, CSS, unit test) and the reaction store and route are unused since `1bc00a09`. Delete them or bring the overlay back. That belongs to the session that removed it. |
| Info | `glass-scene.mjs`'s holder REST token expires after about 40 minutes (401 on status and typing), as the G3 notes say. Under host load its headless publishers stop sending video. For CPU runs, restart the holder or drive typing yourself. |
| Info | The owner's own desktop client (pid 3420116) was running at the start and is not running now. This pass never signaled it: the test app ran under its own pid file in a nested session. |

## `main`

The brief allowed a fast-forward of `main` only if it still pointed at
`dce83996`. It did not, so this pass did not fast-forward it.

- Another session had already fast-forwarded `main` (in
  `/home/scdouglas/Documents/Paracord`), first to `019ecbc6` and then to
  `7dbcb1c5`.
- `main` therefore contains this pass's first four commits.
- `17af7324` and this document are only on `design/glass`.
- This pass did not touch `main` or its working tree (still only
  `test-results/` untracked). Nothing was pushed.

## Addendum: native video only (`feat/native-video`, 2026-10-04)

The owner decided the first open item: in the desktop app every remote video,
and the self-view, takes the native-surface route on every platform; WebCodecs
stays only in the browser client (docs/glass-spec.md §6.6,
docs/streaming-native-render-spec.md §2). Measured the same way as above
(nested KWin, 1440x900, `top -b -d 1`, 20 s per state, glass scene without
typing). "Before" is `cd6239c9` (WebCodecs route), "after" is the native-only
build; the runs alternated (after, before, after, before, after). The host was
shared with other jobs (load 5 to 58 during the runs), so single runs vary; the
table gives the mean of the runs.

| State | WebKitWebProcess before | after | App before | after | Both before | after |
|---|---|---|---|---|---|---|
| A idle conversation | 8.0 | 7.6 | 4.9 | 4.5 | 12.9 | 12.1 |
| B room light, live stream | 7.2 | 7.2 | 4.4 | 4.8 | 11.6 | 12.0 |
| C stage, side by side | 30.3 (29.4, 31.2) | **11.5** (9.9, 8.9, 15.6) | 15.4 | 16.4 | 45.7 | **27.9** |
| D theater | 39.1 (37.6, 40.5) | **13.3** (9.4, 14.4, 16.2) | 15.7 | 21.5 | 54.8 | **34.8** |
| E stage moves (transient) | 70.9 | **46.8** | 23.0 | 32.6 | 93.9 | 79.4 |

- Watching side by side keeps WebKitWebProcess at about 9 to 16% of a core,
  under the 30% budget. The decode and GL upload moved to the app process.
- A 42-minute watch on the native route logged four gaps between presented
  frames (1.7 to 4.2 s, during host load above 30); each ended on its own with
  no re-registration, and no freeze needed the old 4 s stall detector (which no
  longer exists: it belonged to the WebCodecs channel).
