# Feature program (started 2026-09-22)

Why: with fewer than a full server of active people, Paracord feels barren. It is not
short of features: polls, forums, events, threads, scheduled messages, XP, bots,
stage channels, automod and Sports all exist. The problem is that:

- they are buried in settings,
- every surface gets its life only from people being online, so a quiet server
  reads "dark / nobody's in",
- nothing arrives unless someone types,
- the server home is a directory, not a place.

Principles for all work here:

- Premium, quiet motion: 150–250 ms, ease-out, small translate/scale, reduced-motion safe.
- Glow belongs to anything live: a person, a game on, a new post, an event starting.
  The light *wording* goes: say online, here, active.
- No fallbacks: one deterministic path per capability, and loud errors instead of silent
  degradation. Encrypted DMs are never read by the instance.
- Every UI change is verified with screenshots from a seeded lab at 1440×900 and 390×844.

## Pillars and workstreams

| # | Workstream | Branch / worktree | Status |
|---|---|---|---|
| 1a | Search across a server: filter chips (`from:` `in:` `has:` `before:`), grouped results | `feat/search` | merged into `feat/program`. Carry-overs: result times say "PM", not "pm"; markdown backticks show raw in snippets |
| 1b | Who reacted, Remind me (+ Reminders inbox), Forward, role mentions | `feat/actions` | merged. Follow-up: move DM-to-DM forward attribution inside the encrypted body; the "React" menu has the same stale-position bug that was fixed for Remind me |
| 1c | User and server banners, sticker management, media gallery (Media / Files / Links) | `feat/assets` | merged. Old data-URL hub banners are converted at startup. Follow-ups: DM gallery (needs on-device decrypt); avatars have the same stale-cache bug |
| 4 | Server home (direction A with B's widgets) and the plain-words sweep. Spec: `docs/server-home-spec.md` | `feat/server-home`, `feat/plain-words` | merged. Follow-ups: speaking rings need real audio to show; weekly XP window on the economy API; the Sports add-on's `show_on_server_page` is now unused |
| 3 | Feeds / add-on framework: Sports becomes one add-on of many (RSS, YouTube, GitHub, Twitch, Jellyfin, game-server status) | — | after the Sports session lands |
| 2 | Together: watch together, listen together, soundboard, daily game, now playing | — | wave 2 |
| — | Motion pass across the app | — | after 4 |

Each workstream brief is in `~/Documents/Paracord-wt/briefs/`. Shared agent tooling
is in `~/Documents/Paracord-wt/tools/`:

- `pc-cargo.sh` and `pc-node.sh`: builds under a machine-wide lock.
- `pc-lab.sh`: a seeded lab per worktree (debug server plus Vite).
- `pc-shot.mjs`: signed-in screenshots.

Migration prefixes are reserved per workstream so branches merge cleanly:

- search: `20260923000001`
- actions: `20260923000101`
- assets: `20260923000201`
- default theme (main): `20260923000301`

## Log

- 2026-09-22 (evening): wave 1 and the server home are merged into `feat/program` with the Slate default and plain words. The full gate is green: fmt, clippy, every workspace test, 2,993 client tests, tsc, the colour lint and the contrast audit. `main` is untouched until the Sports session commits.

- 2026-09-22: branches merge into an integration branch first, not straight into `main`. `main` has another session's uncommitted Sports work in files these branches also touch (`paracord-api/src/lib.rs`, `routes/mod.rs`).

- 2026-09-22: the default look is now **Slate** (cool charcoal, author-coloured bubbles, amber) instead of the purple "voices" look, which read as AI-generated. The purple look stays as "Aubergine". Stored `voices` settings migrate to `slate`. Comparison: https://claude.ai/artifact/DVLoZVSoyuJN23tAso36Ne

- 2026-09-22: server home direction chosen: A with B's widgets (mock-ups https://claude.ai/artifact/L3DeqnGyQQGAo6rqtz5T3h).
- 2026-09-22: program agreed. Wave 1 (1a, 1b, 1c) started in worktrees.
  `scripts/seed-demo-community.py` was fixed: it sent `parent_id` as an integer,
  and the API rejects that.
