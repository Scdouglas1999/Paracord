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
| 1a | Search across a server: filter chips (`from:` `in:` `has:` `before:`), grouped results | `feat/search` | merged. Round-2 carry-overs done (times, plain-text snippets) |
| 1b | Who reacted, Remind me (+ Reminders inbox), Forward, role mentions | `feat/actions` | merged. Round 2: DM-to-DM forward attribution now inside the encrypted body; React menu position fixed |
| 1c | User and server banners, sticker management, media gallery (Media / Files / Links) | `feat/assets` | merged. Old data-URL hub banners are converted at startup. Round 2: DM gallery built on-device; avatar cache fixed |
| 4 | Server home (direction A with B's widgets) and the plain-words sweep. Spec: `docs/server-home-spec.md` | `feat/server-home`, `feat/plain-words` | merged. Round 2: speaking rings verified with real audio and relayed to people outside the call; weekly XP window; `show_on_server_page` gates live games |
| 3 | Add-ons hub; Feeds (RSS/Atom, YouTube, GitHub, Twitch, Jellyfin) with front-page grouping; Game servers (Minecraft Java/Bedrock, A2S, TCP) | `feat/feeds`, `feat/game-servers` | merged (round 2). Follow-ups: Twitch and real Jellyfin untested live; batch Twitch checks; push game-server status over the gateway; Minecraft SRV records |
| 2 | Together: watch/listen together, soundboard, Daily word, now playing, speaking signal outside calls | `feat/together`, `feat/soundboard`, `feat/daily-word`, `feat/now-playing`, `feat/speaking-signal` | merged (round 2). Follow-ups: Together in DM calls; macOS now playing (no public API); Watch together from a feed card's actions slot |
| — | Motion pass across the app | `feat/motion-pass` | merged (round 2): one token set, exits, transform/opacity only, motion lint |

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

- 2026-09-24: round 2 ("fix all known issues and next steps"). Merged on `feat/program`: pillars 2 and 3, the motion pass, the round-1 carry-overs (search snippets and times, React menu position, avatar cache, weekly XP window, Sports show_on_server_page), encrypted forward attribution and the DM media panel, release infrastructure (flaky tests fixed at the root, Pebble ACME smoke, Windows install smoke, updater key and manifest), the AppImage libwayland fix, and an American-English sweep. Migration prefixes used: `20260924000001` feeds, `…101` together (none), `…201` soundboard, `…301` daily word, `…501` weekly XP, `…801` game servers.

- 2026-09-22 (evening): wave 1 and the server home are merged into `feat/program` with the Slate default and plain words. The full gate is green: fmt, clippy, every workspace test, 2,993 client tests, tsc, the color lint and the contrast audit. `main` is untouched until the Sports session commits.

- 2026-09-22: branches merge into an integration branch first, not straight into `main`. `main` has another session's uncommitted Sports work in files these branches also touch (`paracord-api/src/lib.rs`, `routes/mod.rs`).

- 2026-09-22: the default look is now **Slate** (cool charcoal, author-colored bubbles, amber) instead of the purple "voices" look, which read as AI-generated. The purple look stays as "Aubergine". Stored `voices` settings migrate to `slate`. Comparison: https://claude.ai/artifact/DVLoZVSoyuJN23tAso36Ne

- 2026-09-22: server home direction chosen: A with B's widgets (mock-ups https://claude.ai/artifact/L3DeqnGyQQGAo6rqtz5T3h).
- 2026-09-22: program agreed. Wave 1 (1a, 1b, 1c) started in worktrees.
  `scripts/seed-demo-community.py` was fixed: it sent `parent_id` as an integer,
  and the API rejects that.
