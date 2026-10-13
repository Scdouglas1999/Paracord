import { expect, test, type Page, type Route } from '@playwright/test';
import { installIndexScene, shoot, sidebar, type SizeName } from './fixtures/index';
import { Permissions } from '../src/types/permissions.types';

/**
 * IX-17, area A: the entry and onboarding pages on Index (docs/index-spec.md §6.14):
 * login, register, connect, the first-owner claim, account setup / unlock /
 * recover, an invite, the bot authorization page, terms and privacy, and the
 * onboarding wizard. The ground with the main glow at hue 210, one centered
 * 400px column, fields 44 tall, ONE cream button per page.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-longtail-auth PARACORD_E2E_INDEX_PORT=4647 \
 *   PARACORD_E2E_INDEX_RT_PORT=4649 PARACORD_E2E_INDEX_WP=ix17 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Shots land in output/design-reference/index-build/ix17/ as `auth-<page>@WxH.png`
 * (1440x900 and 390x844). The prototype has no entry page, so they are held
 * against the spec text and read, not diffed. Mocked like auth-fit.spec.ts:
 * nothing here touches a server.
 */

const CREAM = 'rgb(244, 242, 237)';
const SIZES: SizeName[] = ['desktop', 'phone'];

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

const user = {
  id: '42',
  username: 'ada',
  display_name: 'Ada Lovelace',
  discriminator: 1,
  avatar_hash: null,
  banner_hash: null,
  accent_color: null,
  bio: null,
  pronouns: null,
  email: 'ada@example.test',
  email_verified: true,
  has_public_key: false,
  public_key: null,
  linked_accounts: [],
  bot: false,
  system: false,
  flags: 0,
  created_at: '2026-10-01T00:00:00Z',
};

/** What the signed-out entry screens ask the server (the same answers as auth-fit.spec.ts). */
async function signedOut(
  page: Page,
  options: { setupRequired?: boolean; storage?: Record<string, string> } = {},
): Promise<void> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((storage) => {
    try {
      window.localStorage.clear();
      for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }, options.storage ?? {});
  await page.route('**/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (pathname === '/api/v1/auth/refresh') return json(401, { message: 'No session' });
    if (pathname === '/api/v1/auth/options') return json(200, { allow_username_login: true, require_email: false });
    if (pathname === '/api/v1/setup/status')
      return json(200, { setup_required: options.setupRequired ?? false, instance_name: 'Riverside Studio' });
    if (pathname === '/api/v1/setup/password-requirements')
      return json(200, {
        min_length: 10,
        max_length: 128,
        length_unit: 'utf8_bytes',
        requires_uppercase: true,
        requires_lowercase: true,
        requires_digit: true,
        requires_symbol: true,
      });
    if (pathname === '/api/v1/instance')
      return json(200, {
        max_upload_size: 26_214_400,
        p2p_threshold: 8_388_608,
        setup_required: options.setupRequired ?? false,
        instance_name: 'Riverside Studio',
      });
    if (pathname === '/api/v1/invites/kestrel')
      return json(200, {
        code: 'kestrel',
        guild: { id: '1001', name: 'Kestrel Robotics', icon_hash: null, member_count: 24, description: null },
        channel: { id: '2001', name: 'build-log' },
        inviter: user,
        approximate_member_count: 24,
        approximate_presence_count: 9,
        expires_at: null,
        max_uses: 0,
        uses: 3,
      });
    return json(200, []);
  });
}

/** The measurements every entry page is held to (§6.14). */
async function expectIndexAuth(page: Page, name: string, size: SizeName, options: { column?: number | null } = {}) {
  const canvas = page.locator('.ix-auth').first();
  await expect(canvas, `${name}: the ground`).toBeVisible();
  // The main glow at hue 210: a radial gradient over the main color, in People's hue.
  await expect.soft(canvas).toHaveCSS('--ix-hue', '210');
  const background = await canvas.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect.soft(background, `${name}: the main glow`).toContain('radial-gradient');
  // One centered column of 400 at the desktop width.
  if (size === 'desktop' && options.column !== null) {
    const col = await page.locator('.ix-auth__col').first().boundingBox();
    expect.soft(col?.width, `${name}: the column`).toBe(options.column ?? 400);
    const viewport = page.viewportSize()!;
    expect.soft(Math.abs((col!.x + col!.width / 2) - viewport.width / 2), `${name}: centered`).toBeLessThan(2);
  }
  // Fields are 44 tall at radius 12.
  const fields = await page
    .locator('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file])')
    .evaluateAll((inputs) =>
      inputs
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const holder = el.closest('.pc-field, .input-field') ?? el;
          // The layout height: a step that is arriving is scaled for 240ms, and a rect would report that.
          return { id: (el as HTMLInputElement).id || (el as HTMLInputElement).placeholder, height: (holder as HTMLElement).offsetHeight, radius: getComputedStyle(holder).borderTopLeftRadius };
        }),
    );
  for (const field of fields) {
    expect.soft(field.height, `${name}: a field is 44 tall (${field.id})`).toBe(44);
    expect.soft(field.radius, `${name}: a field has radius 12`).toBe('12px');
  }
  // Exactly one cream button on the page.
  const cream = await page.evaluate((color) => {
    return [...document.querySelectorAll('button, a')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => getComputedStyle(el).backgroundColor === color).length;
  }, CREAM);
  expect.soft(cream, `${name}: one cream button`).toBe(1);
  // No Glass pane, no uppercase kicker.
  expect.soft(await page.locator('.glass-pane, .glass-kicker, .pc-plate').count(), `${name}: no Glass leftovers`).toBe(0);
}

async function shotBoth(page: Page, name: string, size: SizeName) {
  await shoot(page, `auth-${name}`, { size, settle: 350 });
}

for (const size of SIZES) {
  test.describe(`entry pages at ${size}`, () => {
    test('login, and its four other views', async ({ page }) => {
      await signedOut(page);
      await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await expectIndexAuth(page, 'login', size);
      await shotBoth(page, 'login', size);
      // A failed attempt: the error is the danger ink with its glyph, in the column.
      await page.route('**/api/v1/auth/login', (route) =>
        route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"unauthorized"}' }),
      );
      await page.getByLabel('Email or Username').fill('ada');
      await page.getByLabel('Password').fill('wrong password');
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(page.getByRole('alert')).toContainText('Login failed');
      await shotBoth(page, 'login-error', size);
      await page.getByRole('button', { name: 'Forgot your password?' }).click();
      await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
      await expectIndexAuth(page, 'login-forgot', size);
      await shotBoth(page, 'login-forgot', size);
      await page.getByRole('button', { name: 'Enter token' }).click();
      await expect(page.getByRole('heading', { name: 'Set new password' })).toBeVisible();
      await shotBoth(page, 'login-reset', size);
    });

    test('register, step by step', async ({ page }) => {
      await signedOut(page);
      await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await page.goto('/register');
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
      await expectIndexAuth(page, 'register', size);
      await shotBoth(page, 'register', size);
      await page.getByLabel(/Username/).first().fill('ada');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText(/Step 2 of 2/)).toBeVisible();
      await page.getByLabel(/^Password/).first().fill('Riverside-123!');
      await page.getByLabel(/Confirm password/).fill('Riverside-123!');
      await expectIndexAuth(page, 'register-2', size);
      await shotBoth(page, 'register-2', size);
    });

    // The connect page, the first-owner wizard and the old invite page were
    // retired by the first run (docs/setup-spec.md §1.14, S13): `/connect`
    // only redirects, and `/setup-server` (claim mode) and `/invite/:code`
    // (the web join) are first-run screens with their own design, reviewed in
    // e2e/setup-s13.spec.ts against the prototype, not Index entry pages.

    test('account setup, unlock and recover', async ({ page }) => {
      await signedOut(page, { storage: { 'paracord:account:exists': '1' } });
      await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await page.goto('/setup');
      await expect(page.getByText(/local identity/i).first()).toBeVisible();
      await expectIndexAuth(page, 'account-setup', size);
      await shotBoth(page, 'account-setup', size);

      await page.goto('/unlock');
      await expect(page.getByRole('button', { name: /Unlock/ }).first()).toBeVisible();
      await expectIndexAuth(page, 'account-unlock', size);
      await shotBoth(page, 'account-unlock', size);

      await page.goto('/recover');
      await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
      await expectIndexAuth(page, 'account-recover', size);
      await shotBoth(page, 'account-recover', size);
    });

    test('terms and privacy', async ({ page }) => {
      await signedOut(page);
      await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await page.goto('/terms');
      await expect(page.getByRole('heading', { name: /Terms/ }).first()).toBeVisible();
      await expect(page.locator('.pc-plate')).toHaveCount(0);
      await shotBoth(page, 'terms', size);
      await page.goto('/privacy');
      await expect(page.getByRole('heading', { name: /Privacy/ }).first()).toBeVisible();
      await shotBoth(page, 'privacy', size);
    });
  });
}

const BOT_ID = '9001';

async function answerBot(page: Page) {
  const json = (route: Route, payload: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  await page.route(`**/api/v1/bots/applications/${BOT_ID}/public`, (route) =>
    json(route, {
      id: BOT_ID,
      name: 'Scorekeeper',
      description: 'Keeps the score for your game nights and posts the standings.',
      bot_user_id: '9002',
      permissions: '0',
      redirect_uri: null,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      bot_user: { id: '9002', username: 'scorekeeper', discriminator: 1, display_name: 'Scorekeeper', avatar_hash: null },
    }),
  );
  await page.route(`**/api/v1/bots/store/${BOT_ID}/reviews**`, (route) =>
    json(route, {
      reviews: [{ id: 'r1', rating: 5, body: 'Never loses count.', created_at: '2026-09-02T00:00:00Z' }],
      summary: { review_count: 1, average_rating: 5 },
      total: 1,
    }),
  );
}

for (const size of SIZES) {
  test(`bot authorize at ${size}`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    const h = await installIndexScene(page);
    await answerBot(page);
    const bits =
      Permissions.MANAGE_MESSAGES |
      Permissions.KICK_MEMBERS |
      Permissions.MANAGE_EMOJIS |
      Permissions.VIEW_CHANNEL |
      Permissions.SEND_MESSAGES |
      Permissions.ADD_REACTIONS |
      Permissions.CONNECT |
      Permissions.SPEAK;
    await h.open(`/app/oauth2/authorize?client_id=${BOT_ID}&permissions=${bits.toString()}`);
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Add a bot to your server' })).toBeVisible();
    await expect(page.getByText('Never loses count.')).toBeVisible();
    await expect(page.locator('.glass-pane, .glass-kicker, .pc-plate')).toHaveCount(0);
    const cream = await page.evaluate((color) => {
      return [...document.querySelectorAll('main button, main a')]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => getComputedStyle(el).backgroundColor === color).length;
    }, CREAM);
    expect(cream, 'bot authorize: one cream button').toBe(1);
    await shotBoth(page, 'bot-authorize', size);
  });
}

for (const size of SIZES) {
  test(`account setup shows the recovery phrase at ${size}`, async ({ page }) => {
    await signedOut(page);
    await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    await page.goto('/setup');
    await page.getByLabel(/^Username/).fill('ada');
    await page.getByLabel(/^Password/).fill('Riverside-123!');
    await page.getByLabel(/Confirm password/).fill('Riverside-123!');
    await page.getByRole('button', { name: 'Create identity' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery phrase' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Never share these words.')).toBeVisible();
    await expectIndexAuth(page, 'account-setup-phrase', size);
    await shotBoth(page, 'account-setup-phrase', size);
  });
}
