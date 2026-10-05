import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CH,
  CLOCK,
  GUILD,
  PEOPLE,
  channelRow,
  composerInput,
  dockItem,
  frames,
  installIndexScene,
  outDir,
  roomCard,
  searchField,
  sidebar,
  toolbar,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-16 (Phone): docs/index-spec.md §9 at 390x844 (and 844x390 sideways), on
 * the Index scene, with the touch screen a phone has.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-phone PARACORD_E2E_INDEX_PORT=4643 \
 *   PARACORD_E2E_INDEX_RT_PORT=4645 PARACORD_E2E_INDEX_WP=ix16 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * The device's safe areas are an iPhone's (47 top, 34 bottom), set on the
 * tokens the app reads them from (`--safe-top`, `--safe-bottom`); Chromium has
 * no notch to report. Swipes and drags are real touch events (CDP), so the
 * gestures run their own code, not a shortcut.
 *
 * Shots: output/design-reference/index-build/<WP>/phone-*.png (the prototype
 * has no phone; they are held against the spec text and the desktop states'
 * tokens).
 */

const PHONE = { width: 390, height: 844 };
const SIDEWAYS = { width: 844, height: 390 };
const SAFE_TOP = 47;
const SAFE_BOTTOM = 34;

test.use({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

/* ---------------------------------------------------------------- helpers */

async function shot(page: Page, name: string, settle = 900): Promise<void> {
  const dir = outDir();
  await mkdir(dir, { recursive: true });
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/** An iPhone's safe areas, upright or on its side (the notch moves to a side). */
const safeAreas = (sideways: boolean) =>
  sideways
    ? 'html:root { --safe-top: 0px; --safe-bottom: 21px; --safe-left: 47px; --safe-right: 47px; }'
    : `html:root { --safe-top: ${SAFE_TOP}px; --safe-bottom: ${SAFE_BOTTOM}px; }`;

async function open(
  page: Page,
  route?: (h: IndexHarness) => string,
  options: { keyboard?: boolean; setup?: () => Promise<void> } = {},
): Promise<IndexHarness> {
  if (options.keyboard) await installFakeKeyboard(page);
  const h = await installIndexScene(page);
  // A spec's own routes go after the scene's: routes are last-wins.
  await options.setup?.();
  await h.open(route ? route(h) : h.routes.channel('fuelGeneral'));
  const sideways = (page.viewportSize()?.width ?? 0) > (page.viewportSize()?.height ?? 0);
  await page.addStyleTag({ content: safeAreas(sideways) });
  await expect(page.locator('.ix-frame')).toHaveAttribute('data-layout', 'phone');
  await expect(sidebar(page)).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  return h;
}

const frame = (page: Page) => page.locator('.ix-frame');
const screenOf = (page: Page) => frame(page).getAttribute('data-screen');
const main = (page: Page) => page.locator('main.ix-main');
const strip = (page: Page) => page.getByTestId('ix-call-strip');
const callSheet = (page: Page) => page.getByTestId('ix-call-sheet');

const rect = (locator: Locator) =>
  locator.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });

const transformOf = (locator: Locator) => locator.first().evaluate((el) => getComputedStyle(el).transform);

/** translateX in px from a computed `matrix(...)`. */
const shiftX = (matrix: string) => (matrix === 'none' ? 0 : Number(matrix.match(/matrix\(([^)]+)\)/)?.[1].split(',')[4] ?? 0));

/** Every animation in the document, by id. */
const running = (page: Page) => page.evaluate(() => document.getAnimations().map((a) => a.id || a.constructor.name));

async function nothingRunsAtRest(page: Page): Promise<void> {
  await page.waitForTimeout(2000);
  const left = (await running(page)).filter((id) => !id.startsWith('ix-wave') && id !== 'CSSAnimation');
  expect(left, 'no Index motion is left running at rest').toEqual([]);
}

async function backToRoot(page: Page): Promise<void> {
  await toolbar(page).getByRole('button', { name: 'Back to the sidebar' }).click();
  await expect.poll(() => screenOf(page)).toBe('places');
  await page.waitForTimeout(500);
}

let cdp: CDPSession | null = null;
async function touch(page: Page): Promise<CDPSession> {
  cdp ??= await page.context().newCDPSession(page);
  return cdp;
}
test.afterEach(() => {
  cdp = null;
});

/** A real finger: down at the first point, through the others `stepMs` apart, up at the last. */
async function drag(page: Page, points: Array<{ x: number; y: number }>, stepMs = 16, release = true): Promise<void> {
  const session = await touch(page);
  const [first, ...rest] = points;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y }] });
  for (const point of rest) {
    await page.waitForTimeout(stepMs);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y }] });
  }
  if (release) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const line = (from: { x: number; y: number }, to: { x: number; y: number }, steps: number) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));

/**
 * The on-screen keyboard: Chromium's emulation has none, so the visual viewport
 * is replaced by one the test can shrink (what iOS and Android do when the
 * keyboard opens: the layout viewport stays, the visual one shrinks).
 */
async function installFakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fake = new EventTarget() as EventTarget & Record<string, unknown>;
    let keyboard = 0;
    Object.defineProperties(fake, {
      width: { get: () => window.innerWidth },
      height: { get: () => window.innerHeight - keyboard },
      offsetTop: { get: () => 0 },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => 0 },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    (window as unknown as { __keyboard: (px: number) => void }).__keyboard = (px: number) => {
      keyboard = px;
      fake.dispatchEvent(new Event('resize'));
    };
  });
}

/* ----------------------------------------------------------------- the root */

test.describe('the phone (index-spec §9)', () => {
  test('the root is the sidebar, the dock a bottom bar over the safe area, your face at the header right', async ({ page }) => {
    await open(page);
    await backToRoot(page);
    const side = await rect(sidebar(page));
    expect(side).toMatchObject({ x: 0, y: 0, width: PHONE.width, height: PHONE.height });

    // The dock: 64 tall above the 34px home indicator area, on the sidebar's foot color, to the screen's foot.
    const dockHost = await rect(page.locator('.ix-side__dock'));
    expect(dockHost.bottom).toBeCloseTo(PHONE.height, 0);
    expect(dockHost.height).toBeCloseTo(64 + SAFE_BOTTOM, 0);
    expect((await rect(page.getByTestId('ix-dock'))).height).toBeCloseTo(64, 0);
    for (const item of await page.getByTestId('ix-dock-item').all()) {
      const box = await rect(item);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const indicator = await rect(page.getByTestId('ix-dock-indicator'));
    const fuel = await rect(dockItem(page, 'fuel'));
    expect(indicator.x + indicator.width / 2).toBeCloseTo(fuel.x + fuel.width / 2, 0);
    expect(indicator.y).toBeGreaterThan(fuel.y + fuel.height - 6);

    // The header: "…" then your face at the right, both 44px targets, under the status bar.
    const header = page.getByTestId('ix-sidebar-header');
    const more = await rect(header.getByRole('button', { name: 'Server options' }));
    const me = await rect(header.getByRole('button', { name: 'Your account' }));
    expect(me.x).toBeGreaterThan(more.x);
    expect(me.right).toBeGreaterThan(PHONE.width - 24);
    expect(me.width).toBe(44);
    expect(more.width).toBe(44);
    expect((await rect(header)).y).toBeGreaterThanOrEqual(SAFE_TOP);
    // No toolbar avatar on a phone: the face is the root's.
    await expect(toolbar(page).locator('.ix-toolbar__me')).toBeHidden();
    await shot(page, 'phone-root');

    // Your face opens the account menu, as an action sheet.
    await header.getByRole('button', { name: 'Your account' }).click();
    const menu = page.locator('.ix-menu--sheet');
    await expect(menu).toBeVisible();
    await shot(page, 'phone-account-menu', 700);
    await page.getByTestId('ix-menu-cancel').click();
    await expect(menu).toHaveCount(0);
  });

  test('a channel is pushed: from the right in 165ms on the spring, the root 30% left and dimmed beneath', async ({ page }) => {
    await open(page);
    await backToRoot(page);
    await page.evaluate(() => {
      (window as unknown as { __played: unknown[] }).__played = [];
      const original = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes, options) {
        const animation = original.call(this, keyframes, options);
        queueMicrotask(() => {
          if (!animation.id.startsWith('ix-phone')) return;
          (window as unknown as { __played: unknown[] }).__played.push({
            id: animation.id,
            keyframes,
            duration: typeof options === 'object' ? options?.duration : options,
            easing: typeof options === 'object' ? options?.easing : undefined,
          });
        });
        return animation;
      };
    });
    await channelRow(page, 'fuelClips').click();
    await expect.poll(() => screenOf(page)).toBe('conversation');
    const played = (await page.evaluate(() => (window as unknown as { __played: unknown[] }).__played)) as Array<{
      id: string;
      keyframes: Keyframe[];
      duration: number;
      easing: string;
    }>;
    const byId = Object.fromEntries(played.map((record) => [record.id, record]));
    expect(byId['ix-phone:top'].keyframes).toEqual([{ transform: 'translateX(100%)' }, { transform: 'none' }]);
    expect(byId['ix-phone:under'].keyframes).toEqual([{ transform: 'none' }, { transform: 'translateX(-30%)' }]);
    expect(byId['ix-phone:shade'].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    for (const record of played) {
      expect(record.duration).toBe(165);
      expect(record.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    }

    // At rest: main in front; the root (and its dock) 30% left, under its shade.
    await page.waitForTimeout(600);
    expect(shiftX(await transformOf(main(page)))).toBe(0);
    expect(shiftX(await transformOf(sidebar(page)))).toBeCloseTo(-0.3 * PHONE.width, 0);
    await expect(sidebar(page).locator('.ix-dock')).toBeAttached();
    expect(await sidebar(page).locator(':scope > .ix-phone-shade').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    // The page: a 52px toolbar under the status bar (back, search, members), a 30px large title.
    const bar = await rect(toolbar(page));
    expect(bar.height).toBeCloseTo(52 + SAFE_TOP, 0);
    for (const name of ['Back to the sidebar', 'Search messages', 'Members']) {
      const tool = await rect(toolbar(page).getByRole('button', { name }));
      expect(tool.width).toBeGreaterThanOrEqual(44);
      expect(tool.y + tool.height / 2).toBeCloseTo(SAFE_TOP + 26, 0);
    }
    expect(await page.getByTestId('ix-title').evaluate((el) => getComputedStyle(el).fontSize)).toBe('30px');
    // The message box sits above the home indicator.
    const box = await rect(page.getByTestId('ix-composer'));
    expect(box.bottom).toBeLessThanOrEqual(PHONE.height - SAFE_BOTTOM);
    await shot(page, 'phone-pushed');
    await nothingRunsAtRest(page);
  });

  test('the edge swipe drags the page with the finger, and finishes or springs back on release', async ({ page }) => {
    await open(page);
    expect(await screenOf(page)).toBe('conversation');

    // A slow, short swipe: the page follows, then springs back.
    await drag(page, line({ x: 6, y: 420 }, { x: 120, y: 424 }, 12), 24, false);
    const mid = shiftX(await transformOf(main(page)));
    expect(mid).toBeGreaterThan(90);
    expect(mid).toBeLessThan(130);
    // The root follows from -30% toward rest.
    const under = shiftX(await transformOf(sidebar(page)));
    expect(under).toBeGreaterThan(-0.3 * PHONE.width);
    expect(under).toBeLessThan(0);
    await shot(page, 'phone-swipe-mid', 0);
    await (await touch(page)).send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(700);
    expect(await screenOf(page)).toBe('conversation');
    expect(shiftX(await transformOf(main(page)))).toBe(0);

    // Past half way: the root comes in from where the finger let go.
    await drag(page, line({ x: 6, y: 420 }, { x: 260, y: 424 }, 14), 20);
    await expect.poll(() => screenOf(page)).toBe('places');
    await page.waitForTimeout(600);
    expect(shiftX(await transformOf(sidebar(page)))).toBe(0);
    expect(shiftX(await transformOf(main(page)))).toBeCloseTo(PHONE.width, 0);
    await nothingRunsAtRest(page);

    // A flick finishes even when it is short.
    await channelRow(page, 'fuelGeneral').click();
    await expect.poll(() => screenOf(page)).toBe('conversation');
    await page.waitForTimeout(600);
    await drag(page, line({ x: 6, y: 420 }, { x: 110, y: 420 }, 4), 8);
    await expect.poll(() => screenOf(page)).toBe('places');

    // A drag that turns vertical is a scroll, not a swipe.
    await channelRow(page, 'fuelGeneral').click();
    await page.waitForTimeout(600);
    await drag(page, line({ x: 6, y: 300 }, { x: 16, y: 520 }, 10), 16);
    await page.waitForTimeout(500);
    expect(await screenOf(page)).toBe('conversation');
  });

  /* ------------------------------------------------------------- calls */

  test('in a call, every pushed page carries the call strip; somebody calling uses it too', async ({ page }) => {
    const h = await open(page);
    await backToRoot(page);
    await h.step('arrive');
    await h.step('join');
    await expect(roomCard(page, 'yours')).toBeVisible();
    await channelRow(page, 'fuelClips').click();
    await expect.poll(() => screenOf(page)).toBe('conversation');
    await page.waitForTimeout(500);

    const bar = strip(page);
    await expect(bar).toHaveAttribute('data-state', 'yours');
    const box = await rect(bar);
    expect(box).toMatchObject({ x: 0, width: PHONE.width, height: 40 });
    expect(box.y).toBeCloseTo(SAFE_TOP + 52, 0);
    await expect(bar).toContainText('General');
    await expect(bar.locator('.ix-av')).toHaveCount(2);
    // Jeremy talks: the waveform.
    await expect(bar.locator('.ix-wave')).toHaveCount(1);
    // The page lays itself out under the toolbar and the strip.
    const title = await rect(page.getByTestId('ix-title'));
    expect(title.y).toBeGreaterThanOrEqual(box.bottom);
    await shot(page, 'phone-call-strip');

    // Your microphone, from the strip.
    const mic = bar.getByTestId('ix-call-strip-mic');
    const before = await mic.getAttribute('data-muted');
    await mic.click();
    await expect(mic).not.toHaveAttribute('data-muted', before ?? '');
    await mic.click();
    await expect(mic).toHaveAttribute('data-muted', before ?? 'false');

    // Somebody calls: the same strip says so, with Decline and Accept.
    h.world.joinVoice('maya', 'dmMaya');
    await h.emit(frames.voiceState(h.world, 'maya', 'dmMaya'));
    await expect(bar).toHaveAttribute('data-state', 'incoming');
    await expect(bar).toContainText('Maya is calling');
    await shot(page, 'phone-call-strip-incoming');
    await bar.getByTestId('ix-call-strip-decline').click();
    await expect(bar).toHaveAttribute('data-state', 'yours');
    // Declined here is declined on the root's pinned card too.
    await backToRoot(page);
    await expect(roomCard(page, 'incoming')).toHaveCount(0);
  });

  test('the call is a sheet: it rises out of the strip, one column for two, and a drag down dismisses it', async ({ page }) => {
    const h = await open(page);
    await backToRoot(page);
    await h.step('arrive');
    await h.step('join');
    await channelRow(page, 'fuelClips').click();
    await expect.poll(() => screenOf(page)).toBe('conversation');
    await page.waitForTimeout(500);
    const from = await rect(strip(page));

    await strip(page).getByRole('button', { name: /^Open call: General/ }).click();
    const sheet = callSheet(page);
    await expect(sheet).toBeVisible();
    // It grows out of the strip: the first frame is the strip's box.
    const first = await page.evaluate(() => {
      const open = document.getAnimations().find((a) => a.id === 'ix-call-sheet:open') as Animation | undefined;
      if (!open) return null;
      const keyframes = (open.effect as KeyframeEffect).getKeyframes();
      return { duration: (open.effect as KeyframeEffect).getTiming().duration, transform: keyframes[0].transform as string };
    });
    expect(first?.duration).toBe(190);
    const scaled = first?.transform.match(/scale\(([\d.]+), ([\d.]+)\)/);
    expect(Number(scaled?.[2])).toBeCloseTo(from.height / (PHONE.height - SAFE_TOP - 8), 1);
    await page.waitForTimeout(700);
    const box = await rect(sheet);
    expect(box).toMatchObject({ x: 0, width: PHONE.width });
    expect(box.y).toBeCloseTo(SAFE_TOP + 8, 0);
    expect(box.bottom).toBeCloseTo(PHONE.height, 0);
    expect(await sheet.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px');
    await expect(sheet.locator('.ix-call-sheet__handle')).toBeVisible();
    // Two people: one column. No chat column on a phone.
    const columns = await sheet.locator('.ix-call-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(1);
    await expect(sheet.getByTestId('ix-call-chat')).toHaveCount(0);
    // The controls sit above the safe area.
    const leave = await rect(sheet.getByTestId('ix-call-leave'));
    expect(leave.bottom).toBeLessThanOrEqual(PHONE.height - SAFE_BOTTOM);
    await shot(page, 'phone-call-sheet');

    // A drag down by the header follows the finger...
    const head = await rect(sheet.locator('.ix-call-head'));
    const grab = { x: 120, y: head.y + head.height / 2 };
    await drag(page, line(grab, { x: 120, y: grab.y + 160 }, 10), 30, false);
    expect(Number((await transformOf(sheet)).match(/matrix\(([^)]+)\)/)?.[1].split(',')[5])).toBeGreaterThan(120);
    // ...and back up a little and let go slowly: it springs back.
    const session = await touch(page);
    for (const dy of [140, 120, 100]) {
      await page.waitForTimeout(40);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120, y: grab.y + dy }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    await expect(sheet).toBeVisible();
    expect(await transformOf(sheet)).toBe('none');

    // Past a third of the way: it goes, and the call goes on.
    await drag(page, line(grab, { x: 120, y: grab.y + 420 }, 14), 16);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('ix-call')).toHaveCount(0);
    await expect(strip(page)).toHaveAttribute('data-state', 'yours');
    await page.waitForTimeout(600);
    await expect(page.locator('.ix-call-ghost')).toHaveCount(0);

    // Opened from the root's card, Back to chat shrinks it back into the card.
    await backToRoot(page);
    await roomCard(page, 'yours').getByTestId('ix-card-open-call').click();
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(600);
    await sheet.getByTestId('ix-call-back').click();
    await expect(sheet).toHaveCount(0);
    expect(await running(page)).toContain('ix-call:close');
    await page.waitForTimeout(700);
    await expect(page.locator('.ix-call-ghost')).toHaveCount(0);
  });

  test('five in the call: two columns of people', async ({ page }) => {
    const h = await open(page);
    await backToRoot(page);
    await h.step('arrive');
    await h.step('join');
    await h.step('crowd');
    await roomCard(page, 'yours').getByTestId('ix-card-open-call').click();
    const sheet = callSheet(page);
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(700);
    const columns = await sheet.locator('.ix-call-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(2);
    await shot(page, 'phone-call-sheet-five');
    await sheet.getByTestId('ix-call-back').click();
    await expect(sheet).toHaveCount(0);
  });

  test('a stream sits 16:9 on top with the people below, and goes full screen (the control, or sideways)', async ({ page }) => {
    await open(page);
    await backToRoot(page);
    // Game Night: Vincent streams in Lounge. Watch opens the sheet on the stream.
    await dockItem(page, 'gameNight').click();
    await page.waitForTimeout(900);
    expect(await screenOf(page)).toBe('places');
    await roomCard(page, 'streaming').getByTestId('ix-card-watch').click();
    const sheet = callSheet(page);
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(900);
    const stream = await rect(sheet.locator('.ix-call-stream'));
    expect(stream.width).toBeGreaterThan(PHONE.width - 30);
    expect(stream.width / stream.height).toBeCloseTo(16 / 9, 1);
    expect(stream.y).toBeLessThan(SAFE_TOP + 8 + 90);
    const below = await rect(sheet.locator('.ix-call-strip .ix-call-tile').first());
    expect(below.y).toBeGreaterThan(stream.bottom);
    await shot(page, 'phone-call-stream');

    // Full screen: the stream alone, Back to chat and Exit full screen over it.
    await sheet.getByTestId('ix-call-fullscreen').click();
    await expect(sheet).toHaveAttribute('data-fullscreen', 'true');
    await page.waitForTimeout(500);
    const full = await rect(sheet.locator('.ix-call-stream'));
    expect(full.width).toBeCloseTo(PHONE.width, 0);
    await expect(sheet.locator('.ix-call-controls')).toBeHidden();
    await shot(page, 'phone-call-fullscreen');
    await sheet.getByTestId('ix-call-sheet-exit-full').click();
    await expect(sheet).not.toHaveAttribute('data-fullscreen', 'true');

    // Turned sideways: still a phone, and the stream fills the screen on its own.
    await page.setViewportSize(SIDEWAYS);
    await page.addStyleTag({ content: safeAreas(true) });
    await expect(frame(page)).toHaveAttribute('data-layout', 'phone');
    await expect(sheet).toHaveAttribute('data-fullscreen', 'true');
    await page.waitForTimeout(600);
    const sideways = await rect(sheet.locator('.ix-call-stream'));
    expect(sideways.height).toBeCloseTo(SIDEWAYS.height, 0);
    await expect(sheet.getByTestId('ix-call-sheet-back')).toBeVisible();
    await shot(page, 'phone-call-landscape');
    await sheet.getByTestId('ix-call-sheet-back').click();
    await expect(sheet).toHaveCount(0);
    await page.setViewportSize(PHONE);
  });

  test('Events on a phone: the plan cards fit the column, nothing cut off', async ({ page }) => {
    const GN = GUILD.gameNight.id;
    const iso = (time: string, day = '2026-10-01') => `${day}T${time}-05:00`;
    const event = (id: string, name: string, over: Record<string, unknown>) => ({
      id, guild_id: GN, channel_id: CH.gnRoomLounge, event_channel_id: null, creator_id: PEOPLE.brendan.id, name, description: null,
      scheduled_start: iso('21:00', '2026-10-02'), scheduled_end: null, recurrence_rule: null, reminder_minutes: null, status: 1,
      entity_type: 1, location: null, image_url: null, user_count: 4, user_rsvp: false, created_at: CLOCK.start, ...over,
    });
    await open(page, () => `/app/guilds/${GN}/events`, {
      setup: async () => {
        await page.route(new RegExp(`/api/v1/guilds/${GN}/events`), (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            body: JSON.stringify([
              event('700000000000000001', 'Ranked night', { description: 'Bring a squad of four. Drop pod at nine.', recurrence_rule: 'weekly', reminder_minutes: 30 }),
              event('700000000000000002', 'Lounge movie', { scheduled_start: iso('21:30'), status: 2, user_rsvp: true, user_count: 6 }),
              event('700000000000000003', 'Last week’s tournament', { scheduled_start: iso('20:00', '2026-09-24'), status: 3, user_count: 11 }),
            ]),
          }),
        );
      },
    });
    await expect(page.getByTestId('ix-events')).toBeVisible();
    await page.waitForTimeout(800);
    for (const card of await page.getByRole('article').all()) {
      const box = await rect(card);
      expect(box.right).toBeLessThanOrEqual(PHONE.width - 15);
      const clipped = await card.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>('*')]
          .filter((node) => getComputedStyle(node).textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.textContent?.trim() ?? ''),
      );
      expect(clipped).toEqual([]);
    }
    await shot(page, 'phone-events');
  });

  test('Plan a night on a phone: the draft card fits the column', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(600);
    await page.getByTestId('ix-action-card').and(page.locator('[data-action="plan"]')).click();
    await page.waitForTimeout(1200);
    const card = page.getByTestId('ix-draft-event');
    await expect(card).toBeVisible();
    const box = await rect(card);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(PHONE.width);
    // Nothing in it is cut off with an ellipsis it did not need.
    const clipped = await card.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('*')]
        .filter((node) => getComputedStyle(node).textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.textContent?.trim() ?? ''),
    );
    expect(clipped).toEqual([]);
    await shot(page, 'phone-plan-a-night', 300);

  });

  /* ---------------------------------------------- menus, sheets, switcher */

  test('menus are action sheets: at the foot, radius 20, rows 52, with Cancel', async ({ page }) => {
    await open(page);
    await backToRoot(page);
    await page.getByTestId('ix-sidebar-header').getByRole('button', { name: 'Server options' }).click();
    const menu = page.locator('.ix-menu--sheet');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-presentation', 'sheet');
    await page.waitForTimeout(500);
    const box = await rect(menu);
    expect(box.x).toBeCloseTo(8, 0);
    expect(box.right).toBeCloseTo(PHONE.width - 8, 0);
    expect(box.bottom).toBeCloseTo(PHONE.height - SAFE_BOTTOM - 8, 0);
    expect(await menu.locator('.ix-menu__sheet-rows').evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('20px');
    const firstRow = await rect(menu.locator('.ix-menu__item').first());
    expect(firstRow.height).toBeGreaterThanOrEqual(52);
    await expect(page.locator('.ix-action-scrim')).toBeVisible();
    await shot(page, 'phone-action-sheet', 300);
    // Tapping the scrim puts it away.
    await page.mouse.click(200, 60);
    await expect(menu).toHaveCount(0);

    // A long press on a channel row: its menu, as an action sheet too.
    const row = await rect(channelRow(page, 'fuelClips'));
    const session = await touch(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: row.x + 80, y: row.y + row.height / 2 }] });
    await page.waitForTimeout(700);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const rowMenu = page.locator('[role="menu"][data-presentation="sheet"]');
    await expect(rowMenu).toBeVisible();
    await shot(page, 'phone-action-sheet-channel', 500);
    await rowMenu.getByTestId('ix-menu-cancel').click();
    await expect(rowMenu).toHaveCount(0);
  });

  test('sheets are pushed pages: in from the right over main, back by the chevron or the edge swipe', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(500);
    await toolbar(page).getByRole('button', { name: 'Members' }).click();
    const sheet = page.locator('.ix-sheet[data-sheet="people"]');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-host', 'window');
    expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).toBe('ix-phone-push-in');
    await page.waitForTimeout(600);
    expect(await rect(sheet)).toMatchObject({ x: 0, y: 0, width: PHONE.width, height: PHONE.height });
    // Main steps 30% back beneath it.
    expect(shiftX(await transformOf(main(page)))).toBeCloseTo(-0.3 * PHONE.width, 0);
    await shot(page, 'phone-sheet-people');
    await sheet.locator('[data-ix-sheet-dismiss]').click();
    await expect(sheet).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(shiftX(await transformOf(main(page)))).toBe(0);

    // The edge swipe takes it off the same way.
    await toolbar(page).getByRole('button', { name: 'Search messages' }).click();
    const search = page.locator('.ix-sheet[data-sheet="search"]');
    await expect(search).toBeVisible();
    await page.waitForTimeout(600);
    await drag(page, line({ x: 6, y: 500 }, { x: 280, y: 500 }, 14), 18);
    await expect(search).toHaveCount(0);
    expect(await screenOf(page)).toBe('conversation');
    await page.waitForTimeout(500);
    expect(shiftX(await transformOf(main(page)))).toBe(0);
    await nothingRunsAtRest(page);
  });

  test('the quick switcher is the whole screen, from the sidebar search field, with Cancel', async ({ page }) => {
    await open(page);
    await backToRoot(page);
    await searchField(page).click();
    const switcher = page.getByTestId('ix-switcher');
    await expect(switcher).toBeVisible();
    await expect(switcher).toHaveAttribute('data-layout', 'phone');
    await page.waitForTimeout(400);
    expect(await rect(switcher)).toMatchObject({ x: 0, y: 0, width: PHONE.width, height: PHONE.height });
    await shot(page, 'phone-switcher', 300);
    await page.getByTestId('ix-switcher-cancel').click();
    await expect(switcher).toHaveCount(0);
  });

  /* -------------------------------------------------- the message box */

  test('the message box rides on the keyboard, and the conversation stays in view', async ({ page }) => {
    const h = await open(page, undefined, { keyboard: true });
    await h.step('arrive');
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await page.waitForTimeout(800);
    await composerInput(page).click();
    const keyboard = 336;
    await page.evaluate((px) => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(px), keyboard);
    await expect(page.locator('html')).toHaveAttribute('data-ix-keyboard', 'open');
    await page.waitForTimeout(400);
    const box = await rect(page.getByTestId('ix-composer'));
    expect(box.bottom).toBeLessThanOrEqual(PHONE.height - keyboard);
    expect(box.bottom).toBeGreaterThan(PHONE.height - keyboard - 20);
    // The newest message is still on screen, right above the box.
    const last = await rect(page.getByText('yep, bringing the projector', { exact: true }));
    expect(last.bottom).toBeLessThanOrEqual(box.y + 1);
    expect(last.y).toBeGreaterThan(SAFE_TOP + 52);
    await shot(page, 'phone-keyboard', 300);

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(0));
    await expect(page.locator('html')).not.toHaveAttribute('data-ix-keyboard', 'open');
    expect((await rect(page.getByTestId('ix-composer'))).bottom).toBeLessThanOrEqual(PHONE.height - SAFE_BOTTOM);
  });

  test('the send flight flies on a phone, from the box onto its row', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await expect(page.getByText('yep, bringing the projector', { exact: true })).toBeVisible();
    await page.waitForTimeout(1500);
    const input = page.locator('textarea[data-composer-input]');
    await input.click();
    await input.fill('omw, ten minutes');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Send message' }).click();
    const airborne = await page.evaluate(() =>
      document.getAnimations().filter((a) => a.id.startsWith('data-motion-recipe:send') && a.playState === 'running').length,
    );
    expect(airborne, 'the flight is airborne on the tap').toBeGreaterThan(0);
    await expect(page.locator('.glass-flight')).toHaveCount(1);
    await shot(page, 'phone-send-flight', 110);
    await expect(page.locator('.glass-flight')).toHaveCount(0);
    const rows = page.locator('[id^="msg-"][data-own]', { hasText: 'omw, ten minutes' });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeInViewport();
  });

  /* -------------------------------------------------------- sideways */

  test('sideways (844x390) it is still a phone: the root, then a pushed page', async ({ page }) => {
    await page.setViewportSize(SIDEWAYS);
    await open(page);
    await backToRoot(page);
    expect(await rect(sidebar(page))).toMatchObject({ width: SIDEWAYS.width, height: SIDEWAYS.height });
    await shot(page, 'phone-landscape-root');
    await channelRow(page, 'fuelGeneral').click();
    await expect.poll(() => screenOf(page)).toBe('conversation');
    await shot(page, 'phone-landscape-pushed');
  });

  test('a direct message: call and options in the toolbar; the options are an action sheet with pins and media', async ({ page }) => {
    await open(page, (h) => h.routes.dm('dmJeremy'));
    await page.waitForTimeout(800);
    await expect(toolbar(page).getByRole('button', { name: /call/i }).first()).toBeVisible();
    await shot(page, 'phone-dm');
    await toolbar(page).getByTestId('ix-conversation-more').click();
    const menu = page.locator('.ix-menu--sheet');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('ix-menu-pins')).toBeVisible();
    await expect(menu.getByTestId('ix-menu-media')).toBeVisible();
    await expect(menu.getByTestId('ix-menu-summary')).toBeVisible();
    await shot(page, 'phone-dm-options', 500);
    // Pinned messages: a pushed page.
    await menu.getByTestId('ix-menu-pins').click();
    const sheet = page.locator('.ix-sheet[data-host="window"]');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(600);
    expect(await rect(sheet)).toMatchObject({ x: 0, width: PHONE.width });
    await shot(page, 'phone-dm-pins', 200);
    expect(CH.dmJeremy).toBeTruthy();
  });
});
