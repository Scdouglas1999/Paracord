# IX-3 checkpoint: Live scene driver

Plan row: `docs/design/index-plan.md` §3 (IX-3). Contract for the scene: the prototype
(`output/design-reference/index/paracord-index.html`) and its ten reference renders
(`output/design-reference/index/ref/*.png`). Worktree `~/Documents/Paracord-index`, branch `feat/index-ui`.

IX-3 is a driver, not UI. It stands the prototype's evening up on a **real instance** (real accounts,
channels, messages, end-to-end encrypted DMs, real calls with real audio and a real share) and shoots the
viewer's window of it, so every later package can hold its own states against the references on the real
thing, and IX-20 can run the whole set. It was proven against today's UI (Glass, plus the Index frame as
IX-4 landed it); the Index-specific paths are written to the plan and first meet a real Index build when
IX-5/IX-7 land.

## Files (all new; nothing outside IX-3's scope was edited)

```
client/scripts/index-scene.mjs            CLI: options, lifecycle, holder, forwarding of --step/--shot/--status
client/scripts/index-scene/scene.mjs      the scene as data: cast, servers, channels, posts, DMs, Lounge, story
client/scripts/index-scene/seed.mjs       accounts, servers, channels, members, posts, read marks; reset of Fuel
client/scripts/index-scene/dms.mjs        encrypted DMs, typed into each person's own composer (one-time, ~2 min)
client/scripts/index-scene/cast.mjs       the other people: one Chromium each, joined/moved/muted through the app
client/scripts/index-scene/viewer.mjs     you (Sean): one persistent browser profile, client-side navigation only
client/scripts/index-scene/story.mjs      the steps: arrive, join, busy, reset; `ensure(position)`
client/scripts/index-scene/shots.mjs      the ten reference states (+ one diagnostic), per-state run/after
client/scripts/index-scene/ui.mjs         every UI action, Index and Glass paths side by side
client/scripts/index-scene/control.mjs    how a second invocation drives the process holding the scene
client/scripts/index-scene/assets.mjs     the "clip" Jeremy posts (a real 2 s WebM recorded from a canvas)
client/scripts/index-scene/check.mjs      `--check`: the scene's data agrees with itself, offline
client/scripts/index-scene/vite.dev.config.mjs   dev server for the working tree (see "Using a dev server")
```

Reused by import from `client/scripts/glass-scene/` (not edited): `api.mjs` (REST and realtime),
`assets.mjs` (SVG to PNG for the four photos), `art.mjs` (`FACES`, `STREAM_SCENE`), `media-init.mjs` (Vincent's
canvas share, the speech-like microphone, silence; reached through `openAs`), `ui.mjs` (`launchBrowser`,
`openAs`, `CONTROLS`, `press`, `setToggle`, `sceneOnScreen`, ...), `call.mjs` (`readRoom`, `leaveCall`,
`mediaProbe`). `call.mjs`'s `startCall` is **not** called: it is fixed to the Glass cast (Brendan on camera
and talking, Vincent quiet) and to Glass's pill, and the Index story needs people who join, move and mute at a
step. A one-line `startCall(spec = CALL)` parameter in `call.mjs` would let it be used; that file is outside
this package's scope, so it is only suggested here.

## How to run it

```
node scripts/live-env.mjs --port 18420                  # an instance (needs target/release/paracord-server)
node client/scripts/index-scene.mjs --check             # offline: the scene's data is consistent
node client/scripts/index-scene.mjs                     # seed (first time), bring Lounge up, HOLD
  node client/scripts/index-scene.mjs --step arrive     # (from another shell) Jeremy joins Fuel, talks
  node client/scripts/index-scene.mjs --shot s1-someone-arrives
  node client/scripts/index-scene.mjs --step join | busy | reset
  node client/scripts/index-scene.mjs --status
node client/scripts/index-scene.mjs --shot all          # one process: set up, shoot all ten, tear down
node client/scripts/index-scene.mjs --shot x-lounge-share   # diagnostic: Vincent's share arrives as pixels
node client/scripts/index-scene.mjs --help              # every option
```

- **States** are exactly the reference renders: `s0-quiet`, `s0-plan-a-night`, `s0-message-box-open`,
  `s1-someone-arrives`, `s2-joined`, `s3-call-open`, `s4-other-server`, `s5-busy`, `s5-busy-title-folded`,
  `s6-people`. A shot names the story position it needs (`quiet`, `arrived`, `joined`, `busy`) and gets
  there: it steps forward, or resets first when the scene is already past it. Shots go to
  `output/design-reference/index-build/live/<state>.png` (`--out`, `--viewport WxH`, default 1280x800); that
  folder is a valid input for `node client/e2e/index-compare.mjs <folder>` (run once: 9 states compared, worst mean difference 8.5 % of
  Glass against the Index references, as expected today). `shots.json` records, per state: `ok | pending | failed`, which interface was
  on screen (`ui: glass | index`), whether a talking cue was on screen (`talking`), and what an Index build
  was missing (`missing`, with `--lenient`).
- **The story** (`scene.mjs` header has the table): the prototype's Fuel starts new and empty (Sean alone, rooms
  General and Late night) while Game Night's Lounge is live (Vincent sharing and talking, Brendan, Nick muted,
  three Chromiums holding it). `arrive`: Jeremy joins Fuel by invite, says hello, posts a clip in clips, joins
  General talking. `join`: you join General from the card. `busy`: Vincent and Brendan **move** from Lounge to
  General (a person cannot be in two rooms; Nick stays in Lounge), Maya comes online and joins, Jeremy mutes so
  Vincent is the one talking, the eight messages land, Jeremy plans Movie night in plans (a real scheduled event
  and its share). `reset`: back to quiet **without changing Fuel's id** (everyone else is removed, messages and
  events deleted), so the dock keeps its order. Six real people, seven fillers so Game Night says "12 members",
  Basecamp "5", no icons and no avatars so the monograms show.
- **Holder protocol**: a holder owns every browser and listens on a loopback port it picks; it writes
  `<out>/control.json`. `--step/--shot/--status` read it, check the pid, post the command and stream the log back.
  A second holder for the same `--out` is refused. Ctrl-C / SIGTERM make everyone leave and close every browser.
  The holder logs a status line every 30 s with per-person video and audio packets a second as the relay counts them,
  and heals a person the relay has lost twice running.

## Instance, ports and processes used for the proof

Instance on **18460** (UDP voice 18461), data dir `/tmp/claude-1000/-home-scdouglas-Documents-Paracord/b3a0a140-c23e-4fa5-b47f-694ae9922a96/scratchpad/ix3-data`
(throwaway, wiped on start). A Vite dev server on **4693** was used for some runs and stopped. Neither the owner's
instance (pid 1203) nor the default 18420 was touched. **Every process I started was stopped** (instance, Vite,
every Chromium, every holder); checked with `ps` at the end.

The Index worktree has no `target/`, and `scripts/live-env.mjs` hardcodes `<repo>/target/release/paracord-server`. I
ran an unmodified **copy** of `live-env.mjs` from a scratch directory (`.../scratchpad/ixenv/scripts/`) beside a symlink
`ixenv/target/release/paracord-server` to the Glass worktree's release binary (built 2026-10-04 08:31, so its
embedded UI is Glass as of that morning, older than HEAD). No file in any worktree was touched. Until IX-20 builds a
server here, anyone running this needs the same trick (or their own build).

## What was verified (commands and results)

| Check | Command | Result |
|---|---|---|
| Scene data consistent | `node client/scripts/index-scene.mjs --check` | `scene data: consistent`; with three deliberate corruptions it names five problems |
| Syntax, unused names | `node --check` on every file; ESLint with `no-unused-vars` + `no-undef` on every file | clean (the repo's `npm run lint` ignores `scripts/**`, so it neither covers nor is affected by these) |
| Repo gates | `npm run typecheck` | passes. `npm run lint`: 5 errors, all in other packages' files (`ix/dock/useDockIndicator.ts`, `rooms/lobby/ServerBar.tsx`), none mine. `test:tokens` and `test:motion-lint` pass (they scan `src/` only; the only literal colors here are the canvas fills of a generated video) |
| **First run from a fresh instance** | `node client/scripts/index-scene.mjs --base http://127.0.0.1:18460 --shot all` | exit 0: 13 accounts, 3 servers, 9 posts incl. 4 photos, 4 identities enrolled, 7 encrypted DM lines, Lounge up, 9 states shot, `s0-plan-a-night` pending. About 5 minutes (about 2.5 of them the one-time DM seed) |
| Full set, repeat run | `... --shot all,x-lounge-share` | exit 0 in 2 min 10 s on the existing scene: 9 shots, 1 pending, diagnostic passes |
| Holder and steps | holder `--hold`; then `--status`, `--step arrive`, `--shot s1-someone-arrives`, `--step join`, `--shot s3-call-open`, `--step busy`, `--status`, `--shot s5-busy --viewport 1440x900`, `--shot s4-other-server` (scene past it: auto reset, arrive, join), `--step reset`, `--shot s0-quiet`, `--status` | every command rc 0; a second `--hold` is refused; SIGTERM leaves cleanly |
| Lounge holds with real audio and a real share | `--status` and `x-lounge-share` | `Lounge: Vincent (sharing, 203 video pkt/s, 50 audio pkt/s), Brendan (50 audio pkt/s), Nick`, relay `3 connected over webtransport`. Viewer's screen with Vincent's canvas share: **3385 px teal, 14854 px amber** counted in a fresh screenshot (`x-lounge-share.png`); `s1`/`s5` show the app's own "Jeremy is talking" / "Vincent is talking" from real voice activity |
| Reset path | partial runs left Fuel half-built; the next start printed `Fuel back to quiet: 3 messages, 0 events and 5 members removed` | works from every position |
| `--ui` and detection | Vite dev server of this tree, `--ui http://127.0.0.1:4693 --no-dms [--no-lounge]` | the driver sees the Index frame (`ix-sidebar`), asserts the Index test ids and fails loudly naming the missing ones (`ix-welcome`, `ix-room-card`/`ix-room-row`); with `--lenient` it lists them on the shot instead |
| Phone viewport | `--viewport 390x844 ... --shot s1-someone-arrives` | shot taken (Glass phone shell) |

Screenshots (gitignored, on disk): `output/design-reference/index-build/live/` (`s0-quiet.png`, `s0-message-box-open.png`,
`s1-someone-arrives.png`, `s2-joined.png`, `s3-call-open.png`, `s4-other-server.png`, `s5-busy.png`,
`s5-busy-title-folded.png`, `s6-people.png`, `x-lounge-share.png`, `shots.json`, `scene.json`, `compare/` side by sides from
the compare tool). All were read. Phone: `.../scratchpad/ix3/out-phone/s1-someone-arrives.png`; the Index frame with stubs:
`.../scratchpad/ix3/out-ui/s0-quiet--failed.png`.

## Differences from the prototype, and why (what a reader of the shots will see)

- **Today's UI is Glass**, so every shot says `[glass]`; the shots prove the scene (data, presence, calls), not Index.
  Compared with the Index references the compare tool reports 6.3 to 8.5 % mean difference, as expected.
- **Times are real**: everything is "today, now" (messages minutes apart, previews "1:48 PM"), where the prototype has
  9:41 PM, Mon, Sun. There is no API to backdate a message, so the 30-minute "Today 9:41 PM" dividers and the
  "Tue/Mon/Sat" labels cannot appear. "live 34 min" is the real elapsed time ("LIVE 1 MIN" right after a run starts).
- **Counts match, on purpose**: Fuel "6 online" at busy; Game Night "4 online, 3 in Lounge" (Vincent, Brendan, Nick and
  you; Maya stays offline until `busy`).
- **Fuel gets a real "Coming up" row** in `busy` (Movie night is a real event within seven days); the prototype has none.
- **Server colors** (Fuel 350, Game Night 195, Basecamp 150) are sent with `PATCH /guilds/{id} {hue}` and read back; this
  server build (older than IX-2) does not store them, which the seed says plainly. Against a server built from this tree
  they should land; unproven.
- **"Jeremy posted a clip"** is a real WebM attachment; Glass previews it "Jeremy shared a video". The photos preview
  "Nick shared 4 files".
- **People list previews** read "Encrypted message ..." in Glass (the app's choice, decryption is per open conversation);
  the conversation itself decrypts ("made the server yet?", your cream "doing it now").
- `s0-plan-a-night` is **pending** until the Index action card (`ix-action-card[data-action=plan]`, IX-15) exists.
  `s5-busy-title-folded` scrolls the conversation to 120 px from its top as the reference does; in Glass there is no
  large title to fold, and the feed only scrolls 149 px, so the shot differs from `s5-busy` by scroll alone.

## What later packages must know

**The Index paths are written to the plan, not proven.** They run when `ix-sidebar` is on screen and the Index control
exists. Which control to use is decided per action by which one is visible (the Index frame is on screen from IX-4 with
Glass's pill still inside it), never by a flag. The names they expect, in `ui.mjs` (`IX`, `INDEX_NAMES`) and `shots.mjs`:

- join: `ix-room-card` > `ix-card-join` (filtered by the room's name), else `ix-room-row`; joined = `ix-card-leave`;
  `ix-card-open-call`, `ix-call`, `ix-call-back`; welcome `ix-welcome`, `ix-action-card[data-action="plan"]`;
- mic is a toggle with `aria-pressed` named one of `Microphone`, `Mute`, `Unmute`, `Mute microphone`, `Unmute microphone`;
  the screen control `Share your screen` or `Share screen`, then `Stop sharing your screen` or `Stop sharing`;
  Vincent's Watch is a button named `Watch Vincent...`;
- the message box keeps `textarea[data-composer-input]` (the DM seed, `s0-message-box-open` and the viewer's unlock use it);
- the encrypted conversation offers a link named `Unlock encryption`, then `/unlock` with a password field and a button `Unlock`;
- the conversation's scroller is "the largest scrollable box in `main`";
- a talking cue is the text "X is talking" (Glass) or an animation with no end (Index, spec 4.4: the waveform loop runs
  only while someone talks). A synthetic voice speaks in phrases with pauses; the shot waits up to 15 s for the cue and
  records `talking: false` rather than failing.

When a name differs, change it in `ui.mjs`; the failure message names the id that was missing. IX-7, IX-13 and IX-15 should
run `--shot <their states> --lenient --no-lounge` early, then without `--lenient` when their part is done. IX-20: build a
server here, embed the Index UI (`client` build, touch `embedded_ui.rs`), and run `--shot all` with no `--ui`.

**Traps found (each cost a failed run; each is handled or documented):**

1. **A dev server in front of an older server shows an empty dock** ("This server is not available"): READY guilds without
   the IX-2 `hue` field fail the generated guard. Pair the dev server with a server built from the same tree.
2. **The encryption identity cannot be set up through a dev server**: the attach challenge is bound to the instance's own
   origin (`The identity challenge belongs to a different server`). The one-time DM seed therefore always uses the
   instance's own URL.
3. **The identity cannot be copied between browsers** (Playwright storage state drops the non-extractable device key; the app
   then says "Encrypted local storage requires an account-owned nonextractable key"). So the viewer is **one persistent
   Chromium profile** (`<out>/viewer-profile/`), used by the seed and by every run. It belongs to one instance: delete
   `--out` with the instance's data (the driver clears it itself when it registers a new Sean). One process at a time may
   use it. Because the profile is origin-bound, DMs are readable only when the app is served from the instance;
   with `--ui` use `--no-dms`.
4. **The `/unlock` page bounces back to the app while the runtime is still deciding**; the viewer unlocks the way a person
   does, from a DM composer's "Unlock encryption" offer.
5. **A full page load drops the viewer's call and locks encryption again**, so the viewer and the cast navigate by telling
   the router (`pushState` + `popstate`), never `goto`, after sign-in.
6. **Auth guard**: a refused register counts against the address and five lock it out for a minute. `scene.json` tells the
   driver the accounts exist (written as soon as sign-in succeeds); `--existing` does the same by hand.
7. **After a shutdown the relay lists the cast for up to about 30 s** (idle retirement); `voice-states` is clean at once, and
   starting again into that window works.
8. **Vite refuses `/@fs` outside the root**, and this worktree's `node_modules` is a symlink into the Glass worktree, so fonts
   403; `vite.dev.config.mjs` (the app's config plus `server.fs.strict: false`) fixes it. Start command is in its header.

**Open / not done:**

- The Index code paths, the hue write against an IX-2 server, and `--ui` against a matching server are unexercised.
- Tablet and phone states have no references; `--viewport` works, the states are the ten desktop ones.
- Time-dependent labels cannot match the prototype (see above); IX-0's mocked harness has the fixed clock.
- `live-env.mjs` still needs a `target/` (above). `call.mjs` would need a one-line parameter to be reused whole.
