import { expect, test, type Page, type Route } from '@playwright/test';
import { installIndexScene, shoot, sidebar } from './fixtures/index';

/**
 * A saved server whose certificate changed (docs/setup-spec.md §7.4): the sidebar
 * says "Identity changed" with Review, and Review opens the identity-changed sheet
 * with the old and new trust words.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-identity-changed PARACORD_E2E_INDEX_PORT=4963 \
 *   PARACORD_E2E_INDEX_RT_PORT=4965 PARACORD_E2E_INDEX_WP=s10 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * A browser has no certificate pins: the desktop shell is the only thing that can
 * announce a change. The scene records the change the shell would have announced
 * (`trust://identity-changed`) in the renderer's store, and the real connection
 * manager does the rest: the saved server's next failed connect is classified as
 * an identity change, not a network failure, and nothing retries it.
 */

const LANTERN = 'http://lantern.test';
const LANTERN_ROUTE = '/app/guilds/365660281080123392/channels/365660281080123393';
const OLD_FP = '00'.repeat(32);
const NEW_FP = 'ff'.repeat(32);

async function lanternIsAway(page: Page): Promise<{ asked: () => number }> {
  let asked = 0;
  await page.route(`${LANTERN}/**`, async (route: Route) => {
    asked += 1;
    await route.abort('connectionrefused');
  });
  return { asked: () => asked };
}

async function addLanternWithChangedIdentity(page: Page) {
  await page.evaluate(
    async ({ url, oldFp, newFp }) => {
      const { useIdentityChangeStore } = (await import('/src/lib/trustedHosts.ts' as string)) as typeof import('../src/lib/trustedHosts');
      useIdentityChangeStore.getState().record({ host: 'lantern.test', pinnedFp: oldFp, presentedFp: newFp });
      const { useServerListStore } = (await import('/src/stores/serverListStore.ts' as string)) as typeof import('../src/stores/serverListStore');
      const state = useServerListStore.getState();
      useServerListStore.setState({
        activeServerId: 's_lantern',
        servers: [
          ...state.servers,
          { id: 's_lantern', name: 'Lantern', url, token: 'lan-access', refreshToken: 'lan-refresh', connected: false },
        ],
      });
    },
    { url: LANTERN, oldFp: OLD_FP, newFp: NEW_FP },
  );
}

async function goToLantern(page: Page) {
  await page.evaluate((route) => {
    window.history.pushState({}, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, LANTERN_ROUTE);
}

test('a changed identity is reviewed, not retried', async ({ page }) => {
  const h = await installIndexScene(page);
  const lantern = await lanternIsAway(page);
  await h.open(h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  await addLanternWithChangedIdentity(page);
  await goToLantern(page);

  const unavailable = page.getByTestId('ix-server-unavailable');
  await expect(unavailable).toHaveAttribute('data-state', 'identity-changed');
  await expect(unavailable).toContainText('Identity changed. Lantern stays disconnected until you review it.');
  await expect(page.getByTestId('ix-banner-identity-changed')).toContainText(
    'Lantern has a new identity. It stays disconnected until you review it.',
  );
  const wp = process.env.PARACORD_E2E_INDEX_WP ?? 's10';
  await shoot(page, 'identity-changed-sidebar', { wp });

  // Nothing retries an identity change on its own.
  const asked = lantern.asked();
  await page.waitForTimeout(3_000);
  expect(lantern.asked()).toBe(asked);

  await unavailable.getByRole('button', { name: 'Review' }).click();
  const sheet = page.getByTestId('identity-changed-sheet');
  await expect(sheet.getByRole('heading', { name: 'Lantern has a new identity' })).toBeVisible();
  await expect(sheet.getByTestId('identity-old-words')).toHaveText('injury · burden · fortune · boil');
  await expect(sheet.getByTestId('identity-new-words')).toHaveText('student · deposit · glance · slight');
  await expect(sheet.getByRole('button', { name: 'Stay disconnected' })).toBeFocused();
  await shoot(page, 'identity-changed-sheet', { wp });

  await shoot(page, 'identity-changed-sheet', { wp, size: 'phone' });
  await page.setViewportSize({ width: 1280, height: 800 });

  await sheet.getByRole('button', { name: 'Stay disconnected' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(unavailable).toHaveAttribute('data-state', 'identity-changed');
});

/**
 * Bug F1 (setup-s15-checkpoint.md §4.2): the server a person joined through the
 * first run is the home server (`__local__`, no entry in the server list), and a
 * certificate change on it used to leave the app on "Reconnecting…" forever.
 * Here the scene's own server is that home server: its stream drops, the shell
 * has recorded the change (as `trust://identity-changed` would), and the
 * stream's setup is refused, as the shell refuses a pinned host that presents
 * another certificate.
 */
test('the first run server whose identity changed is reviewed, not retried', async ({ page }) => {
  const h = await installIndexScene(page);
  await h.open(h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();

  const home = new URL(page.url());
  let setups = 0;
  await page.route('**/api/v2/rt/session', async (route) => {
    setups += 1;
    await route.abort('connectionrefused');
  });
  await page.evaluate(
    async ({ host, oldFp, newFp }) => {
      const { useIdentityChangeStore } = (await import('/src/lib/trustedHosts.ts' as string)) as typeof import('../src/lib/trustedHosts');
      useIdentityChangeStore.getState().record({ host, pinnedFp: oldFp, presentedFp: newFp });
    },
    { host: home.hostname, oldFp: OLD_FP, newFp: NEW_FP },
  );
  await h.stub.drop();

  const banner = page.getByTestId('ix-banner-identity-changed');
  await expect(banner).toContainText(`${home.host} has a new identity. It stays disconnected until you review it.`);
  // "Connection lost, retrying automatically" would not be true.
  await page.waitForTimeout(4_500);
  await expect(page.getByTestId('ix-banner-connection')).toHaveCount(0);
  const wp = process.env.PARACORD_E2E_INDEX_WP ?? 's10';
  await shoot(page, 'identity-changed-home-banner', { wp });

  // Nothing retries an identity change on its own.
  const tried = setups;
  await page.waitForTimeout(3_000);
  expect(setups).toBe(tried);

  await banner.getByRole('button', { name: 'Review' }).click();
  const sheet = page.getByTestId('identity-changed-sheet');
  await expect(sheet.getByRole('heading', { name: `${home.host} has a new identity` })).toBeVisible();
  await expect(sheet.getByTestId('identity-old-words')).toHaveText('injury · burden · fortune · boil');
  await expect(sheet.getByTestId('identity-new-words')).toHaveText('student · deposit · glance · slight');
  await expect(sheet.getByRole('button', { name: 'Stay disconnected' })).toBeFocused();
  await shoot(page, 'identity-changed-home-sheet', { wp });

  await sheet.getByRole('button', { name: 'Stay disconnected' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(banner).toBeVisible();
  expect(setups).toBe(tried);
});
