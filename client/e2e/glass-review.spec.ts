import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fakeLoungeMedia, type SceneCall } from './fixtures/glass/calls';
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
 * Every state is reached the way a person reaches it (a click on the pill, a
 * key on the stage), with what a relay would do put into the stores from the
 * page (`fixtures/glass/calls.ts`): the watch paints the DEV fixture stream and
 * the call paints Brendan's fixture camera. The live scene
 * (`scripts/glass-scene.mjs --shot all`) shoots the same seven states on a real
 * instance with real media.
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
  /** Scene text that must be on screen. */
  expectText?: RegExp[];
  /** Nobody in the Lounge. */
  quiet?: boolean;
  /** The call this client holds (and the watch fakes), put in before driving. */
  call?: SceneCall | 'none';
  /** Extra driving once the route has loaded (a click, a key). */
  drive?: (page: Page, viewport: keyof typeof VIEWPORTS) => Promise<void>;
}

const pill = (page: Page) => page.getByRole('main').getByRole('region', { name: /live voice channel/ });
const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

/** The pill's Watch: the stage opens on Vincent's screen and the fixture paints it. */
async function watchVincent(page: Page) {
  await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
}

const STATES: GlassState[] = [
  {
    name: '01-conversation',
    // Game Night, General: unread with a mention, the Lounge live above it.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    expectText: [/what are we playing tonight/, /haz 5 run/i, /new personal best btw/, /still on\? I'm bringing the projector/],
  },
  {
    name: '02-quiet',
    // Basecamp, Trips: the cool server, with Game Night's Lounge live elsewhere.
    route: channelRoute(BASECAMP_ID, CH.trips),
    expectText: [/permits came through for Saturday/, /rim trail, north lot at 7/, /28° at the trailhead/],
  },
  {
    name: '03-listen',
    // Listening in, the pill grown to show who is there.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    call: { mode: 'listen' },
    drive: async (page) => {
      await expect(pill(page).getByRole('button', { name: 'Stop listening in to Lounge' })).toBeVisible();
      await pill(page).getByRole('button', { name: "Show who's in Lounge" }).click();
      await expect(pill(page).getByText("Everyone in Lounge can see you're listening in.")).toBeVisible();
    },
  },
  {
    name: '04-side-by-side',
    // Joined, watching Vincent beside the conversation.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    call: { mode: 'joined', watchers: 2 },
    drive: async (page) => {
      await watchVincent(page);
    },
  },
  {
    name: '05-theater',
    // Theater: the stream fills the window (T); on a phone, full screen.
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    call: { mode: 'joined', watchers: 2 },
    drive: async (page, viewport) => {
      await watchVincent(page);
      if (viewport === 'phone') await page.getByRole('button', { name: 'Full screen' }).click();
      else await page.keyboard.press('t');
      await expect(page.locator('.glass-frame')).toHaveAttribute('data-stage', 'theater');
    },
  },
  {
    name: '06-browse',
    // Watching (not joined) while browsing: from Clips, Watch, then S.
    route: channelRoute(GAME_NIGHT_ID, CH.clips),
    call: 'none',
    drive: async (page, viewport) => {
      await watchVincent(page);
      if (viewport === 'desktop') {
        await page.keyboard.press('s');
        await expect(page.locator('.glass-frame__places')).toBeVisible();
      }
    },
  },
  {
    name: '07-phone',
    // The conversation with the pill and the stream above it (not joined).
    route: channelRoute(GAME_NIGHT_ID, CH.general),
    expectText: [/still on\? I'm bringing the projector/, /new personal best btw/],
    call: 'none',
    drive: async (page) => {
      await watchVincent(page);
    },
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
      if (state.call) await fakeLoungeMedia(page, state.call === 'none' ? {} : state.call);
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
