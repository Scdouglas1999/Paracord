import { expect, test, type Page } from '@playwright/test';
import { CH, GUILD, ME, installIndexScene, navigate, shoot, sidebar, type IndexHarness } from './fixtures/index';

/**
 * IX-17, area B (long tail): Admin and Developer as pages in main, and the
 * Appearance section of user settings (docs/index-spec.md §6.1, §6.7, §8.1).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-longtail-pages PARACORD_E2E_INDEX_PORT=4656 \
 *   PARACORD_E2E_INDEX_RT_PORT=4658 PARACORD_E2E_INDEX_WP=ix17 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * The scene's user is made an instance admin (flags 1) and the admin and
 * developer APIs the pages call are answered here, so the panels have something
 * to show. Shots land in output/design-reference/index-build/ix17/ and are read:
 * the prototype has no admin or developer page.
 */

/** The scene's first screen, for the tests that start in a conversation. */
const GENERAL = `/app/guilds/${GUILD.fuel.id}/channels/${CH.fuelGeneral}`;

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

const HEADERS = { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const reply = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: HEADERS,
  body: JSON.stringify(body),
});

/** Call an action on one of the app's own stores (the page's module instance, by URL). */
async function callStore(page: Page, module: string, hook: string | null, method: string, ...args: unknown[]) {
  await page.evaluate(
    async ({ module, hook, method, args }) => {
      const mod = (await import(/* @vite-ignore */ module)) as Record<string, any>;
      const target = hook ? mod[hook].getState() : mod;
      void target[method](...args);
    },
    { module, hook, method, args },
  );
}

/** Make the signed-in user an instance admin (or not) for this page. */
async function setAdmin(page: Page, h: IndexHarness, admin: boolean) {
  const record = { ...h.world.userRecord('you'), flags: admin ? 1 : 0 };
  await page.route('**/api/v1/users/@me', (route) => route.fulfill(reply(record)));
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill(reply({ token: 'index-token', refresh_token: 'index-refresh', user: record })),
  );
}

const someUsers = [
  { id: ME.id, username: 'sean', discriminator: 1, email: 'sean@example.test', display_name: 'Sean', avatar_hash: null, flags: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: '310000000000000000', username: 'jeremy', discriminator: 1, email: 'jeremy@example.test', display_name: 'Jeremy', avatar_hash: null, flags: 0, created_at: '2026-02-03T00:00:00Z' },
  { id: '310000000000000009', username: 'vincent', discriminator: 1, email: 'vincent@example.test', display_name: 'Vincent', avatar_hash: null, flags: 0, created_at: '2026-03-09T00:00:00Z' },
  { id: '310000000000000004', username: 'maya', discriminator: 1, email: 'maya@example.test', display_name: 'Maya', avatar_hash: null, flags: 0, created_at: '2026-05-17T00:00:00Z' },
];

const apps = [
  {
    id: '900000000000000001',
    name: 'Release Helper',
    description: 'Posts release notes and checks the build.',
    owner_id: ME.id,
    bot_user_id: '900000000000000002',
    redirect_uri: null,
    permissions: '3072',
    intents: 513,
    created_at: '2026-09-02T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
  },
  {
    id: '900000000000000011',
    name: 'Score Keeper',
    description: null,
    owner_id: ME.id,
    bot_user_id: '900000000000000012',
    redirect_uri: null,
    permissions: '0',
    intents: 0,
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
  },
];

/** Answer the admin, federation, backups, add-ons and developer APIs the pages call. */
async function answerPages(page: Page, guildId: string) {
  const api = (path: string, body: unknown) => page.route(`**/api/v1${path}`, (route) => route.fulfill(reply(body)));
  await api('/admin/health', {
    version: '3.3.0',
    uptime_seconds: 93_600,
    database: { engine: 'sqlite', size_bytes: 48_234_496 },
    storage: { uploads_bytes: 1_203_000_000, media_bytes: 640_000_000 },
    backups: { auto_enabled: true, interval_seconds: 86_400, count: 3, latest_at: '2026-10-01T03:00:00Z', latest_age_hours: 18, total_bytes: 310_000_000 },
    network: {
      bind_address: '0.0.0.0:8090',
      public_url: 'https://paracord.example.test',
      tls_enabled: true,
      tls_self_signed: true,
      registration_open: true,
      registration: 'invite_only',
      federation_enabled: true,
    },
    media: { native_enabled: true, native_port: 8443, livekit_available: false },
    counts: { users: 42, guilds: 3, messages: 18_204, channels: 21, online_users: 5 },
    checks: [
      { id: 'tls', severity: 'critical', title: 'The certificate is self-signed', detail: 'People will see a warning when they connect. Add a certificate from a trusted authority.' },
      { id: 'backup', severity: 'warning', title: 'The newest backup is a day old', detail: 'Automatic backups are on, and the last one finished 18 hours ago.' },
      { id: 'version', severity: 'info', title: 'This is the newest release', detail: 'You are running 3.3.0.' },
    ],
  });
  await api('/admin/users**', { users: someUsers, total: 4, cursor: null, next_cursor: null, offset: null, limit: 25 });
  await api('/admin/guilds', {
    guilds: [
      { id: guildId, name: 'Fuel', description: 'Where we plan the night.', icon_hash: null, owner_id: ME.id, visibility: 'private', created_at: '2026-10-01T00:00:00Z' },
      { id: GUILD.gameNight.id, name: 'Game Night', description: null, icon_hash: null, owner_id: ME.id, visibility: 'public', created_at: '2026-08-14T00:00:00Z' },
      { id: GUILD.basecamp.id, name: 'Basecamp', description: 'Test builds and notes.', icon_hash: null, owner_id: ME.id, visibility: 'private', created_at: '2026-07-02T00:00:00Z' },
    ],
  });
  await api('/admin/settings', {
    server_name: 'Index',
    server_description: 'A place to play together.',
    registration_enabled: 'true',
    registration_mode: 'invite_only',
    max_guilds_per_user: '100',
    max_members_per_guild: '1000',
    federation_file_cache_enabled: 'false',
  });
  await api('/admin/network', { running: false, saved: false, restart_required: false, loopback_bind: false });
  await api('/admin/security-events**', [
    { id: '1', actor_user_id: ME.id, action: 'auth.login', target_user_id: null, session_id: 's-1', device_id: 'd-1', user_agent: 'Paracord/3.3', ip_address: '192.168.1.20', details: { method: 'password' }, created_at: '2026-10-01T20:55:00Z' },
    { id: '2', actor_user_id: ME.id, action: 'admin.user.update', target_user_id: '310000000000000000', session_id: 's-1', device_id: null, user_agent: null, ip_address: '192.168.1.20', details: null, created_at: '2026-10-01T21:02:00Z' },
  ]);
  await api('/admin/backups', {
    backups: [
      { name: 'paracord-2026-10-01T03-00-00.tar.gz', size_bytes: 104_857_600, created_at: '2026-10-01T03:00:00Z' },
      { name: 'paracord-2026-09-30T03-00-00.tar.gz', size_bytes: 103_000_000, created_at: '2026-09-30T03:00:00Z' },
    ],
  });
  await api('/admin/addons', { local_network_allowed: false, twitch_client_id: null, twitch_secret_set: false, feeds_per_server: 10 });
  await page.route('**/_paracord/federation/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/moderation/state')) {
      return route.fulfill(reply({ states: [{ server_name: 'quiet.example.net', mode: 'quarantine', reason: 'Spam wave', quarantined_until_ms: null, updated_at_ms: 1_790_000_000_000 }] }));
    }
    if (path.endsWith('/moderation/subscriptions')) return route.fulfill(reply({ subscriptions: [] }));
    if (path.endsWith('/servers')) {
      return route.fulfill(
        reply({
          servers: [
            { id: 'f1', server_name: 'friends.example.org', domain: 'friends.example.org', federation_endpoint: 'https://friends.example.org/_paracord/federation/v1', public_key_hex: 'ab12', key_id: 'k1', trusted: true, last_seen_at: '2026-10-01T20:00:00Z', created_at: '2026-09-01T00:00:00Z' },
            { id: 'f2', server_name: 'quiet.example.net', domain: 'quiet.example.net', federation_endpoint: 'https://quiet.example.net/_paracord/federation/v1', public_key_hex: null, key_id: null, trusted: false, last_seen_at: null, created_at: '2026-09-12T00:00:00Z' },
          ],
        }),
      );
    }
    return route.fulfill(reply({}));
  });

  // The developer portal.
  await api('/bots/applications', apps);
  await page.route('**/api/v1/bots/applications/*/installs', (route) =>
    route.fulfill(reply([{ bot_app_id: apps[0].id, guild_id: GUILD.gameNight.id, added_by: ME.id, permissions: '3072', created_at: '2026-09-10T00:00:00Z' }])),
  );
  await page.route('**/api/v1/bots/applications/*/token', (route) => route.fulfill(reply({ ...apps[0], token: 'pc.example-token.not-a-real-secret' })));
  await page.route('**/api/v1/applications/*/commands', (route) =>
    route.fulfill(reply([{ id: 'c1', application_id: apps[0].id, name: 'roll', description: 'Roll some dice', type: 1, options: [], created_at: '2026-09-11T00:00:00Z' }])),
  );
  await page.route('**/api/v1/bot-store/**', (route) => route.fulfill(reply({})));
}

async function open(page: Page, route: string, options: { admin?: boolean; viewport?: { width: number; height: number } } = {}): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize(options.viewport ?? { width: 1440, height: 900 });
  const h = await installIndexScene(page);
  await setAdmin(page, h, options.admin ?? true);
  await answerPages(page, GUILD.fuel.id);
  await h.open(route);
  await expect(sidebar(page)).toBeVisible();
  return h;
}

const ADMIN_TABS = ['Overview', 'Users', 'Servers', 'Federation', 'Settings', 'Add-ons', 'Security', 'Backups'] as const;
const slug = (label: string) => label.toLowerCase().replace(/[^a-z]/g, '');

async function openTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe('Admin (§6.1, §8.1)', () => {
  test('a page in main: the large title, the sections as a segmented control, every tab', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, '/app/admin');
    await expect(page.getByTestId('ix-title')).toHaveText('Admin');
    await expect(page.getByRole('tablist', { name: 'Administration sections' })).toBeVisible();
    // One tab stop: the chosen tab, with the rest at tabindex -1.
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('tab', { name: 'Users', exact: true })).toHaveAttribute('tabindex', '-1');
    // The title is 36/700 in the column, like every other page.
    await expect(page.getByTestId('ix-title')).toHaveCSS('font-size', '36px');
    await expect(page.getByTestId('ix-title')).toHaveCSS('font-weight', '700');
    for (const label of ADMIN_TABS) {
      await openTab(page, label);
      if (label === 'Users') {
        // A face, never initials on an identity color.
        await expect(page.locator('[data-testid="ix-admin"] table .ix-av')).toHaveCount(someUsers.length);
        const letters = await page.locator('[data-testid="ix-admin"] table .ix-av').allTextContents();
        expect(letters.sort()).toEqual(['J', 'M', 'S', 'V']);
      }
      if (label === 'Servers') await expect(page.locator('[data-testid="ix-admin"] table .ix-sq')).toHaveCount(3);
      await shoot(page, `admin-${slug(label)}`, { size: 'desktop', settle: 300 });
    }
    await expect(page.getByText(/Back to home/i)).toHaveCount(0);
  });

  test('the sections scroll sideways, never wrap, in a narrow window', async ({ page }) => {
    await open(page, '/app/admin', { viewport: { width: 900, height: 700 } });
    const tabs = page.locator('.ix-adm__tabs');
    await expect(tabs).toBeVisible();
    const tops = await page.getByRole('tab').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size, 'every tab on one row').toBe(1);
    const geometry = await tabs.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(geometry.scroll).toBeGreaterThanOrEqual(geometry.client);
    await shoot(page, 'admin-overview', { size: 'narrow', settle: 300 });
  });

  test('on a phone', async ({ page }) => {
    await open(page, '/app/admin', { viewport: { width: 390, height: 844 } });
    await expect(page.getByTestId('ix-title')).toHaveText('Admin');
    await openTab(page, 'Users');
    await shoot(page, 'admin-users', { size: 'phone', settle: 300 });
  });

  test('Esc and the toolbar back chevron go back to the place you came from', async ({ page }) => {
    await open(page, GENERAL);
    // From the channel, to Admin without a reload (the router keeps its history).
    await navigate(page, '/app/admin');
    await expect(page.getByTestId('ix-title')).toHaveText('Admin');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD.fuel.id}/channels/`));
    await navigate(page, '/app/admin');
    await expect(page.getByTestId('ix-title')).toHaveText('Admin');
    await page.locator('.ix-main').click({ position: { x: 700, y: 400 } });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD.fuel.id}/channels/`));
  });

  test('a member who is not an admin is told so, with one way out', async ({ page }) => {
    await open(page, '/app/admin', { admin: false });
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await shoot(page, 'admin-denied', { size: 'desktop', settle: 300 });
    await page.getByRole('button', { name: 'Back', exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/app/guilds/`));
  });
});

test.describe('Developer portal (§6.1, §8.1)', () => {
  test('empty, with an application, with the command builder', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, '/app/developers');
    await expect(page.getByTestId('ix-title')).toHaveText(/Developer/);
    await expect(page.getByRole('tablist', { name: 'Your applications' })).toBeVisible();
    // The create form is first; every application is a segment.
    await expect(page.getByRole('tab', { name: 'New application' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Release Helper' })).toBeVisible();
    await page.waitForTimeout(400);
    await shoot(page, 'dev-new', { size: 'desktop', settle: 300 });

    await page.getByRole('tab', { name: 'Release Helper' }).click();
    await expect(page.locator('.ix-av').first()).toBeVisible();
    await page.getByRole('button', { name: 'Regen token' }).click();
    // The confirm is the shared dialog.
    await page.getByRole('alertdialog').getByRole('button', { name: 'Regenerate' }).click();
    await expect(page.getByText('pc.example-token.not-a-real-secret')).toBeVisible();
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shoot(page, 'dev-app', { size: 'desktop', settle: 300 });

    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByRole('tab', { name: 'Commands' }).click();
    await page.getByRole('button', { name: 'New command' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('tab', { name: 'Commands' }).scrollIntoViewIfNeeded();
    await shoot(page, 'dev-commands', { size: 'desktop', settle: 300 });
    await page.getByRole('tab', { name: 'Intents' }).click();
    await page.waitForTimeout(300);
    await shoot(page, 'dev-intents', { size: 'desktop', settle: 300 });
    await expect(page.getByText(/Back to home/i)).toHaveCount(0);
  });

  test('on a phone', async ({ page }) => {
    await open(page, '/app/developers', { viewport: { width: 390, height: 844 } });
    await page.getByRole('tab', { name: 'Release Helper' }).click();
    await page.waitForTimeout(400);
    await shoot(page, 'dev-app', { size: 'phone', settle: 300 });
  });
});

test.describe('Appearance (§6.7)', () => {
  test('High contrast, Transparency, Motion, Density, language and Custom CSS', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, GENERAL);
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', true, 'appearance');
    await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
    await page.waitForTimeout(450);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.getByRole('switch', { name: 'High contrast' })).toBeVisible();
    await expect(page.getByRole('radiogroup')).toHaveCount(2);
    // No stream reactions anywhere, in the Motion copy or elsewhere on the page.
    await expect(page.getByText(/floating reactions/i)).toHaveCount(0);
    await shoot(page, 'appearance-top', { size: 'desktop', settle: 300 });
    await page.locator('.ix-settings__scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(300);
    await shoot(page, 'appearance-bottom', { size: 'desktop', settle: 300 });
  });
});
