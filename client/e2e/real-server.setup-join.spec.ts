/**
 * First run, web join (docs/setup-spec.md §6.6), on a real server: the owner
 * claims it through the first run and copies the invite; a friend in another
 * browser opens the link, sees the server card, makes an account with one
 * password, saves the phrase and lands in the server.
 *
 *   PARACORD_E2E_REAL=1 PARACORD_E2E_SERVER_BIN=… npx playwright test e2e/real-server.setup-join.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

import { CLAIM_TOKEN, haveServer, launchFirstRunServer, serverBin, type FirstRunServer } from './fixtures/firstRunServer';

async function account(page: Page, name: string, password: string): Promise<void> {
  await expect(page.locator('[data-step="account"]')).toHaveAttribute('data-state', 'on');
  await page.getByTestId('fr-display-name').fill(name);
  await page.getByTestId('fr-password').fill(password);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function phrase(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Save your recovery phrase' })).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('fr-show-words').click();
  await page.getByTestId('fr-phrase-saved').check();
  await page.getByTestId('fr-phrase-continue').click();
}

test.describe('web join on a real server', () => {
  test.skip(!haveServer, `release server binary not built at ${serverBin}`);
  test.setTimeout(240_000);

  let server: FirstRunServer;
  test.beforeAll(async () => {
    server = await launchFirstRunServer();
  });
  test.afterAll(async () => {
    await server?.stop();
  });

  test('a friend opens the invite in a browser and is in the server', async ({ browser }) => {
    const owner = await browser.newContext({ baseURL: server.base });
    const host = await owner.newPage();
    await host.goto(`/setup-server#claim=${CLAIM_TOKEN}`);
    await host.getByTestId('fr-server-name').fill('Kanto Friends');
    await host.getByRole('button', { name: 'Continue' }).click();
    await account(host, 'Mara', 'paper lantern orbit');
    await expect(host.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 60_000 });
    await host.getByTestId('fr-setup-continue').click();
    await phrase(host);
    const link = host.getByTestId('fr-invite-link').locator('code');
    await expect(link).toContainText('/invite/', { timeout: 15_000 });
    const code = (await link.textContent())!.split('/invite/')[1].trim();

    const friendContext = await browser.newContext({ baseURL: server.base });
    const friend = await friendContext.newPage();
    const errors: string[] = [];
    friend.on('pageerror', (e) => errors.push(e.message));
    await friend.goto(`/invite/${code}`);
    await expect(friend.getByTestId('fr-server-card')).toContainText('Kanto Friends');
    await expect(friend.getByTestId('fr-trust-row')).toContainText("You’re on 127.0.0.1.");
    await expect(friend.getByTestId('fr-invite-field')).toHaveAttribute('readonly', '');
    await friend.getByTestId('fr-invite-continue').click();
    await expect(friend.getByText('You’re joining')).toBeVisible();
    await account(friend, 'Theo', 'quiet harbor tundra');
    await expect(friend.getByRole('heading', { name: 'Getting you in' })).toBeVisible();
    await expect(friend.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 60_000 });
    await friend.getByTestId('fr-setup-continue').click();
    await phrase(friend);
    await expect(friend).toHaveURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 20_000 });
    await expect(friend.locator('.ix-frame')).toBeVisible({ timeout: 20_000 });
    await expect(friend.getByText('Kanto Friends').first()).toBeVisible();
    expect(errors).toEqual([]);

    await owner.close();
    await friendContext.close();
  });
});
