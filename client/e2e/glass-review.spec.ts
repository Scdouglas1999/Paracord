import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { BASECAMP_ID, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * Glass review harness (docs/design/glass-plan.md WP-G2).
 *
 * Renders the Glass reference scene (`e2e/fixtures/glass`, from
 * `output/design-reference/glass/source/`) against mocked backend data, so a
 * package can screenshot its surface and hold it against the reference PNGs in
 * `output/design-reference/glass/screens/` with no server and no media stack.
 *
 *   cd client
 *   PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g9 npx playwright test e2e/glass-review.spec.ts
 *
 * Output: `output/design-reference/glass-build/<PARACORD_E2E_GLASS_WP | latest>/
 * <state>-{desktop,phone}.png`, at 1440x900 and 390x844 (gitignored).
 *
 * Every state is shot at BOTH sizes, including `07-phone` at desktop width, so
 * the naming is uniform and a package can diff either size against its own
 * reference.
 *
 * TODAY THESE SHOW THE PRE-GLASS UI. A state whose surface does not exist yet
 * navigates to the route where it will live and shoots whatever the app renders
 * there. Each such state names, in `pending`, the package that will make the
 * frame match the reference; when that package lands it changes the driver
 * (a click, a key, a store action) in this file, not the harness.
 */

const WP = process.env.PARACORD_E2E_GLASS_WP || 'latest';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

const channelRoute = (guild: string, channel: string) => `/app/guilds/${guild}/channels/${channel}`;

interface GlassState {
  /** Reference artboard: `output/design-reference/glass/screens/<name>.png`. */
  name: string;
  /** Where the app puts this state. */
  route: string;
  /** Scene text that must be on screen, on the pre-Glass UI as well. */
  expectText?: RegExp[];
  /** Nobody in the Lounge. */
  quiet?: boolean;
  /** Packages that make this frame match the reference. Empty when it already can. */
  pending?: string;
  /** Extra driving once the route has loaded (a click, a key). */
  drive?: (page: Page, viewport: keyof typeof VIEWPORTS) => Promise<void>;
}

const STATES: GlassState[] = [
  {
    name: '01-conversation',
    // Game Night, General: unread with a mention, the Lounge live above it.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    expectText: [/what are we playing tonight/, /haz 5 run/i, /new personal best btw/, /Movie night still on/],
    pending: 'G7 shell, G9 places, G10 conversation, G11 composer, G12 pill (compact), G13 cards',
  },
  {
    name: '02-quiet',
    // Basecamp, Trips: the cool server, with Game Night's Lounge live elsewhere.
    route: channelRoute(BASECAMP_ID, CH.trips),
    expectText: [/permits came through for Saturday/, /rim trail, north lot at 7/, /28° at the trailhead/],
    pending: 'G8 (cool temperature, banner), G9 (quiet rows), G12 (cross-server pill name)',
  },
  {
    name: '03-listen',
    // The pill expanded with "Listening". Today: General with the Lounge live.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    pending: 'G6 (listen()) and G12 (expanded pill, Listening): drive by clicking the pill Listen button',
  },
  {
    name: '04-side-by-side',
    // Joined: the stage beside the conversation. Today: the Lounge voice channel.
    route: channelRoute(GAME_NIGHT_ID, CH.lounge),
    pending: 'G14 (joined stage), G16 (clip toast), G17 (reactions), G13 (narrow plan card)',
  },
  {
    name: '05-theater',
    // Theater: the stream fills the pane. Today: the Lounge voice channel.
    route: channelRoute(GAME_NIGHT_ID, CH.lounge),
    pending: 'G15 (theater, surfacing messages, mention edge)',
  },
  {
    name: '06-browse',
    // Watching while browsing another channel. Today: Clips, the channel you browse to.
    route: channelRoute(GAME_NIGHT_ID, CH.clips),
    pending: 'G15 (browse, not-joined controls)',
  },
  {
    name: '07-phone',
    // The phone conversation with the pill and stream above it.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    expectText: [/Movie night still on/, /new personal best btw/],
    pending: 'G20 and every component’s phone variant',
  },
];

async function shoot(page: Page, name: string, viewport: keyof typeof VIEWPORTS) {
  // Park the pointer somewhere inert: a hover left over a control opens its
  // tooltip, and a frame under review should show the surface.
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await page.evaluate(() => document.fonts.ready);
  // `networkidle` is no use: the app holds a realtime stream for its whole life.
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-${viewport}.png`), fullPage: false });
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

for (const state of STATES) {
  for (const viewport of ['desktop', 'phone'] as const) {
    test(`${state.name} at ${viewport}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize(VIEWPORTS[viewport]);
      await installGlassScene(page, { quiet: state.quiet });
      await page.goto(state.route);
      await expect(page.getByRole('main')).toBeVisible();
      for (const text of state.expectText ?? []) {
        await expect(page.getByText(text).first()).toBeVisible();
      }
      await state.drive?.(page, viewport);
      await shoot(page, state.name, viewport);
    });
  }
}

/**
 * The DEV fixture frame source, exercised in a real page (a canvas is not
 * available under jsdom). It is imported through Vite's dev server exactly as a
 * DEV-gated consumer would, and shot as a stream and as a camera so a package
 * can see the palette it will get.
 */
test('the fixture frame source draws stream and camera frames', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(VIEWPORTS.desktop);
  await installGlassScene(page);
  await page.goto(channelRoute(GAME_NIGHT_ID, CH.general));
  await expect(page.getByRole('main')).toBeVisible();

  const result = await page.evaluate(async () => {
    // A computed specifier keeps the type checker out of the browser's module graph.
    const modulePath = '/src/lib/room/fixtureFrameSource.ts';
    const { createFixtureFrameSource, FIXTURE_LOOP_SECONDS } = (await import(/* @vite-ignore */ modulePath)) as typeof import('../src/lib/room/fixtureFrameSource');
    const shots: Record<string, { png: string; distinctColors: number; delivered: number }> = {};
    for (const scene of ['stream', 'camera', 'camera-warm'] as const) {
      const source = createFixtureFrameSource({ scene });
      let delivered = 0;
      const stop = source.subscribe((frame) => {
        delivered += 1;
        frame.close();
      }, 20);
      const latest = await source.getLatestFrame();
      if (!latest) throw new Error(`no frame for ${scene}`);
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(latest, 0, 0);
      latest.close();
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 4 * 97) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      stop();
      shots[scene] = { png: canvas.toDataURL('image/png'), distinctColors: seen.size, delivered };
    }
    return { shots, loop: FIXTURE_LOOP_SECONDS };
  });

  expect(result.loop).toBeGreaterThan(0);
  for (const [scene, shot] of Object.entries(result.shots)) {
    // A blank or single-color canvas would mean the palette tokens did not resolve.
    expect(shot.distinctColors, `${scene} has real content`).toBeGreaterThan(20);
    expect(shot.delivered, `${scene} delivers frames to subscribers`).toBeGreaterThanOrEqual(2);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(OUT_DIR, `fixture-frame-${scene}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
  }
});
