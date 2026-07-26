# README screenshots

Captured: 2026-07-26, against the v2.0.0 client and server.

Source: a local Paracord instance seeded with a fixture community, driven
through the product's own REST API and UI. Everyone visible in these images held
a real signed-in session at capture time, and the people shown inside voice
rooms had actually joined those rooms. Nothing was written directly into the
database or retouched afterwards.

Viewport: 1440×900 at 2× device scale, downscaled to 1760px wide.

Theme: Dark with the default emerald accent.

Fixture space: `Emerald Commons` — 10 members, 15 channels, 5 roles.

## Files

- `home.jpg` — Home: live rooms, the space you were last in, and channels to pick back up.
- `rooms.jpg` — a space opening on its rooms, two of them occupied.
- `messaging.jpg` — a text channel with replies, reactions, inline code, and an open poll.
- `members.jpg` — the same channel with the Members panel open, grouped by role.
- `engineering.jpg` — a syntax-highlighted code block and the thread branching off it.
- `command-palette.jpg` — the command palette (Ctrl/⌘ + K).
- `appearance.jpg` — Appearance settings: themes, accent colors, and message density.
- `space-settings.jpg` — the space administration overview.

The screenshots contain only local fixture data. No production account, server,
token, invite, or message content appears in them.

## Regenerating

`scripts/capture-readme-screenshots.mjs` drives the capture against a running
instance. Point it at a populated space — a fresh instance yields empty-state
screenshots that do not represent the product.
