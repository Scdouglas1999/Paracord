# Glass completion, 2026-10-03

Continues Claude's `design/glass` worktree at `d5b7f74a`, including its pending G23 changes. The early G2 gaps are implemented: data-derived unread badges, timeline cards and event/live chips, banner-based room lighting, roster-based presence and uploaded avatars, and functioning Listen, Watch and Join controls. Initials remain the fallback for accounts without an avatar; scene-specific counts are not hard-coded into production.

## Finishing fixes

- Capture a conversation's original read cursor after the initial snapshot arrives, before marking it read. A successful empty snapshot still proceeds; leaving the conversation cancels the deferred write.
- Requeue unread-count requests when a newer channel tail arrives during an existing fetch.
- Anchor the channel heading's menu so unrelated timeline scrolling cannot dismiss it during a click.
- Recover browser and Rust media decryption after missed sequence wraps, including fresh packets whose sequence overlaps old replay slots. Replay checks use the authenticated packet index. Counter searches remain bounded and paced.
- Keep a late ambient sampler's cleanup from unregistering the visible stream that replaced it.
- Retain the pending native sampler, decoder handoff, stage geometry, DM reaction availability and lower-frequency decorative animation changes.
- Wait for real crypto operations in role tests and advance the daily-word reveal timer explicitly, replacing timing assumptions exposed by a loaded development machine.
- Ignore delayed underlay repaint after the page's window is gone.

## Verification

- Real-instance browser drive: 25/25 passed, including enrollment, friendships, channel messages, encrypted DMs and groups, member removal/key rotation, edits, reactions and deletes. Screenshots and results: `/tmp/paracord-glass-live-results`.
- Production TypeScript/Vite build and Linux Tauri release build, with default VP9 support enabled.
- Windows GNU release cross-build executes on the Windows server host.
- Server integration tests: 22 passed across channel previews, listen/view, realtime listen/view and stream reactions.
- Sender key tests: 17 passed; Rust crypto tests: 30 passed; native VP9 pipeline tests: 15 passed.
- Four read-state/menu suites: 101 passed; native sampler/underlay: 6 passed.
- Initial complete client unit run: 4,204 passed, four assertions failed and one delayed-window error. The read-count test was being updated during that run; the other failures were fixed asynchronous timing assumptions. All four affected suites then passed together (34 tests), without the window error.
- All 15 polish browser cases passed across the initial run and focused reruns. Under heavy host load, several initial runs timed out at the app's loading screen; focused reruns passed. Camera framing, expanded Watch access, reactions, menu operation, sheets, phone resizing and empty calls were exercised.
- Static accessibility, token and motion audits passed. Contrast: 52,950 comparisons passed. ESLint: zero errors, 214 existing warnings. Rust formatting passed.

Claude's prior native performance artifacts remain in its temporary `scratchpad/desk` directory. They are inherited measurements, not a benchmark repeated in this completion pass. Windows desktop and macOS builds are not verified by this Linux build.

## Deployment

The final Windows server is installed and running under the existing `Paracord Server` scheduled task at `https://192.168.1.28:8443`. The health endpoint passes and the served index exactly matches `client/dist/index.html`. Existing configuration and database are preserved. Protected rollback backup: `C:\Program Files\Paracord\backups\before-glass-20261003-091627`. Server executable SHA-256: `269b90e094e95b95aa0cf951f2dd85b99a4cd5f1afcf4f4a3d29ed5ae164886c`.

The desktop is installed at `/home/scdouglas/.local/share/paracord-client/bin/paracord-desktop` and launched through the user's `paracord` launcher. Installed executable SHA-256: `81d2383dbf463abed25eb7899a6487110b809b7aa42b330b29a1aa7ea1b1e6d3`. Previous binary and local-storage backup: `/home/scdouglas/.local/share/paracord-client/backups/before-glass-20261003-091732`. The connection form successfully probed the Windows endpoint and returned to its sign-in screen. The expired user session requires the user to sign in; no credentials were changed.
