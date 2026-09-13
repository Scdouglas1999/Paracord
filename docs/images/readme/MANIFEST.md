# README screenshots

Captured: 2026-09-13, against the v2.0.0 client and server on the "Lantern
Stage" design (`docs/lantern-stage-spec.md`).

Source: a local Paracord instance seeded with a fixture community, driven
through the product's own REST API and UI. Everyone visible in these images held
a real signed-in session at capture time, and the people shown inside voice
rooms had actually joined those rooms. Nothing was written directly into the
database or retouched afterwards. The room durations on the lobby cards are real
elapsed time, watched from the same page that took the shot — the client counts
from when it first saw a room lit and refuses to guess earlier.

Viewport: 1440×900 at 2× device scale, downscaled to 1760px wide.

Theme: Night (the default) with the emerald accent.

Fixture building: `Lantern Works` — 10 members, 15 rooms, 5 roles.

## Files

- `home.jpg` — Home: the buildings you belong to, which of their rooms are lit, what is coming up, and the work waiting on you.
- `lobby.jpg` — a building's lobby: two rooms lit with the people in them, one dark, and an event coming up.
- `messaging.jpg` — a text room with replies, reactions, inline code, and an open poll.
- `people.jpg` — the header's people sheet: who is reading, who is in a room, and who is simply around. The only full list of people in the product.
- `engineering.jpg` — a syntax-highlighted code block and the thread branching off it.
- `command-palette.jpg` — the command palette (Ctrl/⌘ + K).
- `appearance.jpg` — Appearance settings: Night, Daylight, AMOLED and high-contrast themes, accent colours, and message density.
- `space-settings.jpg` — the building's administration overview.

The screenshots contain only local fixture data. No production account, server,
token, invite, or message content appears in them.

## Regenerating

```bash
# 1. A throwaway instance, bootstrapped without a first-owner claim so the
#    seeder's first registration owns it.
PARACORD_SETUP_REQUIRE_CLAIM=false target/release/paracord-server

# 2. The fixture community, over the public REST API.
python3 scripts/seed-demo-community.py

# 3. The shots. Nine real sessions are held open for the run: four people in
#    browsers, five inside voice rooms over the same realtime handshake the
#    client performs.
NODE_TLS_REJECT_UNAUTHORIZED=0 PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
  node scripts/capture-readme-screenshots.mjs
```

`PARACORD_BASE`, `PARACORD_DEMO_OUT` and `PARACORD_SHOTS_OUT` move each step off
its defaults; `PARACORD_SHOTS_DWELL_MS` is how long the lobby watches the rooms
before the first frame.

Point it at a populated building — a fresh instance yields empty-state
screenshots that do not represent the product. The script writes 2× PNGs;
downscale to 1760px wide and re-encode as JPEG (quality ~86) before committing.
