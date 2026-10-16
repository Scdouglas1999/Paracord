import { expect, test, type Page } from '@playwright/test';

import { installIndexScene } from './fixtures/index';
import { CLOCK } from './fixtures/index/scene';
import { installTauriHost, type HostingState, type TauriHost } from './fixtures/setup';
import type { ReachScenario } from './fixtures/setup/hostScripts';

/**
 * Settings › "Paracord on this computer" (docs/setup-spec.md §2.9, fix package
 * F4): the signed-in Index scene on the desktop, with the host commands
 * stubbed as a computer that already hosts a server (`hosting` in
 * fixtures/setup/tauriHost.ts). Every state the page can be in is shot; the
 * actions are driven through the stub and their calls asserted.
 *
 *   cd client
 *   PARACORD_E2E_SETUP_SPEC=setup-f4-host-settings PARACORD_E2E_SETUP_PORT=5043 \
 *   PARACORD_E2E_SETUP_RT_PORT=5045 PARACORD_E2E_SETUP_WP=f4 \
 *     npx playwright test -c e2e/setup-review.config.ts
 *
 * Shots land in output/design-reference/setup-build/f4/.
 */

const SHOTS = `../output/design-reference/setup-build/${process.env.PARACORD_E2E_SETUP_WP ?? 'latest'}`;
const RT_PORT = Number(process.env.PARACORD_E2E_SETUP_RT_PORT ?? 4995);
const NOW = Date.parse(CLOCK.start);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const THIS_COMPUTER_PORT = 8443;

interface Opened {
  host: TauriHost;
}

const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

/** The desktop app, signed in to the scene's server, with the host commands stubbed. */
async function openApp(page: Page, hosting: Partial<HostingState>, reach: ReachScenario = 'open'): Promise<TauriHost> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const host = await installTauriHost(page, { reach, hosting: { lastBackupAt: ago(2 * HOUR), ...hosting } });
  // On the desktop the app connects to a stored server address; this scene's server is the page's own origin.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('paracord:v2:server-url', window.location.origin);
      // The desktop keeps the session's refresh token; this one moves into the (stubbed) keychain at boot.
      window.localStorage.setItem('paracord:refresh-token', 'index-refresh');
    } catch {
      /* storage unavailable: the scene fails loudly at the sign-in screen */
    }
  });
  const h = await installIndexScene(page, { rtPort: RT_PORT });
  // The desktop's gateway runs through the shell, which this scene does not stand in for; Settings
  // needs only the REST answers (the account, its servers), so the page is opened without waiting on it.
  await page.goto(h.routes.channel('fuelGeneral'));
  await expect(page.getByRole('main')).toBeVisible();
  return host;
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.evaluate(async (s) => {
    const mod = (await import(/* @vite-ignore */ '/src/stores/uiStore.ts')) as Record<string, any>;
    mod.useUIStore.getState().setUserSettingsOpen(true, s);
  }, section);
  await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
}

async function openHostSettings(page: Page, hosting: Partial<HostingState> = {}, reach: ReachScenario = 'open'): Promise<Opened> {
  const host = await openApp(page, hosting, reach);
  await openSettings(page, 'host');
  await expect(page.getByTestId('host-settings')).toBeVisible();
  return { host };
}

async function shoot(page: Page, name: string, full = true): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled', caret: 'hide' });
  if (!full) return;
  // The section scrolls inside Settings: a second shot with the window tall enough for all of it.
  const height = await page.locator('.ix-settings__scroll').evaluate((el) => el.scrollHeight);
  if (height <= 800) return;
  await page.setViewportSize({ width: 1280, height: height + 120 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}-full.png`, animations: 'disabled', caret: 'hide' });
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe('Paracord on this computer', () => {
  test('running, the router opened the way, a friend came in from outside', async ({ page }) => {
    await openHostSettings(page, { confirmedAt: ago(5 * 60_000) });
    const nav = page.locator('.ix-settings__nav');
    await expect(nav.getByRole('button', { name: 'This computer' })).toBeVisible();
    await expect(page.getByTestId('host-state')).toHaveText('Running');
    await expect(page.getByTestId('host-reach')).toHaveText('Your router opened the way. Friends can reach you at 73.162.4.19.');
    await expect(page.getByTestId('host-row-reach')).toContainText('A friend connected from outside 5 minutes ago.');
    await expect(page.getByTestId('host-words')).toHaveText(/^\w+ · \w+ · \w+ · \w+$/);
    await expect(page.getByTestId('host-storage')).toHaveText("Encrypted on this computer's disk. The key lives in your system keychain.");
    await expect(page.getByTestId('host-escrow')).toHaveAttribute('data-saved', 'true');
    await expect(page.getByTestId('host-backup')).toHaveText('Last backup about 2 hours ago.');
    await expect(page.getByTestId('host-start')).toHaveCount(0);
    await shoot(page, 'running-open');
  });

  for (const reach of ['refused', 'no_answer'] as const) {
    test(`the router ${reach === 'refused' ? "didn't allow it" : "didn't answer"}: Let friends in, Try again`, async ({ page }) => {
      const { host } = await openHostSettings(page, {}, reach);
      await expect(page.getByTestId('host-row-reach')).toContainText('Paracord checks again every minute.');
      await shoot(page, `reach-${reach}`, false);
      await page.getByTestId('host-reach-howto').click();
      const sheet = page.getByTestId('fr-router-sheet');
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText('192.168.1.1');
      await expect(sheet).toContainText('8443');
      await expect(sheet).toContainText('192.168.1.28');
      await shoot(page, `reach-${reach}-sheet`, false);
      await sheet.getByRole('button', { name: 'Got it' }).click();
      await page.getByTestId('host-reach-retry').click();
      await expect.poll(() => host.calls('host_retry_reachability').length).toBe(1);
    });
  }

  test("the router didn't answer, a STUN server named the public address: say where friends will reach it", async ({ page }) => {
    await openHostSettings(page, { observedIp: '198.51.100.4' }, 'no_answer');
    await expect(page.getByTestId('host-reach')).toHaveText(
      "Your router didn't answer. Once port 8443 is forwarded on your router, friends will reach you at 198.51.100.4; people on your home network can join now.",
    );
    await expect(page.getByTestId('host-reach-link-hint')).toHaveText(
      "Invite links use your public address, 198.51.100.4. To give out a domain name instead, set public_url under [server] in the server's paracord.toml and restart it.",
    );
    await shoot(page, 'reach-no_answer-stun', false);
  });

  test('shared address: What can I do?', async ({ page }) => {
    await openHostSettings(page, {}, 'shared_address');
    await expect(page.getByTestId('host-reach')).toContainText('shares its public address');
    await shoot(page, 'reach-shared', false);
    await page.getByTestId('host-reach-shared').click();
    await expect(page.getByTestId('fr-shared-sheet')).toBeVisible();
    await shoot(page, 'reach-shared-sheet', false);
  });

  test('Windows Firewall is blocking friends: Allow', async ({ page }) => {
    const { host } = await openHostSettings(page, {}, 'firewall_blocked');
    await expect(page.getByTestId('host-reach')).toHaveText('Windows Firewall is blocking friends.');
    await shoot(page, 'reach-firewall', false);
    await page.getByTestId('host-reach-allow').click();
    await expect.poll(() => host.calls('host_allow_firewall').length).toBe(1);
  });

  test('its own public address', async ({ page }) => {
    await openHostSettings(page, {}, 'direct');
    await expect(page.getByTestId('host-reach')).toContainText('This computer has its own public address (73.162.4.19)');
    await shoot(page, 'reach-direct', false);
  });

  test('stopped, then Start', async ({ page }) => {
    const { host } = await openHostSettings(page, { service: 'stopped' });
    await expect(page.getByTestId('host-state')).toHaveText('Stopped');
    await expect(page.getByTestId('host-reason')).toHaveText('Nobody can reach the server until it starts again, you included.');
    await expect(page.getByTestId('host-row-live')).toContainText('show here while it runs');
    await shoot(page, 'stopped');

    let release!: () => void;
    host.serviceHold = new Promise<void>((resolve) => (release = resolve));
    await page.getByTestId('host-start').click();
    await expect(page.getByTestId('host-state')).toHaveText('Starting');
    await shoot(page, 'starting', false);
    release();
    await expect(page.getByTestId('host-state')).toHaveText('Running');
    await expect(page.getByTestId('host-words')).toBeVisible();
    expect(host.calls('host_start')).toHaveLength(1);
  });

  test('Stop', async ({ page }) => {
    const { host } = await openHostSettings(page);
    await page.getByTestId('host-stop').click();
    await expect(page.getByTestId('host-state')).toHaveText('Stopped');
    expect(host.calls('host_stop')).toHaveLength(1);
  });

  test("can't start: a Start that fails says why", async ({ page }) => {
    await openHostSettings(page, { service: 'stopped', startFails: 'Port 8443 is in use by another program.' });
    await page.getByTestId('host-start').click();
    await expect(page.getByTestId('host-state')).toHaveText("Can't start");
    await expect(page.getByTestId('host-reason')).toHaveText('Port 8443 is in use by another program.');
    await shoot(page, 'cant-start', false);
  });

  test("can't start: another program holds the port (spec 2.10)", async ({ page }) => {
    await openHostSettings(page, { service: 'stopped', portProblem: 'Port 8443 is in use by another program.' });
    await expect(page.getByTestId('host-state')).toHaveText("Can't start");
    await expect(page.getByTestId('host-reason')).toHaveText('Port 8443 is in use by another program.');
    await shoot(page, 'cant-start-port', false);
  });

  test("can't start: the storage key", async ({ page }) => {
    await openHostSettings(page, { service: 'failed', exitCode: 78, storageKeyProblem: 'the system keychain is locked or not running' });
    await expect(page.getByTestId('host-state')).toHaveText("Can't start");
    await expect(page.getByTestId('host-reason')).toHaveText("It can't open its storage key: the system keychain is locked or not running.");
    await shoot(page, 'cant-start-key', false);
  });

  test("can't tell: the service manager didn't answer", async ({ page }) => {
    await openHostSettings(page, { service: null, serviceError: 'Failed to connect to bus: No medium found' });
    await expect(page.getByTestId('host-state')).toHaveText("Can't tell");
    await shoot(page, 'cant-tell', false);
  });

  test('an update that did not come up: restore the backup from before it', async ({ page }) => {
    const { host } = await openHostSettings(page, { service: 'failed', exitCode: 1, updateFailed: true });
    await expect(page.getByTestId('host-update')).toContainText("Paracord on this computer didn't start after the update.");
    await shoot(page, 'update-failed', false);
    await page.getByTestId('host-rollback').click();
    await expect(page.getByTestId('host-update')).toContainText("Version 3.5.0 didn't start here");
    expect(host.calls('host_rollback_update')).toHaveLength(1);
    await shoot(page, 'update-held', false);
  });

  test('no recovery copy of the key yet; a backup that failed; Back up now', async ({ page }) => {
    const { host } = await openHostSettings(page, { escrowed: false, backupError: 'No space left on device (os error 28)' });
    await expect(page.getByTestId('host-escrow')).toHaveAttribute('data-saved', 'false');
    await expect(page.getByTestId('host-backup')).toHaveText("The last backup didn't finish: No space left on device (os error 28).");
    await shoot(page, 'escrow-missing-backup-failed');
    // This scene's account is not unlocked on the desktop, so the copy can't be made here: it says what to do.
    await page.getByTestId('host-escrow-save').click();
    await expect(page.getByTestId('host-row-storage').getByRole('alert')).toHaveText(
      "Sign in to this computer's server with the account that set it up, then try again.",
    );
    await page.getByTestId('host-backup-now').click();
    await expect(page.getByTestId('host-row-backups')).toContainText('Backed up: paracord-2026-10-12.tar.zst');
    await expect(page.getByTestId('host-backup')).toHaveText(/^Last backup (less than a minute|\d+ seconds?) ago\.$/);
    expect(host.calls('host_backup_now')).toHaveLength(1);
    await shoot(page, 'backed-up', false);
  });

  test('autostart switch', async ({ page }) => {
    const { host } = await openHostSettings(page);
    const toggle = page.getByRole('switch', { name: 'Starts when you sign in to this computer' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(host.calls('host_set_autostart').map((c) => (c.args as { enabled: boolean }).enabled)).toEqual([false]);
  });

  test('Show logs', async ({ page }) => {
    await openHostSettings(page);
    await page.getByTestId('host-logs').click();
    await expect(page.getByTestId('host-log')).toContainText('INFO paracord: starting');
    await shoot(page, 'logs', false);
  });

  test('Invite people: Settings closes and the invite dialog opens', async ({ page }) => {
    await openHostSettings(page);
    // The host's own server: an invite, and the address the router opened (spec 5.6).
    await page.route('**/api/v1/channels/*/invites', (route) =>
      route.request().method() !== 'POST'
        ? route.fallback()
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'Rf8kQ2', channel_id: '1', guild_id: '1', inviter_id: null, max_age: 604800, max_uses: 25, uses: 0, created_at: new Date(NOW).toISOString() }),
          }),
    );
    await page.route('**/api/v1/instance/share-address', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://73.162.4.19:8443', reach: 'internet', asks_router: true }) }),
    );
    await page.getByTestId('host-invite').click();
    await expect(page.getByRole('dialog', { name: 'User settings' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Invite people to Fuel' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Invite people to Fuel' }).locator('input[value*="/invite/Rf8kQ2"], [title*="/invite/Rf8kQ2"]').or(page.getByText('https://73.162.4.19:8443/invite/Rf8kQ2'))).toHaveCount(1);
    await shoot(page, 'invite', false);
  });

  test('Remove, keeping the data', async ({ page }) => {
    const { host } = await openHostSettings(page);
    await page.getByTestId('host-remove').click();
    const dialog = page.getByTestId('host-remove-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Kept on this computer:');
    await expect(page.getByTestId('host-remove-confirm')).toBeEnabled();
    await shoot(page, 'remove-keep', false);
    await page.getByTestId('host-remove-confirm').click();
    await expect(page.getByTestId('host-settings')).toHaveAttribute('data-state', 'removed');
    await expect(page.locator('.ix-settings__nav').getByRole('button', { name: 'This computer' })).toHaveCount(0);
    expect(host.calls('host_remove').map((c) => (c.args as { deleteData: boolean }).deleteData)).toEqual([false]);
    await shoot(page, 'removed', false);
  });

  test('Remove that was the app\'s only server: signs out of it and goes to the welcome screen', async ({ page }) => {
    const { host } = await openHostSettings(page);
    // The app's home server is this computer's own server.
    await page.evaluate((port) => window.localStorage.setItem('paracord:v2:server-url', `https://127.0.0.1:${port}`), THIS_COMPUTER_PORT);
    await page.getByTestId('host-remove').click();
    await page.getByTestId('host-remove-confirm').click();
    await expect.poll(() => host.calls('host_remove').length).toBe(1);
    await expect(page).toHaveURL(/\/welcome/);
    expect(await page.evaluate(() => window.localStorage.getItem('paracord:v2:server-url'))).toBeNull();
    await expect(page.getByText('unavailable', { exact: false })).toHaveCount(0);
    await shoot(page, 'removed-welcome', false);
  });

  test('Remove and delete the data: the server name must be typed', async ({ page }) => {
    const { host } = await openHostSettings(page);
    await page.getByTestId('host-remove').click();
    await page.getByTestId('host-remove-delete').check();
    await expect(page.getByTestId('host-remove-danger')).toContainText('It can’t be undone.');
    const confirm = page.getByTestId('host-remove-confirm');
    await expect(confirm).toHaveText('Remove and delete its data');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('host-remove-typed').fill('Fue');
    await expect(confirm).toBeDisabled();
    await shoot(page, 'remove-delete', false);
    await page.getByTestId('host-remove-typed').fill('Fuel');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByTestId('host-settings')).toHaveAttribute('data-state', 'removed');
    expect(host.calls('host_remove').map((c) => (c.args as { deleteData: boolean }).deleteData)).toEqual([true]);
  });

  test('Remove that fails says why and keeps the dialog', async ({ page }) => {
    await openHostSettings(page, { removeFails: "Couldn't delete the server's storage key from the system keychain (locked). The server's files were kept." });
    await page.getByTestId('host-remove').click();
    await page.getByTestId('host-remove-confirm').click();
    await expect(page.getByTestId('host-remove-dialog').getByRole('alert')).toContainText("It wasn't removed: Couldn't delete");
    await shoot(page, 'remove-failed', false);
  });

  test("Settings › Privacy › What's protected opens above Settings", async ({ page }) => {
    await openApp(page, {});
    await openSettings(page, 'activity');
    await page.getByRole('button', { name: /What.s protected/ }).click();
    const rows = page.getByTestId('protected-rows');
    await expect(rows).toBeVisible();
    // The sheet's own row is what a click at its center reaches, not Settings beneath it.
    const reached = await rows.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!top && el.contains(top);
    });
    expect(reached, 'the sheet is on top of Settings').toBe(true);
    await shoot(page, 'protected-sheet', false);
  });

  test('a computer that does not host: no row in Settings', async ({ page }) => {
    await openApp(page, { enabled: false, service: null });
    await openSettings(page, 'account');
    const nav = page.locator('.ix-settings__nav');
    await expect(nav.getByRole('button', { name: 'About' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'This computer' })).toHaveCount(0);
  });
});
