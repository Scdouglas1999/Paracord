import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { FORUM_ID, POST_ID, installGlassPages } from './fixtures/glass/pages';
import { BASECAMP_ID, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G19: the pages that render inside the conversation pane, on the Glass
 * reference scene (mocked, like glass-review.spec.ts), at 1440x900 and 390x844.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g19 npx playwright test -c e2e/glass-pages.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/<state>-{desktop,phone}.png
 *
 * There is no reference render for Home, Friends, a server's Overview or a
 * forum; these are held to the Glass language the renders establish (content
 * solid, controls glass, kickers, the instrument cut, amber for live, one
 * filled button) and to the places panel's row rhythm beside them.
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g19';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;
type Size = keyof typeof SIZES;

async function shoot(page: Page, name: string, size: Size) {
  const view = page.viewportSize();
  if (view) await page.mouse.move(view.width - 3, view.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-${size}.png`), fullPage: false });
}

async function open(page: Page, size: Size, route: string, options: { ringing?: boolean } = {}) {
  test.setTimeout(90_000);
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page);
  await installGlassPages(page, options);
  await page.goto(route);
  await expect(page.locator('main').first()).toBeVisible();
  await page.waitForTimeout(700);
}

/** A tall window, to read a whole scrolling page in one picture. */
async function openTall(page: Page, route: string, height: number) {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height });
  await installGlassScene(page);
  await installGlassPages(page);
  await page.goto(route);
  await expect(page.locator('main').first()).toBeVisible();
  await page.waitForTimeout(700);
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

for (const size of ['desktop', 'phone'] as const) {
  test(`home at ${size}`, async ({ page }) => {
    await open(page, size, '/app');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shoot(page, 'home', size);
  });

  test(`a direct message at ${size}`, async ({ page }) => {
    await open(page, size, `/app/dms/${CH.dmBrendan}`);
    await expect(page.getByRole('feed', { name: 'Message history' }).getByText('you around for the haz run?')).toBeVisible();
    await shoot(page, 'dm', size);
  });

  test(`the messages index at ${size}`, async ({ page }) => {
    await open(page, size, '/app/dms');
    await shoot(page, 'dm-index', size);
  });

  test(`friends at ${size}`, async ({ page }) => {
    await open(page, size, '/app/friends');
    await expect(page.getByRole('heading', { level: 1, name: 'Friends' })).toBeVisible();
    await shoot(page, 'friends', size);
    await page.getByRole('tab', { name: /^All/ }).click();
    await shoot(page, 'friends-all', size);
    await page.getByRole('tab', { name: /^Requests/ }).click();
    await shoot(page, 'friends-requests', size);
    await page.getByRole('button', { name: 'Add friend' }).first().click();
    await shoot(page, 'friends-add', size);
  });

  test(`a server's overview at ${size}`, async ({ page }) => {
    await open(page, size, `/app/guilds/${GAME_NIGHT_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Game Night' })).toBeVisible();
    await shoot(page, 'overview', size);
  });

  test(`a server's overview with a banner at ${size}`, async ({ page }) => {
    await open(page, size, `/app/guilds/${BASECAMP_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Basecamp' })).toBeVisible();
    await shoot(page, 'overview-basecamp', size);
  });

  test(`a forum at ${size}`, async ({ page }) => {
    await open(page, size, `/app/guilds/${GAME_NIGHT_ID}/channels/${FORUM_ID}`);
    await shoot(page, 'forum', size);
    await expect(page.getByText('Best loadout for Hazard 5 with three?').first()).toBeVisible();
  });

  test(`a forum post at ${size}`, async ({ page }) => {
    await open(page, size, `/app/guilds/${GAME_NIGHT_ID}/channels/${POST_ID}`);
    await shoot(page, 'forum-post', size);
  });

  test(`a call ringing in a direct message at ${size}`, async ({ page }) => {
    await open(page, size, `/app/dms/${CH.dmBrendan}`, { ringing: true });
    await expect(page.getByText(/is calling you/)).toBeVisible();
    await shoot(page, 'dm-ringing', size);
  });
}

test('the whole overview, in a tall window', async ({ page }) => {
  await openTall(page, `/app/guilds/${GAME_NIGHT_ID}`, 2600);
  await expect(page.getByRole('heading', { level: 1, name: 'Game Night' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, 'overview-long-desktop.png') });
});

test('the whole home, in a tall window', async ({ page }) => {
  await openTall(page, '/app', 1500);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, 'home-long-desktop.png') });
});

/** The frame at the widths between the two shots: fluid column, compact frame. */
for (const [name, width, height, route] of [
  ['home-1024', 1024, 768, '/app'],
  ['friends-1024', 1024, 768, '/app/friends'],
  ['overview-820', 820, 768, `/app/guilds/${GAME_NIGHT_ID}`],
  ['forum-1024', 1024, 768, `/app/guilds/${GAME_NIGHT_ID}/channels/${FORUM_ID}`],
] as const) {
  test(`${name}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await installGlassScene(page);
    await installGlassPages(page);
    await page.goto(route);
    await expect(page.locator('main').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  });
}

test('row states: hover, keyboard focus and the reveal on friends', async ({ page }) => {
  await open(page, 'desktop', '/app/friends');
  await page.getByRole('tab', { name: /^All/ }).click();
  const row = page.getByRole('button', { name: 'Open profile for Nick' });
  await row.hover();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, 'friends-hover-desktop.png') });
  await page.mouse.move(2, 2);
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Open profile for Brendan' }).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'friends-focus-desktop.png') });
});
