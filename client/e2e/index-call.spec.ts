import { expect, test, type Page } from '@playwright/test';
import {
  CH,
  CLOCK,
  PEOPLE,
  backToChat,
  callView,
  cardOpenCall,
  defineStep,
  frames,
  installIndexScene,
  navigate,
  openCall,
  outDir,
  roomCard,
  shoot,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-13 (Call view): docs/index-spec.md §7, §5.8, §5.9; docs/design/index-plan.md §3 IX-13.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-call PARACORD_E2E_INDEX_PORT=4613 \
 *   PARACORD_E2E_INDEX_RT_PORT=4615 PARACORD_E2E_INDEX_WP=ix13 \
 *     npx playwright test -c e2e/index-review.config.ts
 *   node e2e/index-compare.mjs ix13
 *
 * Shoots s3-call-open at 1280x800 (held against ref/s3-call-open.png) and at
 * 1440x900, 900x700 and 390x844, plus the states the prototype never drew:
 * theater, the chat column, a stream in focus with its filmstrip (the DEV
 * fixture paints Vincent's screen), a camera in the grid and in focus, and the
 * watching-without-joining controls. Every move is asserted by id
 * (`ix-call:*`), transform and opacity only, and nothing of the call view runs
 * two seconds after it settles.
 */

const MOTION_GONE_MS = 2_000;

/** Every Web Animation the page starts is remembered with its keyframes. */
async function recordAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const played: Array<{ id: string; keyframes: Keyframe[]; duration: number; easing: string }> = [];
    (window as unknown as { __ixPlayed: typeof played }).__ixPlayed = played;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = animate.apply(this, args);
      const options = typeof args[1] === 'number' ? { duration: args[1] } : (args[1] ?? {});
      queueMicrotask(() =>
        played.push({
          id: animation.id,
          keyframes: (Array.isArray(args[0]) ? args[0] : []) as Keyframe[],
          duration: Number((options as KeyframeAnimationOptions).duration ?? 0),
          easing: String((options as KeyframeAnimationOptions).easing ?? ''),
        }),
      );
      return animation;
    };
  });
}

type Played = { id: string; keyframes: Keyframe[]; duration: number; easing: string };
const played = (page: Page): Promise<Played[]> =>
  page.evaluate(() => (window as unknown as { __ixPlayed: Played[] }).__ixPlayed.filter((entry) => entry.id.startsWith('ix-call:')));
const forget = (page: Page) => page.evaluate(() => void ((window as unknown as { __ixPlayed: unknown[] }).__ixPlayed.length = 0));
const callRunning = (page: Page) =>
  page.evaluate(() => document.getAnimations().filter((animation) => animation.id.startsWith('ix-call:')).length);

async function callSettles(page: Page): Promise<void> {
  await expect.poll(() => callRunning(page), { timeout: 5_000 }).toBe(0);
}

/** Only transform and opacity move (and the keyframe bookkeeping). */
function onlyTransformAndOpacity(entries: Played[]): void {
  const props = new Set(entries.flatMap((entry) => entry.keyframes.flatMap((frame) => Object.keys(frame))));
  for (const prop of props) expect(['transform', 'transformOrigin', 'opacity', 'offset', 'easing', 'composite']).toContain(prop);
}

const stage = (page: Page) =>
  page.evaluate(async () => {
    const glass = (await import('/src/stores/glassStore.ts' as string)) as any;
    return glass.useGlassStore.getState().stage as { mode: string; chat: boolean; channelId: string | null; streamerId: string | null };
  });

/** Brendan turns his camera on in Fuel's General (the fixture engine paints a camera for him). */
const brendanCamera = defineStep('brendanCamera', async ({ world, emit }) => {
  world.joinVoice('brendan', 'fuelRoomGeneral', { joined_at: '2026-10-01T21:58:10-05:00', self_video: true });
  await emit(frames.voiceState(world, 'brendan', 'fuelRoomGeneral'));
});

async function joinedInFuel(page: Page): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await recordAnimations(page);
  const h = await installIndexScene(page);
  await h.open(h.routes.channel('fuelGeneral'));
  await h.step('arrive');
  await h.step('join');
  await expect(roomCard(page, 'yours')).toBeVisible();
  await page.waitForTimeout(900);
  await h.setClock(CLOCK.call);
  return h;
}

test.describe('IX-13 call view', () => {
  test('s3: Open call grows the call out of the card; Back to chat returns it', async ({ page }) => {
    await joinedInFuel(page);
    const card = roomCard(page, 'yours');
    const cardBox = (await card.boundingBox())!;

    await forget(page);
    await openCall(page);
    const view = callView(page);
    await expect(view).toHaveAccessibleName('Call: General');
    await expect(cardOpenCall(card)).toHaveAccessibleName('Back to chat');

    // §5.8: from the card's rect, translate + non-uniform scale, .3 -> 1, 600ms spring; the content fades from 40%.
    const open = await played(page);
    expect(open.map((entry) => entry.id)).toEqual(expect.arrayContaining(['ix-call:open', 'ix-call:open-content']));
    const grow = open.find((entry) => entry.id === 'ix-call:open')!;
    expect(grow.duration).toBe(600);
    expect(grow.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(grow.keyframes[0].opacity).toBe(0.3);
    await callSettles(page);
    const viewBox = (await view.boundingBox())!;
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)/.exec(String(grow.keyframes[0].transform));
    expect(match).not.toBeNull();
    const [, dx, dy, sx, sy] = match!.map(Number);
    expect(Math.abs(viewBox.x + dx - cardBox.x)).toBeLessThan(2);
    expect(Math.abs(viewBox.y + dy - cardBox.y)).toBeLessThan(2);
    expect(Math.abs(viewBox.width * sx - cardBox.width)).toBeLessThan(2);
    expect(Math.abs(viewBox.height * sy - cardBox.height)).toBeLessThan(2);
    onlyTransformAndOpacity(open);

    // The prototype's s3: header, two tall tiles (Jeremy talking), the joined controls.
    await expect(view.locator('.ix-call-head__name')).toHaveText('General');
    await expect(view.locator('.ix-call-head__place')).toHaveText('Fuel');
    await expect(view.locator('.ix-call-grid .ix-call-tile__who')).toHaveText(['Jeremy', 'You']);
    await expect(view.locator(`.ix-call-tile[data-user-id="${PEOPLE.jeremy.id}"]`)).toHaveAttribute('data-talking', 'true');
    await expect(view.getByRole('group', { name: 'Call controls' }).getByRole('button')).toHaveCount(5);
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    // The surface is at inset 10 over main.
    expect(viewBox.x).toBeCloseTo(326, 0);
    expect(viewBox.y).toBeCloseTo(10, 0);
    expect(viewBox.width).toBeCloseTo(944, 0);
    expect(viewBox.height).toBeCloseTo(780, 0);

    await page.waitForTimeout(MOTION_GONE_MS);
    expect(await callRunning(page)).toBe(0);
    await shoot(page, 's3-call-open');
    for (const size of ['desktop', 'narrow', 'phone'] as const) await shoot(page, 's3-call-open', { size });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(600);

    // Back to chat: the view goes at once (its video with it); a still copy shrinks into the card.
    await forget(page);
    await backToChat(page);
    const close = await played(page);
    expect(close.map((entry) => entry.id)).toEqual(expect.arrayContaining(['ix-call:close', 'ix-call:close-content']));
    expect(close.find((entry) => entry.id === 'ix-call:close')!.duration).toBe(450);
    onlyTransformAndOpacity(close);
    await expect(page.locator('.ix-call-ghost')).toHaveCount(0, { timeout: 3_000 });
    await expect(cardOpenCall(card)).toHaveAccessibleName('Open call');
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
    expect((await stage(page)).mode).toBe('none');
    await page.waitForTimeout(MOTION_GONE_MS);
    expect(await callRunning(page)).toBe(0);
  });

  test('theater (T) covers the window; H opens the chat column; Esc steps back, then closes', async ({ page }) => {
    await joinedInFuel(page);
    await openCall(page);
    await callSettles(page);
    const view = callView(page);

    await forget(page);
    await page.keyboard.press('t');
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-stage', 'theater');
    const flip = await played(page);
    expect(flip.map((entry) => entry.id)).toEqual(expect.arrayContaining(['ix-call:theater']));
    expect(flip.find((entry) => entry.id === 'ix-call:theater')!.duration).toBe(600);
    onlyTransformAndOpacity(flip);
    await callSettles(page);
    const theaterBox = (await view.boundingBox())!;
    expect(theaterBox.x).toBeCloseTo(10, 0);
    expect(theaterBox.width).toBeCloseTo(1260, 0);
    await expect(page.locator('nav.ix-side')).toHaveAttribute('inert', '');
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-theater');

    await page.keyboard.press('h');
    const chat = view.getByRole('complementary', { name: 'Chat in General' });
    await expect(chat).toBeVisible();
    const chatBox = (await chat.boundingBox())!;
    expect(chatBox.width).toBeCloseTo(360, 0);
    await expect(view.getByTestId('ix-call-chat')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-theater-chat');

    await page.keyboard.press('Escape');
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-stage', 'main');
    await callSettles(page);
    // The chat column stays where it was.
    await expect(chat).toBeVisible();
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-chat');
    // Typing in the chat column keeps every letter (T does nothing there).
    await chat.getByRole('textbox').first().click();
    await page.keyboard.type('tt');
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-stage', 'main');
    await page.locator('.ix-call-head__name').click();

    await page.keyboard.press('Escape');
    await expect(callView(page)).toHaveCount(0);
    expect((await stage(page)).mode).toBe('none');
  });

  test('Watch Vincent from Game Night: the stream in focus above the filmstrip, Clip and Join, without joining', async ({ page }) => {
    const h = await joinedInFuel(page);
    await h.setClock(CLOCK.visit);
    await navigate(page, h.routes.channel('gnLounge'));
    const lounge = roomCard(page, 'streaming');
    await expect(lounge.getByTestId('ix-card-watch')).toHaveText('Watch Vincent');
    await page.waitForTimeout(900);

    await forget(page);
    await lounge.getByTestId('ix-card-watch').click();
    const view = callView(page);
    await expect(view).toHaveAccessibleName('Call: Lounge');
    // It grows out of the Lounge card too.
    expect((await played(page)).map((entry) => entry.id)).toContain('ix-call:open');
    await expect(view).toHaveAttribute('data-focus', 'stream');
    await expect(view.locator('.ix-call-head__place')).toHaveText('Game Night');
    const stream = view.locator('.ix-call-stream');
    await expect(stream).toHaveAttribute('data-picture', 'true', { timeout: 10_000 });
    await expect(view.locator('.ix-call-strip .ix-call-tile')).toHaveCount(3);
    const controls = view.getByRole('group', { name: 'Call controls' });
    await expect(controls.getByRole('button')).toHaveText(['Clip', 'Join']);
    expect(await stage(page)).toMatchObject({ channelId: CH.gnRoomLounge, streamerId: PEOPLE.vincent.id });
    await callSettles(page);
    // 16:9 at radius 20 above the 112px filmstrip.
    const streamBox = (await stream.boundingBox())!;
    expect(streamBox.width / streamBox.height).toBeCloseTo(16 / 9, 1);
    const stripBox = (await view.locator('.ix-call-strip').boundingBox())!;
    expect(stripBox.height).toBeCloseTo(112, 0);
    expect(stripBox.y).toBeGreaterThanOrEqual(streamBox.y + streamBox.height);
    await callSettles(page);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-stream');

    // The overlay on hover: whose screen, sound and quality, Show everyone.
    await stream.hover();
    await expect(view.locator('.ix-call-stream__overlay')).toHaveCSS('opacity', '1');
    await expect(view.locator('.ix-call-stream__who')).toHaveText("Vincent's screen");
    await page.waitForTimeout(400);
    await view.locator('.ix-call-stream').screenshot({ path: `${outDir()}/call-stream-overlay.png` });

    await page.keyboard.press('t');
    await callSettles(page);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-stream-theater');
    await page.keyboard.press('Escape');
    await callSettles(page);

    // Closing stops watching; the call in Fuel goes on.
    await page.keyboard.press('Escape');
    await expect(callView(page)).toHaveCount(0);
    expect(
      await page.evaluate(async () => {
        const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
        const state = voice.useVoiceStore.getState();
        return { watching: state.watchView !== null, connected: state.connected, channel: state.channelId };
      }),
    ).toEqual({ watching: false, connected: true, channel: CH.fuelRoomGeneral });
  });

  test('a camera: a 16:9 grid with live video; a click focuses it above the filmstrip', async ({ page }) => {
    const h = await joinedInFuel(page);
    await h.step('crowd');
    await h.step(brendanCamera);
    await openCall(page);
    const view = callView(page);
    await callSettles(page);
    await expect(view.locator('.ix-call-grid')).toHaveAttribute('data-sized', 'true');
    const camera = view.locator(`.ix-call-tile[data-user-id="${PEOPLE.brendan.id}"]`);
    await expect(camera).toHaveAttribute('data-picture', 'true', { timeout: 10_000 });
    const tileBox = (await camera.boundingBox())!;
    expect(tileBox.width / tileBox.height).toBeCloseTo(16 / 9, 1);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-camera-grid');

    await camera.getByRole('button', { name: "Focus Brendan's camera" }).click();
    await expect(view).toHaveAttribute('data-focus', 'camera');
    await expect(view.locator('.ix-call-strip .ix-call-tile')).toHaveCount(4);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 'call-camera-focus');

    // Closing unsubscribes the camera (the fixture engine stops painting it).
    await backToChat(page);
    await expect(page.locator('.ix-call-tile')).toHaveCount(0);
  });
});
