# WP-G2 checkpoint: mocked review harness

Renders the Glass reference scene against mocked backend data, so later packages
can screenshot their surfaces with no server and no media stack.

## How to run

```bash
cd client
PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g9 npx playwright test e2e/glass-review.spec.ts
```

Output: `output/design-reference/glass-build/<PARACORD_E2E_GLASS_WP or latest>/<state>-{desktop,phone}.png`
at 1440x900 and 390x844, plus `fixture-frame-{stream,camera,camera-warm}.png`.
About 45 seconds for all 15 tests. The project is gated by `PARACORD_E2E_GLASS=1`
in `playwright.config.ts`; without it the default projects are unchanged
(`npx playwright test --list` still reports the same 92 tests in 9 files).

Regenerate the committed PNG fixtures with `node e2e/fixtures/glass/generate-images.mjs`.

## What is mocked

- All `/api/v1` REST (same catch-all pattern as `design-review.spec.ts`, plus
  per-channel messages newest first, the recovery feed, members, events,
  read states, attachments, banner).
- The gateway: `window.EventSource` replaced by a persistent stub that replays
  one READY (guilds, channels, voice states with `speaking`, presences) and an
  Eric `TYPING_START` on a 3 second beat.
- The clock: `page.clock.setFixedTime` to Thursday 1 Oct 2026 9:12 PM CDT and
  `timezoneId: America/Chicago`, so "Today", "Fri", "Tue" and every time label
  are identical on any machine on any day. Timers still run.

Scene (`e2e/fixtures/glass/scene.ts`): Game Night (General, Lounge live with
Vincent streaming, Brendan on camera and talking, Nick muted; Clips, LFG with a
poll, quiet Patch notes; events Haz 5 run tonight 9:30 in Lounge and Movie night
Fri 9 PM hosted by Sean) and Basecamp (Trips, General, Photos, Gear, banner PNG,
event Rim trail hike Sat 7 AM). Cast: Sean (self), Vincent, Brendan, Nick,
Jeremy, Luke, Eric. Avatars are initials (`avatar_hash: null`). The reference
messages are verbatim; Nick's image is a generated 41:07 mission screen.
Read states: General read to 8:58 with one mention (6 messages after it), Clips
and Trips read to before their first message, everything else fully read.

## States and what each shows today (pre-Glass UI)

| State | Route | Shows now | Filled by |
|---|---|---|---|
| 01-conversation | Game Night / General | Lantern conversation: all six new messages, reactions, 41:07 image, Eric typing, mention badge, Lounge people | G7, G9, G10, G11, G12, G13 |
| 02-quiet | Basecamp / Trips | Trips conversation; Game Night Lounge live in the rail | G8, G9, G12 |
| 03-listen | Game Night / General | Same as 01 (no Listen control yet) | G6, G12 (drive: click pill Listen) |
| 04-side-by-side | Game Night / Lounge | Voice channel page: Vincent (Watch), Brendan (camera), Nick (muted), Join voice | G14, G16, G17, G13 |
| 05-theater | Game Night / Lounge | Same as 04 | G15 |
| 06-browse | Game Night / Clips | Clips channel (nothing to browse over yet) | G15 |
| 07-phone | Game Night / General | Same route as 01 at both sizes; on phone the Lantern mobile bottom nav | G20 |

Every state is shot at both sizes (07-phone included at desktop) so the naming
is uniform. Read `01-conversation-desktop.png` and `07-phone-phone.png`: server
names, channels (General, Lounge, Clips, LFG, Patch notes, Trips, Basecamp
channels), all five reference speakers' messages, reactions, the 41:07 image,
the @Sean mention and Eric's typing indicator are present.

## Frame source (DEV only)

`client/src/lib/room/frameSource.ts` (the contract in glass-plan §1.2, which
says `subscribe(onFrame, hz)`; `getLatestFrame` and size added):

```ts
interface FrameSource {
  readonly kind: 'stream' | 'image' | 'fixture';
  readonly width: number;
  readonly height: number;
  subscribe(onFrame: (frame: ImageBitmap) => void, hz: number): () => void;
  getLatestFrame(): Promise<ImageBitmap | null>;
}
```

Each subscriber, and each `getLatestFrame()`, gets its own bitmap and owns it
(must `close()`), matching `RoomFrame` in `roomFrameTap.ts`.
`fixtureFrameSource.ts` exports `createFixtureFrameSource({ scene: 'stream' |
'camera' | 'camera-warm', width, height, freezeAtSeconds })`: a 12 second seamless
loop (cave, teal crystals, sweeping headlamp beam, motes; or a silhouette).
It throws unless `import.meta.env.DEV`, and a consumer must import it as
`import.meta.env.DEV ? () => import(...) : null`, the same fold-to-null used by
`StagePreviewPage` in `App.tsx`. Nothing imports it today, so it is absent from
production by construction.

Colors: no literals. Palette tokens (`--light-amber`, `--accent-primary`,
`--light-white`, `--bg-well`, `--window-dark`) are resolved through a probe
element, because a canvas cannot parse `oklch(... var(...))` from a raw custom
property. This means the file needs no `ALLOWED` entry in
`scripts/literal-color-audit.mjs` (that script is outside this package's scope,
and the `canvasRenderer.ts` precedent is an allowance there).

## Files

New: `client/e2e/glass-review.spec.ts`, `client/e2e/fixtures/glass/{scene.ts,install.ts,generate-images.mjs,mission-41-07.png,basecamp-banner.png,photo-ridge.png}`,
`client/src/lib/room/{frameSource.ts,fixtureFrameSource.ts}`, this doc.
Edited: `client/playwright.config.ts` (a `glass-review` project, gated).

## Commands

- `PARACORD_E2E_GLASS=1 npx playwright test e2e/glass-review.spec.ts`: pass (15/15)
- `npm run typecheck`: pass
- `npm run test:tokens`: pass
- `npm run lint`: 0 errors, 241 warnings (all pre-existing; none in these files)
- `npm run test:unit`: the full suite did not finish. The box was at load average 11+ with other agents running, and two full runs were killed (SIGTERM, exit 143) before the summary. This package adds no unit tests and nothing imports its new `src` files, so it cannot affect the suite. A subset (`src/lib/attention`, `src/lib/media`, the neighbors of the new files) passed: 36 files, 369 tests. Re-run the full suite on a quiet machine.
- `npx playwright test --list` (default projects): unchanged, 92 tests

## What is missing, honestly

- No numeric unread badges. `ReadState` carries only `last_message_id` and
  `mention_count`, so the "3" on Clips and "4" on Trips cannot be produced by
  data alone; G9 must define where the count comes from (loaded messages or a
  new server field). The read states are seeded so the unread is real.
- "6 new since 8:58" is 6 unread messages after the 8:58 read marker, but the
  divider itself is G10's.
- The Haz 5 run plan card is a plain Brendan message ("Haz 5 run: Tonight at 9:30
  PM in Lounge"), and "Lounge 3 in" and "Movie night Fri 9 PM" are plain text
  inside their messages; G13 draws them. The `@Sean` mention is `<@42>`.
- "8 online" and Basecamp "5 members" come from `member_count`; the member list
  is the seven cast members. Avatars are initials, not the reference's faces.
- States 03 to 06 are placeholders (route only); no click drives exist because
  the controls do not. Nothing exercises Listen, Watch or Join.
- The Basecamp banner is served but nothing in the current UI shows it.
- Nothing consumes the frame source yet. `getLatestFrame` is asynchronous
  (`createImageBitmap`), a deliberate choice; G8 owns the contract afterwards.
- `client/package.json` and `package-lock.json` show as modified in the
  worktree; that was not done by this package.
