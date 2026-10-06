import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { installIndexScene, shoot, sidebar, type IndexHarness } from './fixtures/index';

/**
 * A saved server you cannot see yet (docs/index-spec.md §4.1 list states, §6.8 strips,
 * §6.12 dialog): the sidebar says where its server stands, and the app gets it back by
 * itself or asks you to sign in.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-connection PARACORD_E2E_INDEX_PORT=4903 \
 *   PARACORD_E2E_INDEX_RT_PORT=4905 PARACORD_E2E_INDEX_WP=ixconn \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * The scene's own servers come from the home session as always. A second saved
 * server, "Lantern" at http://lantern.test, is added to the server list; every request
 * to it is answered (or refused, or left hanging) by the script below, so each state
 * is the real connection manager reacting to a server that behaves that way. Whether a
 * real server is then held is the real-server suite's business
 * (`real-server.session-recovery.spec.ts`).
 */

const LANTERN = 'http://lantern.test';
const LANTERN_GUILD = '365660281080123392';
const LANTERN_ROUTE = `/app/guilds/${LANTERN_GUILD}/channels/365660281080123393`;

type Mode = 'hang' | 'down' | 'refused' | 'healthy';

interface LanternLog {
  refreshBodies: unknown[];
  logins: unknown[];
  meTokens: string[];
}

/** Script http://lantern.test. Returns a setter for its behavior and what it was asked. */
async function scriptLantern(page: Page, initial: Mode): Promise<{ set: (mode: Mode) => void; log: LanternLog }> {
  let mode = initial;
  const log: LanternLog = { refreshBodies: [], logins: [], meTokens: [] };
  const valid = new Set<string>();
  const hung: Route[] = [];
  // A cross-origin server: every answer carries CORS for the app's origin, as a real one does.
  let origin = '*';
  const cors = () => ({
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, content-type, x-paracord-csrf, x-paracord-history-epoch',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-expose-headers': 'x-paracord-history-epoch, x-paracord-trace-id',
  });
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: cors(), body: JSON.stringify(body) });
  const unauthorized = (route: Route) => json(route, 401, { code: 'UNAUTHORIZED', message: 'unauthorized' });

  await page.route(`${LANTERN}/**`, async (route: Route, request: Request) => {
    const { pathname } = new URL(request.url());
    origin = request.headers().origin ?? origin;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(), body: '' });
    if (mode === 'hang') {
      hung.push(route);
      return;
    }
    if (mode === 'down') return route.abort('connectionrefused');
    if (pathname === '/health') return json(route, 200, { service: 'paracord', status: 'ok' });
    if (pathname === '/api/v1/auth/refresh') {
      log.refreshBodies.push(request.postDataJSON());
      if (mode === 'refused') return unauthorized(route);
      valid.add('lan-access-2');
      return json(route, 200, { token: 'lan-access-2', refresh_token: 'lan-refresh-2' });
    }
    if (pathname === '/api/v1/auth/login') {
      log.logins.push(request.postDataJSON());
      valid.add('lan-access-signed-in');
      mode = 'healthy';
      return json(route, 200, { token: 'lan-access-signed-in', refresh_token: 'lan-refresh-signed-in', user: { id: '1' } });
    }
    const token = (request.headers().authorization ?? '').replace(/^Bearer /, '');
    if (pathname === '/api/v1/users/@me') log.meTokens.push(token);
    if (!valid.has(token)) return unauthorized(route);
    // Far enough to show the server answering; the realtime stream itself is the
    // real-server suite's to hold, so the session is left unanswered here.
    if (pathname === '/api/v1/users/@me') return json(route, 503, { code: 'UNAVAILABLE', message: 'later' });
    return json(route, 503, { code: 'UNAVAILABLE', message: 'later' });
  });
  return {
    set: (next) => {
      mode = next;
      for (const route of hung.splice(0)) void route.abort('connectionrefused').catch(() => {});
    },
    log,
  };
}

/** Add Lantern to the saved servers with an expired access token, as a relaunch finds it. */
async function addLantern(page: Page, credential: { token: string | null; refreshToken: string | null }) {
  await page.evaluate(
    async ({ url, credential }) => {
      const { useServerListStore } = (await import('/src/stores/serverListStore.ts' as string)) as typeof import('../src/stores/serverListStore');
      const state = useServerListStore.getState();
      useServerListStore.setState({
        activeServerId: 's_lantern',
        servers: [
          ...state.servers,
          { id: 's_lantern', name: 'Lantern', url, token: credential.token, refreshToken: credential.refreshToken, connected: false },
        ],
      });
    },
    { url: LANTERN, credential },
  );
}

async function openLantern(page: Page, h: IndexHarness): Promise<void> {
  await h.open(h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
}

const unavailable = (page: Page) => page.getByTestId('ix-server-unavailable');

/** Go to Lantern's channel inside the app (no reload: the saved server lives in memory on the web). */
async function goToLantern(page: Page) {
  await page.evaluate((route) => {
    window.history.pushState({}, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, LANTERN_ROUTE);
}

test.describe('a saved server that is not connected yet', () => {
  test('says it is connecting while the first connect is under way, never "not available"', async ({ page }) => {
    const h = await installIndexScene(page);
    await scriptLantern(page, 'hang');
    await openLantern(page, h);
    await addLantern(page, { token: 'lan-access-expired', refreshToken: 'lan-refresh-1' });
    await goToLantern(page);

    await expect(unavailable(page)).toHaveAttribute('data-state', 'connecting');
    await expect(unavailable(page)).toHaveText('Connecting to Lantern…');
    await expect(page.getByText('This server is not available.')).toHaveCount(0);
    // Main waits too: nothing says the channel is gone while its server has not answered.
    await expect(page.getByTestId('ix-loading')).toBeVisible();
    await expect(page.getByText('This channel is gone')).toHaveCount(0);
    await shoot(page, 'conn-connecting', { wp: process.env.PARACORD_E2E_INDEX_WP ?? 'ixconn' });
  });

  test('an unreachable server is retried by itself, and Try now asks at once', async ({ page }) => {
    const h = await installIndexScene(page);
    const lantern = await scriptLantern(page, 'down');
    await openLantern(page, h);
    await addLantern(page, { token: 'lan-access-expired', refreshToken: 'lan-refresh-1' });
    await goToLantern(page);

    await expect(unavailable(page)).toHaveAttribute('data-state', 'retrying');
    await expect(unavailable(page)).toContainText('Can’t reach Lantern right now. Trying again.');
    await expect(page.getByTestId('ix-loading')).toBeVisible();
    // The selected server is the one that is away: nothing asks it for anything meanwhile.
    await expect(page.getByText(/Failed to load relationships/)).toHaveCount(0);
    await shoot(page, 'conn-retrying', { wp: process.env.PARACORD_E2E_INDEX_WP ?? 'ixconn' });

    // It comes back: the expired access token is refreshed silently, with the saved refresh token.
    lantern.set('healthy');
    await page.getByRole('button', { name: 'Try now' }).click();
    await expect.poll(() => lantern.log.refreshBodies).toEqual([{ refresh_token: 'lan-refresh-1' }]);
    await expect.poll(() => lantern.log.meTokens.at(-1)).toBe('lan-access-2');
    await expect(unavailable(page)).not.toHaveAttribute('data-state', 'signed-out');
  });

  test('a refused session shows Sign in again, and signing in connects without a restart', async ({ page }) => {
    const h = await installIndexScene(page);
    const lantern = await scriptLantern(page, 'refused');
    await openLantern(page, h);
    await addLantern(page, { token: 'lan-access-expired', refreshToken: 'lan-refresh-revoked' });
    await goToLantern(page);

    await expect(unavailable(page)).toHaveAttribute('data-state', 'signed-out');
    await expect(unavailable(page)).toContainText('You’re signed out of Lantern.');
    await expect(page.getByTestId('ix-server-signed-out')).toContainText('You’re signed out of Lantern');
    const banner = page.getByTestId('ix-banner-signed-out');
    await expect(banner).toHaveText(/You’re signed out of Lantern\.\s*Sign in again/);
    await shoot(page, 'conn-signed-out', { wp: process.env.PARACORD_E2E_INDEX_WP ?? 'ixconn' });

    // Nothing retries a refused session on its own.
    const asked = lantern.log.refreshBodies.length;
    await page.waitForTimeout(2_500);
    expect(lantern.log.refreshBodies.length).toBe(asked);

    await unavailable(page).getByRole('button', { name: 'Sign in again' }).click();
    const dialog = page.getByTestId('ix-signin-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Sign in to Lantern' })).toBeVisible();
    await dialog.getByLabel('Email or username').fill('owner');
    await dialog.getByLabel('Password').fill('Correct-Horse-Battery-9');
    await shoot(page, 'conn-sign-in-dialog', { wp: process.env.PARACORD_E2E_INDEX_WP ?? 'ixconn' });
    await dialog.getByRole('button', { name: 'Sign in' }).click();

    await expect(dialog).toBeHidden();
    expect(lantern.log.logins).toEqual([{ identifier: 'owner', password: 'Correct-Horse-Battery-9' }]);
    // The new session is used at once: the server is asked who you are with it.
    await expect.poll(() => lantern.log.meTokens.at(-1)).toBe('lan-access-signed-in');
    await expect(banner).toHaveCount(0);
    await expect(unavailable(page)).not.toHaveAttribute('data-state', 'signed-out');
  });
});
