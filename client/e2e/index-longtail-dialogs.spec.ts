import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gradientPng } from './fixtures/index/png';
import { CH, GUILD, PEOPLE, installIndexScene, outDir, shoot, sidebar, type IndexHarness } from './fixtures/index';
import { frames } from './fixtures/index/gateway';
import { HISTORY_EPOCH } from './fixtures/index/world';

/**
 * IX-17, area C: the dialogs and pickers of the long tail. Invite and screen
 * share, forward / remind me / edit history / who reacted, the one picker's
 * insides, and the media viewer (docs/index-spec.md §6.10, §6.11, §6.12).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-longtail-dialogs PARACORD_E2E_INDEX_PORT=4659 \
 *   PARACORD_E2E_INDEX_RT_PORT=4661 PARACORD_E2E_INDEX_WP=ix17 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Every surface is opened the way a person opens it (the server menu, a
 * message's actions, the Screen control, a photo). Shots land in
 * output/design-reference/index-build/ix17/ with the prefix `dlg-`; the
 * prototype has no dialog or picker, so they are held against the spec and read.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

const CREAM = 'rgb(244, 242, 237)';

async function open(page: Page, route?: (h: IndexHarness) => string, viewport = { width: 1440, height: 900 }): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize(viewport);
  const h = await installIndexScene(page);
  await h.open(route ? route(h) : h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

/** An answer with the scene's history epoch: an owned operation (the edit history) expires without it. */
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
    body: JSON.stringify(body),
  });

const shot = (page: Page, name: string, size: 'desktop' | 'phone' = 'desktop', settle = 450) =>
  shoot(page, `dlg-${name}`, { size, settle });

/** A shot that leaves the pointer where it is (a hover-opened list closes when the pointer leaves). */
async function shotHere(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const dir = outDir();
  await mkdir(dir, { recursive: true });
  const view = page.viewportSize()!;
  await page.screenshot({ path: path.join(dir, `dlg-${name}@${view.width}x${view.height}.png`) });
}

/** The cream buttons inside a surface: the one action it may carry (§1.4). */
async function creamButtons(surface: Locator): Promise<string[]> {
  return surface.locator('button').evaluateAll((buttons, cream) =>
    buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(button).backgroundColor === cream;
      })
      .map((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()),
  CREAM);
}

/** Animations still running inside a dialog, a popover or the viewer. */
async function runningInside(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target as Element | null | undefined;
        return (
          animation.playState === 'running' &&
          Boolean(target?.closest?.('[role="dialog"], [role="menu"], .pc-floating, .ix-menu'))
        );
      })
      .map((animation) => animation.id || animation.constructor.name),
  );
}

/** A Game Night message's hover capsule, then a row of its actions menu. */
async function messageRow(page: Page, text: string): Promise<Locator> {
  const row = page.locator('[role="article"]', { hasText: text }).last();
  await expect(row).toBeVisible();
  return row;
}

async function openMessageMenu(page: Page, text: string): Promise<Locator> {
  const row = await messageRow(page, text);
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  return menu;
}

const LOUNGE_LINE = 'bring the good guns this time';

test.describe('dialogs (§6.12)', () => {
  test('invite: a 440 card, one cream Copy, the label crossfades to "Link copied" and back', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await page.route('**/api/v1/channels/*/invites', (route) =>
      route.request().method() === 'POST'
        ? json(route, {
            code: 'k4Tz9wMe',
            channel_id: CH.fuelGeneral,
            guild_id: GUILD.fuel.id,
            created_at: '2026-10-01T21:38:00-05:00',
            inviter_id: PEOPLE.you.id,
            max_age: 604800,
            max_uses: 0,
            uses: 0,
          })
        : route.fallback(),
    );
    await page.route('**/api/v1/instance/share-address', (route) => json(route, { url: 'https://chat.example.test', reach: 'internet' }));
    // IX-5's header: the "..." button at its right edge opens the server menu.
    await page.locator('[data-testid="ix-sidebar-header"] [aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: 'Invite people' }).click();
    const dialog = page.getByRole('dialog', { name: /Invite people to Fuel/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Invite link' })).toHaveValue('https://chat.example.test/invite/k4Tz9wMe');
    await page.waitForTimeout(400);

    const box = await dialog.boundingBox();
    expect(box!.width, 'the invite dialog is at most 440 wide').toBeLessThanOrEqual(440);
    expect(box!.width).toBeGreaterThan(400);
    expect(await creamButtons(dialog), 'one cream button').toEqual(['Copy invite link']);
    await expect(dialog).toHaveCSS('border-radius', '20px');
    await expect(dialog.getByRole('heading')).toHaveCSS('font-weight', '700');
    await shot(page, 'invite');

    // Copy: the label crossfades (opacity, 60ms), then comes back after two seconds.
    const copy = dialog.getByRole('button', { name: 'Copy invite link' });
    const words = dialog.locator('.ix-copy').first();
    await expect(words.locator('span').nth(0)).toHaveText('Copy link');
    await expect(words.locator('span').nth(0)).toHaveCSS('transition-duration', '0.06s');
    await copy.click();
    await expect(dialog.getByRole('button', { name: 'Invite link copied' })).toBeVisible();
    await expect(words.locator('span[data-on="true"]')).toHaveText('Link copied');
    await page.waitForTimeout(350);
    await shot(page, 'invite-copied', 'desktop', 50);
    await expect(words.locator('span[data-on="true"]')).toHaveText('Copy link', { timeout: 3_500 });

    // Changed options wait for a Regenerate: Copy is off and the fields dim.
    await dialog.getByLabel('Expire after').selectOption('never');
    await expect(dialog.getByRole('button', { name: /apply changed options first/ }).first()).toBeDisabled();
    await page.waitForTimeout(300);
    await shot(page, 'invite-options');
    expect(await runningInside(page), 'nothing runs at rest').toEqual([]);

    // The phone: the same card, full width less the gutters.
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByLabel('Expire after').selectOption('7days');
    await shot(page, 'invite', 'phone', 500);
    const phone = await dialog.boundingBox();
    expect(phone!.width).toBeLessThanOrEqual(390 - 32);
  });

  test('forward: search, choose, one cream Send; faces are marks and avatars', async ({ page }) => {
    await open(page, (h) => h.routes.channel('gnLounge'));
    const menu = await openMessageMenu(page, LOUNGE_LINE);
    await menu.getByRole('menuitem', { name: 'Forward' }).click();
    const dialog = page.getByRole('dialog', { name: 'Forward' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(450);
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(440);
    expect(await creamButtons(dialog), 'Send is the one cream button, off until something is chosen').toEqual(['Send']);
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await shot(page, 'forward');

    const rows = dialog.getByRole('button', { pressed: false });
    expect(await rows.count()).toBeGreaterThan(2);
    // Faces are the Index marks and avatars, never a glyph in a circle.
    expect(await dialog.locator('.ix-sq, .ix-av').count()).toBeGreaterThan(2);
    await dialog.getByRole('button', { name: /Jeremy/ }).first().click();
    await dialog.getByRole('button', { name: /#looking-for-group/ }).first().click();
    await dialog.getByLabel('Note').fill('this, but for tonight');
    await expect(dialog.getByRole('list', { name: 'Forwarding to' }).getByRole('button')).toHaveCount(2);
    expect(await creamButtons(dialog), 'one cream button: Send').toEqual(['Send to 2']);
    await page.waitForTimeout(300);
    await shot(page, 'forward-chosen');

    await dialog.getByLabel('Search conversations').fill('zzz');
    await expect(dialog.getByText('Nothing matches')).toBeVisible();
    await shot(page, 'forward-empty');
    expect(await runningInside(page)).toEqual([]);

    await dialog.getByLabel('Search conversations').fill('');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'forward', 'phone', 500);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('remind me: a menu in the Index look, then a date and time with one cream button', async ({ page }) => {
    await open(page, (h) => h.routes.channel('gnLounge'));
    const menu = await openMessageMenu(page, LOUNGE_LINE);
    await menu.getByRole('menuitem', { name: 'Remind me' }).click();
    const remind = page.getByRole('menu', { name: 'Remind me' });
    await expect(remind).toBeVisible();
    await page.waitForTimeout(400);
    const items = remind.getByRole('menuitem');
    expect(await items.count()).toBeGreaterThanOrEqual(4);
    const first = await items.first().boundingBox();
    expect(first!.height, 'rows are 36 tall').toBe(36);
    await expect(items.first()).toHaveCSS('font-size', '14px');
    await expect(items.first()).toHaveCSS('font-weight', '500');
    await expect(remind).toHaveCSS('border-radius', '14px');
    await shot(page, 'remind');
    await remind.getByRole('menuitem', { name: /Pick a date and time/ }).click();
    await expect(remind.getByLabel('Date and time')).toBeVisible();
    expect(await creamButtons(remind), 'one cream button: Set reminder').toEqual(['Set reminder']);
    await page.waitForTimeout(400);
    await shot(page, 'remind-pick');
  });

  test('edit history: a card dialog, each version a quiet row with its time', async ({ page }) => {
    const h = await open(page, (scene) => scene.routes.channel('gnLounge'));
    const target = h.world.messagesIn('gnLounge').find((m: { content: string }) => m.content === LOUNGE_LINE)!;
    await page.route('**/api/v1/channels/*/messages/*/edits', (route) =>
      json(route, [
        { id: 'e1', message_id: target.id, content: 'bring the good guns', edited_at: '2026-10-01T20:52:10-05:00' },
        { id: 'e2', message_id: target.id, content: 'bring the good guns this time', edited_at: '2026-10-01T20:53:40-05:00' },
      ]),
    );
    // Somebody edited it: the gateway says so, and the message wears "edited".
    await h.emit({
      op: 0,
      t: 'MESSAGE_UPDATE',
      d: {
        ...h.world.revisedMessageRecord(target),
        guild_id: GUILD.gameNight.id,
        edited_timestamp: '2026-10-01T20:53:40-05:00',
        message_revision: String(Number(target.revision) + 1),
      },
    });
    const row = await messageRow(page, LOUNGE_LINE);
    await row.getByRole('button', { name: /Show the edit history/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit history' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Version 2/)).toBeVisible();
    await page.waitForTimeout(450);
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(440);
    expect(await creamButtons(dialog), 'one cream button: Done').toEqual(['Done']);
    // The time is 12 on the tertiary ink, the version a quiet row.
    const time = dialog.getByText(/Version 1/);
    await expect(time).toHaveCSS('font-size', '12px');
    await shot(page, 'edit-history');
    expect(await runningInside(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('pickers (§6.11)', () => {
  test('the reaction picker is the one popover; who reacted lists faces in the menu look', async ({ page }) => {
    const h = await open(page, (scene) => scene.routes.channel('gnLounge'));
    const posted = h.world.post('gnLounge', 'nick', 'that last round was clean', {
      reactions: [{ emoji: '\u{1F525}', count: 3, me: false }],
    });
    await h.emit(frames.messageCreate(h.world, posted));
    await page.route('**/api/v1/channels/*/messages/*/reactions/*', (route) =>
      json(
        route,
        (['brendan', 'vincent', 'maya'] as const).map((who) => ({
          id: PEOPLE[who].id,
          username: PEOPLE[who].username,
          display_name: PEOPLE[who].display_name,
          avatar_hash: null,
        })),
      ),
    );
    const row = await messageRow(page, 'that last round was clean');
    // Who reacted: rest on the chip, then the list.
    const chip = row.getByRole('button', { name: /3/ }).first();
    await chip.hover();
    const list = page.getByRole('dialog', { name: /People who reacted with/ });
    await expect(list).toBeVisible({ timeout: 4_000 });
    await expect(list.getByText('Brendan')).toBeVisible();
    await expect(list.locator('.ix-av')).toHaveCount(3);
    const face = await list.locator('.ix-av').first().boundingBox();
    expect(face!.width).toBe(24);
    await expect(list).toHaveCSS('border-radius', '14px');
    await page.waitForTimeout(400);
    await shotHere(page, 'reaction-people');
    await page.mouse.move(700, 120);
    await expect(list).toBeHidden({ timeout: 3_000 });

    // React: the same popover as the composer's, 360x420 at radius 16.
    await row.hover();
    await row.getByRole('button', { name: /React to/ }).click();
    const picker = page.locator('.pc-floating').filter({ has: page.getByPlaceholder('Search emoji...') });
    await expect(picker).toBeVisible();
    await page.waitForTimeout(450);
    const pb = await picker.boundingBox();
    expect([Math.round(pb!.width), Math.round(pb!.height)]).toEqual([360, 420]);
    await expect(picker).toHaveCSS('border-radius', '16px');
    await shot(page, 'reaction-picker');
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
  });

  test('the composer picker: Emoji, GIF and Stickers in one surface', async ({ page }) => {
    await open(page, (h) => h.routes.channel('gnLounge'));
    await page.route('**/api/v1/tenor/trending**', (route) =>
      json(route, {
        results: [0, 1, 2, 3, 4, 5].map((n) => ({
          id: `gif${n}`,
          title: `Reaction ${n}`,
          media_formats: {
            tinygif: { url: `https://media.example.test/gif${n}.png`, dims: [320, n % 2 ? 200 : 160] },
            gif: { url: `https://media.example.test/gif${n}.png`, dims: [320, n % 2 ? 200 : 160] },
          },
        })),
      }),
    );
    await page.route('https://media.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: gradientPng(Number(route.request().url().match(/gif(\d)/)?.[1] ?? 0), 320, 200) }));
    await page.route(`**/api/v1/guilds/${GUILD.gameNight.id}/stickers`, (route) =>
      json(
        route,
        ['Wave', 'Cheers', 'GG', 'Nice', 'Oof', 'Hype'].map((name, n) => ({
          id: `st${n}`,
          guild_id: GUILD.gameNight.id,
          name,
          description: null,
          image_url: `/stickers/st${n}.png`,
          format_type: 1,
          created_at: '2026-08-14T19:00:00-05:00',
        })),
      ),
    );
    await page.route('**/stickers/*.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: gradientPng(Number(route.request().url().match(/st(\d)/)?.[1] ?? 0), 128, 128) }));
    const composer = page.getByTestId('ix-composer');
    await composer.getByRole('textbox').click();
    await composer.getByRole('button', { name: 'Emoji' }).click();
    const host = page.locator('.ix-picker');
    await expect(host).toBeVisible();
    await page.waitForTimeout(500);
    const hb = await host.boundingBox();
    expect([Math.round(hb!.width), Math.round(hb!.height)]).toEqual([360, 420]);
    await expect(host).toHaveCSS('border-radius', '16px');
    // The search field is the field recipe (the field fill and a hairline), 40 tall.
    const emojiSearch = host.getByPlaceholder('Search emoji...');
    await expect(emojiSearch).toBeVisible();
    await expect(host.locator('.pc-field').first()).toHaveCSS('border-radius', '12px');
    await shot(page, 'picker-emoji');
    for (const [tab, label, shotName] of [
      ['GIF', 'Search GIFs...', 'picker-gif'],
      ['Stickers', 'Search stickers...', 'picker-stickers'],
    ] as const) {
      await host.getByRole('tab', { name: tab }).click();
      await expect(host.getByPlaceholder(label)).toBeVisible();
      await page.waitForTimeout(700);
      await shot(page, shotName);
    }
    // Labels are sentence case: the picker carries no uppercase kicker.
    const caps = await host.evaluate((el) =>
      Array.from(el.querySelectorAll('*')).filter((node) => getComputedStyle(node).textTransform === 'uppercase').length,
    );
    expect(caps).toBe(0);
    expect(await runningInside(page)).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('the screen-share picker: tiles, one chosen with a check, one cream Share', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await expect(page.getByTestId('ix-room-card').first()).toBeVisible();
    // The desktop engine answers the picker's questions; the page's fake call has none, so give it these.
    await page.evaluate(async () => {
      const mod = (await import(/* @vite-ignore */ '/src/stores/voiceStore.ts')) as {
        useVoiceStore: { getState(): { mediaEngine: Record<string, unknown> | null } };
      };
      const engine = mod.useVoiceStore.getState().mediaEngine as Record<string, unknown>;
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d')!;
      const paint = (a: string, b: string) => {
        const gradient = context.createLinearGradient(0, 0, 320, 180);
        gradient.addColorStop(0, a);
        gradient.addColorStop(1, b);
        context.fillStyle = gradient;
        context.fillRect(0, 0, 320, 180);
        return canvas.toDataURL('image/png');
      };
      const thumbs: Record<string, string> = {
        screen1: paint('#2a3b55', '#0e1520'),
        win1: paint('#4a3a2a', '#1a1410'),
        win2: paint('#2a4a3a', '#101a15'),
      };
      Object.assign(engine, {
        supportsNativeSourcePicker: () => true,
        listScreenShareSources: async () => [
          { id: 'screen1', kind: 'screen', title: 'Display 1', appName: null, audioSupported: true, isSelf: false, requiresOsPicker: false },
          { id: 'win1', kind: 'window', title: 'Game Night - Lobby', appName: 'Steam', audioSupported: true, isSelf: false, requiresOsPicker: false },
          { id: 'win2', kind: 'window', title: 'Paracord', appName: 'Paracord', audioSupported: false, isSelf: true, requiresOsPicker: false },
        ],
        getScreenShareSourceThumbnail: async (id: string) => ({ dataUrl: thumbs[id] }),
      });
    });
    await page.getByTestId('ix-card-screen').click();
    const dialog = page.getByRole('dialog', { name: 'Share your screen' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Display 1')).toBeVisible();
    await page.waitForTimeout(900);
    // Nothing is chosen yet, so Share is off; the one cream button is the only filled one.
    await expect(dialog.getByRole('button', { name: 'Share', exact: true })).toBeDisabled();
    await shot(page, 'screen-share');
    await dialog.getByRole('radio', { name: /Game Night - Lobby/ }).click();
    await expect(dialog.getByRole('radio', { name: /Game Night - Lobby/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('radio', { name: /Game Night - Lobby/ })).toHaveClass(/ix-hue-selected/);
    expect(await creamButtons(dialog)).toEqual(['Share']);
    await page.waitForTimeout(300);
    await shot(page, 'screen-share-chosen');
    expect(await runningInside(page)).toEqual([]);
    // Filters narrow the tiles.
    await dialog.getByRole('tab', { name: /Screens/ }).click();
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('media viewer (§6.10)', () => {
  test('the photo grows out of its bubble, steps with the arrows, and shrinks back', async ({ page }) => {
    await open(page, (h) => h.routes.channel('gnScreenshots'));
    await page.waitForTimeout(800);
    const thumb = page.locator('.ix-media__open').nth(1);
    await expect(thumb).toBeVisible();
    const from = await thumb.locator('img').boundingBox();
    await thumb.click();
    // Mid-flight: the stage's FLIP is a transform-only animation on the spring, 135ms.
    await page.waitForTimeout(30);
    const grow = await page.evaluate(() => {
      const found = document.getAnimations().find((animation) => animation.id === 'ix-viewer:grow');
      if (!found) return null;
      const effect = found.effect as KeyframeEffect;
      return {
        duration: effect.getTiming().duration,
        easing: effect.getTiming().easing,
        properties: Array.from(new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))).filter(
          (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
        ),
      };
    });
    expect(grow, 'ix-viewer:grow is running').not.toBeNull();
    expect(grow!.duration).toBe(135);
    expect(grow!.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(grow!.properties.sort()).toEqual(['transform', 'transformOrigin']);
    await shotHere(page, 'viewer-midflight');
    const viewer = page.getByRole('dialog', { name: 'Image viewer' });
    await expect(viewer).toBeVisible();
    // The scrim is the viewer ground.
    await expect(viewer).toHaveCSS('background-color', 'rgba(8, 8, 10, 0.96)');
    // The picture starts where the bubble's picture is.
    void from;
    await page.waitForTimeout(1900);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.id.startsWith('ix-viewer')).length), 'nothing runs at rest').toBe(0);
    await shotHere(page, 'viewer');
    // 40px controls, a caption line, the arrows step through the set.
    for (const name of ['Close image viewer', 'Download image', 'Next image']) {
      const box = await viewer.getByRole('button', { name }).boundingBox();
      expect([box!.width, box!.height], name).toEqual([40, 40]);
    }
    await expect(viewer.getByText('photo-2.png')).toBeVisible();
    await expect(viewer.getByText('2 / 4')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(viewer.getByText('3 / 4')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(viewer.getByText('2 / 4')).toBeVisible();
    await page.keyboard.press('+');
    await expect(viewer.getByText('125%')).toBeVisible();
    await page.keyboard.press('-');
    // Escape: it shrinks back into the bubble (transform only), then it is gone.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(30);
    const shrink = await page.evaluate(() => {
      const found = document.getAnimations().find((animation) => animation.id === 'ix-viewer:shrink');
      if (!found) return null;
      const effect = found.effect as KeyframeEffect;
      return {
        duration: effect.getTiming().duration,
        properties: Array.from(new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))).filter(
          (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
        ),
      };
    });
    expect(shrink, 'ix-viewer:shrink is running').not.toBeNull();
    expect(shrink!.duration).toBe(135);
    expect(shrink!.properties.sort()).toEqual(['transform', 'transformOrigin']);
    await shotHere(page, 'viewer-closing');
    await expect(viewer).toBeHidden({ timeout: 2_000 });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.id.startsWith('ix-viewer')).length)).toBe(0);
  });

  test('reduced motion: the viewer fades instead of travelling', async ({ page }) => {
    await open(page, (h) => h.routes.channel('gnScreenshots'));
    await page.evaluate(async () => {
      const mod = (await import(/* @vite-ignore */ '/src/stores/uiStore.ts')) as { useUIStore: { getState(): { setMotion?: (v: string) => void } } };
      mod.useUIStore.getState().setMotion?.('reduced');
    });
    await page.waitForTimeout(400);
    await page.locator('.ix-media__open').nth(1).click();
    const viewer = page.getByRole('dialog', { name: 'Image viewer' });
    await expect(viewer).toBeVisible();
    await page.waitForTimeout(100);
    const travelling = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.id.startsWith('ix-viewer:'))
        .some((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => 'transform' in frame && frame.transform !== 'none')),
    );
    expect(travelling).toBe(false);
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden({ timeout: 2_000 });
  });
});
