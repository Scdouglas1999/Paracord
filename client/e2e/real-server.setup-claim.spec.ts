/**
 * First run, claim mode (docs/setup-spec.md §2.11), on a real unclaimed
 * server: the page a headless install opens (`/setup-server#claim=…`) makes
 * the owner with one password, reports the server's own status rows, shows
 * the phrase, makes an invite and lands in the new server. Replaces the
 * retired InstanceSetupPage spec (real-server-setup.spec.ts).
 *
 *   PARACORD_E2E_REAL=1 PARACORD_E2E_SERVER_BIN=… npx playwright test e2e/real-server.setup-claim.spec.ts
 */
import { expect, test } from '@playwright/test';

import { CLAIM_TOKEN, haveServer, launchFirstRunServer, serverBin, type FirstRunServer } from './fixtures/firstRunServer';

test.describe('claim mode on a real server', () => {
  test.skip(!haveServer, `release server binary not built at ${serverBin}`);
  test.setTimeout(180_000);

  let server: FirstRunServer;
  test.beforeAll(async () => {
    server = await launchFirstRunServer();
  });
  test.afterAll(async () => {
    await server?.stop();
  });

  test('a headless install is claimed through the first run and lands in its server', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: server.base });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/setup-server#claim=${CLAIM_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'What should we call your server?' })).toBeVisible();
    // The code is read from the fragment and scrubbed from the address bar.
    await expect(page).not.toHaveURL(/claim=/);

    await page.getByTestId('fr-server-name').fill('Friday Night Crew');
    await page.getByRole('radio', { name: 'Green' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('[data-step="account"]')).toHaveAttribute('data-state', 'on');
    await page.getByTestId('fr-display-name').fill('Sam');
    await expect(page.getByTestId('fr-username')).toHaveValue('sam');
    // A common password is refused before anything is sent.
    await page.getByTestId('fr-password').fill('password1234');
    await expect(page.getByTestId('fr-password-help')).toHaveText('That one is too easy to guess.');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByTestId('fr-password').fill('paper lantern orbit');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Setting up your server' })).toBeVisible();
    await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 60_000 });
    const rows = page.getByTestId('fr-setup-rows');
    await expect(rows.locator('[data-row="3"]')).toHaveAttribute('data-state', 'ok');
    // This server has no stored-data key: said plainly, not as a failure.
    await expect(rows.locator('[data-row="2"]')).toHaveAttribute('data-state', 'warn');
    await expect(rows.locator('[data-row="2"]')).toContainText("not encrypted on this server's disk");
    await page.getByTestId('fr-setup-continue').click();

    await expect(page.getByRole('heading', { name: 'Save your recovery phrase' })).toBeVisible();
    await page.getByTestId('fr-show-words').click();
    await expect(page.locator('.fr-words li')).toHaveCount(24);
    await page.getByTestId('fr-phrase-saved').check();
    await page.getByTestId('fr-phrase-continue').click();

    await expect(page.getByRole('heading', { name: 'Invite your friends' })).toBeVisible();
    await expect(page.getByTestId('fr-invite-link')).toContainText(/\/invite\/[A-Za-z0-9]+/, { timeout: 15_000 });
    // A server bound to loopback is reachable only here, and the screen says so.
    await expect(page.getByTestId('fr-only-here-note')).toBeVisible();

    await page.getByTestId('fr-open-server').click();
    await expect(page).toHaveURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 20_000 });
    await expect(page.locator('.ix-frame')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Friday Night Crew').first()).toBeVisible();
    expect(errors).toEqual([]);

    // The claim is single use: the page cannot be used again.
    const again = await (await fetch(`${server.base}/api/v1/setup/status`)).json();
    expect(again.setup_required).toBe(false);
    await context.close();
  });
});
