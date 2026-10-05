import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CH,
  GUILD,
  composer,
  composerInput,
  installIndexScene,
  outDir,
  shoot,
  sidebar,
  type IndexHarness,
} from './fixtures/index';
import { HISTORY_EPOCH } from './fixtures/index/world';

/**
 * IX-12 (Message box): the capsule, the open state with its tools row, the
 * three-slice open and close (transform and opacity only), the send control
 * turning cream, the reply chip, the attachment queue, completion, the one
 * picker, Send later and the scheduled sheet, the read-only and slow-mode
 * lines (docs/index-spec.md §4.12, §5.12, §5.13, §6.11; plan §3 IX-12).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-composer PARACORD_E2E_INDEX_PORT=4603 \
 *   PARACORD_E2E_INDEX_RT_PORT=4605 PARACORD_E2E_INDEX_WP=ix12 \
 *     npx playwright test -c e2e/index-review.config.ts
 *   node e2e/index-compare.mjs ix12 --only s0-message-box-open
 *
 * Shots land in output/design-reference/index-build/ix12/; the open box is
 * held against ref/s0-message-box-open.png (the prototype's box).
 */

const SETTLE_MS = 700;

/** An uncaught error in the page fails the test that caused it. */
const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
    body: JSON.stringify(body),
  });

async function open(page: Page, options: { route?: (h: IndexHarness) => string; viewport?: { width: number; height: number } } = {}): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize(options.viewport ?? { width: 1280, height: 800 });
  const h = await installIndexScene(page, { video: false });
  // Roles for @ completion; scheduled messages for the sheet.
  for (const guild of [GUILD.fuel, GUILD.gameNight, GUILD.basecamp]) {
    await page.route(`**/api/v1/guilds/${guild.id}/roles`, (route) => json(route, []));
    await page.route(`**/api/v1/guilds/${guild.id}/emojis`, (route) => json(route, []));
  }
  await h.open(options.route ? options.route(h) : h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return h;
}

const box = (page: Page) => composer(page).locator('.ix-composer__box');
const FRAMES = () => path.join(outDir(), 'composer');

/** Film what is running now, frozen at each offset: full window shots, then let it run. */
async function filmRunning(page: Page, name: string, prefix: string, offsets: number[]) {
  const dir = path.join(FRAMES(), name);
  await mkdir(dir, { recursive: true });
  const count = await page.evaluate((prefixes) => {
    const running = document.getAnimations().filter((animation) => {
      const id = animation.id || '';
      const css = (animation as CSSTransition).transitionProperty ?? '';
      const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
      const inBox = Boolean(target?.closest?.('.ix-composer'));
      return animation.playState === 'running' && (prefixes.some((p) => id.startsWith(p)) || (css !== '' && inBox));
    });
    (window as unknown as { __film: Animation[] }).__film = running;
    for (const animation of running) animation.pause();
    return running.length;
  }, [prefix]);
  const clip = await box(page).boundingBox();
  if (!clip) throw new Error('no box');
  const crop = { x: clip.x - 24, y: clip.y - 80, width: clip.width + 48, height: clip.height + 104 };
  for (const at of offsets) {
    await page.evaluate((time) => {
      for (const animation of (window as unknown as { __film: Animation[] }).__film) animation.currentTime = time;
    }, at);
    await page.screenshot({ path: path.join(dir, `${String(at).padStart(3, '0')}ms.png`), clip: crop });
  }
  await page.evaluate(() => {
    for (const animation of (window as unknown as { __film: Animation[] }).__film) animation.play();
  });
  return count;
}

/** Every Web Animation the box played since `startWatch`, by id, with its properties and length. */
async function startWatch(page: Page) {
  await page.evaluate(() => {
    const seen = new WeakSet<Animation>();
    const log: Array<{ id: string; props: string[]; duration: number }> = [];
    (window as unknown as { __boxLog: typeof log }).__boxLog = log;
    const t0 = performance.now();
    const tick = () => {
      for (const animation of document.getAnimations()) {
        if (seen.has(animation) || !animation.id.startsWith('ix-composer')) continue;
        seen.add(animation);
        const effect = animation.effect as KeyframeEffect | null;
        const props = new Set<string>();
        for (const frame of effect?.getKeyframes() ?? []) for (const key of Object.keys(frame)) props.add(key);
        log.push({ id: animation.id, props: [...props], duration: Number(effect?.getTiming().duration) });
      }
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const watched = (page: Page) =>
  page.evaluate(() => (window as unknown as { __boxLog: Array<{ id: string; props: string[]; duration: number }> }).__boxLog);
const META = new Set(['offset', 'easing', 'composite', 'computedOffset']);

test.describe('the message box', () => {
  test('closed, it is the 52px capsule; focused with words, the 98px open box with its tools (s0-message-box-open)', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(SETTLE_MS);
    const closed = await box(page).boundingBox();
    expect(closed?.height).toBe(52);
    await expect(composer(page)).toHaveAttribute('data-ix-composer-open', 'false');
    // Quiet until there is something to send.
    const send = page.getByRole('button', { name: 'Send message' });
    expect(await send.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(255, 255, 255, 0.08)');
    await shoot(page, 'ix12-closed');

    await composerInput(page).click();
    await page.keyboard.type('testing the box');
    await expect(composer(page)).toHaveAttribute('data-ix-composer-open', 'true');
    await page.waitForTimeout(SETTLE_MS);
    const opened = await box(page).boundingBox();
    expect(opened?.height).toBe(98);
    // The box sits on the same foot: it grew upward. Margin 36 either side of main (§3.1).
    expect(Math.round(opened!.y + opened!.height - (closed!.y + closed!.height))).toBe(0);
    expect(Math.round(opened!.x)).toBe(316 + 36);
    expect(Math.round(opened!.width)).toBe(1280 - 316 - 72);
    // §5.13: cream with dark ink once there are words.
    expect(await send.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(244, 242, 237)');
    expect(await send.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(20, 20, 20)');
    const tools = composer(page).locator('.ix-composer__tools');
    await expect(tools.getByRole('button', { name: 'Attach' })).toBeVisible();
    await expect(tools.getByRole('button', { name: 'GIF' })).toBeVisible();
    await expect(tools.getByRole('button', { name: 'Poll' })).toBeVisible();
    await expect(tools.getByRole('button', { name: 'Event' })).toBeVisible();
    await expect(tools.getByRole('button', { name: 'Format' })).toBeVisible();
    await shoot(page, 's0-message-box-open');
    await shoot(page, 's0-message-box-open', { size: 'desktop' });
    await shoot(page, 's0-message-box-open', { size: 'narrow' });
  });

  test('opens in three slices and closes back, transform and opacity only, then nothing runs', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(SETTLE_MS);
    await startWatch(page);
    await composerInput(page).click();
    const opening = await filmRunning(page, 'open', 'ix-composer', [0, 40, 80, 160, 250, 380, 500]);
    expect(opening, 'the open plays').toBeGreaterThan(2);
    await page.waitForTimeout(800);
    const opened = await watched(page);
    const shape = opened.filter((a) => a.id.startsWith('ix-composer:shape:'));
    // The fill's and the edge's top caps and middles, and the head riding the top.
    expect(shape.map((a) => a.id).sort()).toEqual([
      'ix-composer:shape:head',
      'ix-composer:shape:mid',
      'ix-composer:shape:mid',
      'ix-composer:shape:top',
      'ix-composer:shape:top',
    ]);
    for (const animation of shape) {
      expect(animation.duration, `${animation.id} is 150ms`).toBe(150);
      for (const prop of animation.props) if (!META.has(prop)) expect(prop, `${animation.id} animates ${prop}`).toBe('transform');
    }

    // Closing: press somewhere else with the box empty.
    await startWatch(page);
    await page.mouse.click(800, 300);
    await expect(composer(page)).toHaveAttribute('data-ix-composer-open', 'false');
    const closing = await filmRunning(page, 'close', 'ix-composer', [0, 40, 80, 160, 250, 350]);
    expect(closing, 'the close plays').toBeGreaterThan(2);
    await page.waitForTimeout(800);
    const closed = await watched(page);
    const back = closed.filter((a) => a.id.startsWith('ix-composer:shape:'));
    expect(back.map((a) => a.id).sort()).toEqual([
      'ix-composer:shape:head',
      'ix-composer:shape:mid',
      'ix-composer:shape:mid',
      'ix-composer:shape:tools',
      'ix-composer:shape:top',
      'ix-composer:shape:top',
    ]);
    for (const animation of back) {
      expect(animation.duration, `${animation.id} is 105ms`).toBe(105);
      for (const prop of animation.props) if (!META.has(prop)) expect(prop, `${animation.id} animates ${prop}`).toBe('transform');
    }
    expect((await box(page).boundingBox())?.height).toBe(52);
    // Quiet at rest: nothing in the box runs two seconds after it settles.
    await page.waitForTimeout(2000);
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
          return animation.playState === 'running' && Boolean(target?.closest?.('.ix-composer'));
        }).length,
    );
    expect(running).toBe(0);
  });

  test('attachments queue as 52px thumbnails inside the box, above the words', async ({ page }) => {
    await open(page);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await composer(page).locator('input[type="file"]').setInputFiles([
      { name: 'clip-still.png', mimeType: 'image/png', buffer: png },
      { name: 'route-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 notes') },
    ]);
    const queue = composer(page).getByRole('list', { name: 'Attachments' });
    await expect(queue.getByRole('listitem')).toHaveCount(2);
    await expect(composer(page)).toHaveAttribute('data-ix-composer-open', 'true');
    await page.waitForTimeout(SETTLE_MS);
    const thumb = await queue.getByRole('listitem').first().boundingBox();
    expect(thumb?.height).toBe(52);
    expect(thumb?.width).toBe(52);
    expect((await box(page).boundingBox())!.height).toBe(98 + 12 + 52);
    await expect(composer(page).getByRole('button', { name: 'Remove route-notes.pdf' })).toBeVisible();
    await shoot(page, 'ix12-attachments');
    await composer(page).getByRole('button', { name: 'Remove clip-still.png' }).click();
    await expect(queue.getByRole('listitem')).toHaveCount(1);
  });

  test('@, # and : complete in a popover above the box', async ({ page }) => {
    await open(page, { route: (h) => h.routes.channel('gnLounge') });
    await composerInput(page).click();
    await page.keyboard.type('hey @ma');
    const list = composer(page).getByRole('listbox', { name: 'People and roles' });
    await expect(list.getByRole('option', { name: /Maya/ })).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, 'ix12-complete-people');
    await page.keyboard.press('Enter');
    await expect(composerInput(page)).toHaveValue(/^hey <@\d+> $/);

    await page.keyboard.type('see #lo');
    const channels = composer(page).getByRole('listbox', { name: 'Channels' });
    await expect(channels.getByRole('option', { name: /lounge/ })).toBeVisible();
    await expect(channels.getByRole('option', { name: /looking-for-group/ })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await expect(composerInput(page)).toHaveValue(new RegExp(`see <#${CH.gnLfg}> $`));

    await page.keyboard.type(':fi');
    const emoji = composer(page).getByRole('listbox', { name: 'Emoji' });
    await expect(emoji.getByRole('option', { name: /:fire:/ })).toBeVisible();
    await shoot(page, 'ix12-complete-emoji');
    await page.keyboard.press('Enter');
    await expect(composerInput(page)).toHaveValue(/\u{1F525} $/u);
    await page.keyboard.press('Escape');
  });

  test('one picker: Emoji, GIF and Stickers above the emoji button', async ({ page }) => {
    await open(page, { route: (h) => h.routes.channel('gnLounge') });
    await page.route('**/api/v1/gifs/**', (route) => json(route, { results: [] }));
    await page.route('**/api/v1/guilds/*/stickers', (route) => json(route, []));
    await composerInput(page).click();
    await composer(page).getByRole('button', { name: 'Emoji' }).click();
    const picker = composer(page).getByRole('dialog');
    await expect(picker.getByRole('tab', { name: 'Emoji' })).toHaveAttribute('aria-selected', 'true');
    await expect(picker.getByRole('tab', { name: 'GIF' })).toBeVisible();
    await expect(picker.getByRole('tab', { name: 'Stickers' })).toBeVisible();
    // Measured after its 55ms entrance (scale .97 and a fade).
    await page.waitForTimeout(400);
    const rect = await picker.boundingBox();
    expect(Math.round(rect!.width)).toBe(360);
    expect(Math.round(rect!.height)).toBe(420);
    await page.waitForTimeout(400);
    await shoot(page, 'ix12-picker-emoji');
    await picker.getByRole('tab', { name: 'GIF' }).click();
    await expect(picker.getByRole('tab', { name: 'GIF' })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(400);
    await shoot(page, 'ix12-picker-gif');
    await page.keyboard.press('Escape');
    await expect(composer(page).getByRole('dialog')).toHaveCount(0);
    // The GIF chip opens the same picker on GIF.
    await composer(page).locator('.ix-composer__tools').getByRole('button', { name: 'GIF' }).click();
    await expect(composer(page).getByRole('tab', { name: 'GIF' })).toHaveAttribute('aria-selected', 'true');
  });

  test('right-click Send: Send later, and the scheduled messages sheet', async ({ page }) => {
    const h = await open(page);
    await page.route(`**/api/v1/channels/${CH.fuelGeneral}/scheduled-messages`, (route) =>
      route.request().method() === 'GET'
        ? json(route, [
            {
              id: '9001',
              channel_id: CH.fuelGeneral,
              author_id: '1',
              content: 'game night starts in an hour, grab snacks',
              send_at: '2026-10-02T20:00:00-05:00',
              status: 0,
              created_at: '2026-10-01T21:00:00-05:00',
              updated_at: '2026-10-01T21:00:00-05:00',
            },
          ])
        : route.fallback(),
    );
    void h;
    await composerInput(page).click();
    await page.keyboard.type('reminder for later');
    await page.getByRole('button', { name: 'Send message' }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Send options' });
    await expect(menu.getByRole('menuitem', { name: /Send later/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Scheduled messages/ })).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, 'ix12-send-menu');
    await menu.getByRole('menuitem', { name: /Send later/ }).click();
    await expect(composer(page).getByLabel('Send at')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule message' })).toBeVisible();
    await page.waitForTimeout(400);
    await shoot(page, 'ix12-send-later');

    // The Send later card links to the list, as the menu does.
    await composer(page).getByRole('button', { name: 'Scheduled messages' }).click();
    const sheet = page.getByRole('dialog', { name: 'Scheduled messages' });
    await expect(sheet.getByText('game night starts in an hour, grab snacks')).toBeVisible();
    await page.waitForTimeout(500);
    await shoot(page, 'ix12-scheduled-sheet');
  });

  test('a channel you cannot post in has a line instead of a box; slow mode says its interval', async ({ page }) => {
    await page.route(`**/api/v1/channels/${CH.fuelClips}/capabilities`, (route) =>
      json(route, {
        version: 1,
        channel_id: CH.fuelClips,
        user_id: '__self__',
        encrypted: false,
        own_identity_enrolled: false,
        peers_ready: true,
        actions: Object.fromEntries(
          ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => [
            action,
            ['send', 'poll', 'schedule', 'attach'].includes(action)
              ? { supported: true, allowed: false, reason: 'You do not have permission to use this action in this channel.' }
              : { supported: true, allowed: true, reason: null },
          ]),
        ),
      }),
    );
    const h = await open(page);
    // The capability answer names the signed-in account; the harness's own id is in READY.
    const self = await page.evaluate(async () => {
      const auth = (await import('/src/stores/authStore.ts' as string)) as { useAuthStore: { getState: () => { user: { id: string } | null } } };
      return auth.useAuthStore.getState().user?.id ?? '';
    });
    await page.unroute(`**/api/v1/channels/${CH.fuelClips}/capabilities`);
    await page.route(`**/api/v1/channels/${CH.fuelClips}/capabilities`, (route) =>
      json(route, {
        version: 1,
        channel_id: CH.fuelClips,
        user_id: self,
        encrypted: false,
        own_identity_enrolled: false,
        peers_ready: true,
        actions: Object.fromEntries(
          ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => [
            action,
            ['send', 'poll', 'schedule', 'attach'].includes(action)
              ? { supported: true, allowed: false, reason: 'You do not have permission to use this action in this channel.' }
              : { supported: true, allowed: true, reason: null },
          ]),
        ),
      }),
    );
    await h.open(h.routes.channel('fuelClips'));
    await expect(composer(page)).toHaveAttribute('data-read-only', 'true');
    await expect(composer(page).getByRole('status')).toHaveText("You can't send messages in clips");
    await expect(composer(page).getByRole('textbox')).toHaveCount(0);
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'ix12-read-only');

    // Slow mode: the channel's interval, in the tools row.
    await h.open(h.routes.channel('fuelPlans'));
    await page.evaluate(async (channelId) => {
      const store = (await import('/src/stores/channelStore.ts' as string)) as {
        useChannelStore: { getState: () => { updateChannel: (patch: { id: string; rate_limit_per_user: number }, scope: { serverId: string; userId: string }) => void } };
      };
      const auth = (await import('/src/stores/authStore.ts' as string)) as { useAuthStore: { getState: () => { user: { id: string } | null } } };
      const list = (await import('/src/stores/serverListStore.ts' as string)) as { useServerListStore: { getState: () => { activeServerId: string | null } } };
      const scope = { serverId: list.useServerListStore.getState().activeServerId ?? '__local__', userId: auth.useAuthStore.getState().user?.id ?? '' };
      store.useChannelStore.getState().updateChannel({ id: channelId, rate_limit_per_user: 12 }, scope);
    }, CH.fuelPlans);
    await composerInput(page).click();
    await expect(composer(page).getByText('Slow mode: 12s')).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'ix12-slow-mode');
  });

  test('a phone-width box keeps its tools as glyphs', async ({ page }) => {
    await open(page, { viewport: { width: 390, height: 844 } });
    await page.waitForTimeout(SETTLE_MS);
    // A channel route opens the conversation pushed over the phone's sidebar.
    await expect(composerInput(page)).toBeVisible();
    await composerInput(page).click();
    await page.keyboard.type('on the go');
    await page.waitForTimeout(SETTLE_MS);
    await expect(composer(page)).toHaveAttribute('data-icon-tools', 'true');
    await expect(composer(page).locator('.ix-composer__tools').getByRole('button', { name: 'Attach' })).toBeVisible();
    await shoot(page, 's0-message-box-open', { size: 'phone' });
  });
});
