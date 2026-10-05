import { expect, test, type Page } from '@playwright/test';
import { CH, GUILD, composer, composerInput, installIndexScene, shoot, sidebar, type IndexHarness } from './fixtures/index';

/**
 * IX-17 (long tail): the surfaces the packages that rebuild the shell do not
 * own, on the Index scene: user and server settings, dialogs and confirms,
 * toasts, tooltips, menus, the media viewer, invite and screen-share modals,
 * forward / remind / edit history, the auth and onboarding pages, Admin and
 * Developer (docs/index-spec.md §6.7, §6.8, §6.10-6.14; docs/design/index-plan.md §3).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-longtail PARACORD_E2E_INDEX_PORT=4653 \
 *   PARACORD_E2E_INDEX_RT_PORT=4655 PARACORD_E2E_INDEX_WP=ix17 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Shots land in output/design-reference/index-build/ix17/. The prototype has no
 * settings, dialog or auth screen: they are held against the spec text and the
 * tokens of the nearest reference state, and read.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

async function open(page: Page, route?: string, viewport = { width: 1440, height: 900 }): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize(viewport);
  const h = await installIndexScene(page);
  await h.open(route ?? h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

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

const USER_SECTIONS = ['account', 'appearance', 'voice', 'notifications', 'activity', 'keybinds', 'identity', 'about'] as const;
const GUILD_SECTIONS = [
  'overview', 'server-hub', 'channels', 'emojis', 'stickers', 'soundboard', 'events', 'sports', 'file-storage',
  'roles', 'members', 'invites', 'onboarding', 'economy', 'bot-store', 'bots', 'webhooks', 'bans', 'automod',
  'mod-templates', 'reports', 'audit-log',
] as const;

async function openUserSettings(page: Page, section: string) {
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', true, section);
  await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
  await page.waitForTimeout(350);
  // A shot reads a section, not a focus ring the dialog's trap put on the first row.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function openGuildSettings(page: Page, guildId: string, section: string) {
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'openGuildSettings', guildId, section);
  await expect(page.getByRole('dialog', { name: 'Server settings' })).toBeVisible();
  await page.waitForTimeout(450);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe('settings (§6.7)', () => {
  test('user settings: every section, full window on the ground, 240px index, 720px column', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    for (const section of USER_SECTIONS) {
      await openUserSettings(page, section);
      if (section === 'account') {
        const dialog = page.getByRole('dialog', { name: 'User settings' });
        const box = await dialog.boundingBox();
        expect(box, 'the dialog fills the window').toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
        const nav = await page.locator('.ix-settings__nav').boundingBox();
        expect(nav?.width).toBe(240);
        const col = await page.locator('.ix-settings__col').boundingBox();
        expect(col?.width).toBe(720);
        // A 28/700 section title, sentence-case group labels, no uppercase kicker anywhere.
        const title = page.locator('.ix-settings__title').first();
        await expect(title).toHaveCSS('font-size', '28px');
        await expect(title).toHaveCSS('font-weight', '700');
        const labels = await page.locator('.ix-settings__nav [class*="text-[12.5px]"]').allTextContents();
        expect(labels).toEqual(['Preferences', 'Advanced']);
        // The selected row wears the hue 210 selection.
        await expect(page.locator('.ix-settings__nav [aria-current="page"]')).toHaveClass(/ix-hue-selected/);
        await expect(page.locator('.ix-settings')).toHaveCSS('--ix-hue', '210');
      }
      await shoot(page, `settings-user-${section}`, { size: 'desktop', settle: 250 });
      await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', false);
      await page.waitForTimeout(250);
    }
  });

  test('server settings: every section, in the server hue', async ({ page }) => {
    test.setTimeout(240_000);
    await open(page);
    for (const section of GUILD_SECTIONS) {
      await openGuildSettings(page, GUILD.fuel.id, section);
      if (section === 'overview') {
        // Fuel's hue is its own (350): the index and the selected row take it.
        await expect(page.locator('.ix-settings')).toHaveCSS('--ix-hue', '350');
        await expect(page.locator('.ix-settings__nav [aria-current="page"]')).toHaveClass(/ix-hue-selected/);
      }
      await shoot(page, `settings-server-${section}`, { size: 'desktop', settle: 250 });
      await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setGuildSettingsId', null);
      await page.waitForTimeout(250);
    }
  });
});

/**
 * The running animations this package owns, by id or CSS animation name (the
 * recipes in primitives.css and the viewer's `ix-viewer:*`). Other packages' loops
 * (the Glass pill's equalizer, until IX-15 retires it) are not this package's.
 */
async function animationIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === 'running' || animation.playState === 'pending')
      .map((animation) => animation.id || (animation as CSSAnimation).animationName || 'anonymous')
      .filter((id) => /^(pc-|ix-viewer|ix-toast)/.test(id)),
  );
}

test.describe('dialogs and confirms (§6.12)', () => {
  test('a destructive confirm: the card, 440 wide, a text Cancel and the danger ink, never cream', async ({ page }) => {
    await open(page);
    await callStore(page, '/src/stores/confirmStore.ts', null, 'confirm', {
      title: 'Delete plans?',
      description: 'This removes the channel and every message in it. It cannot be undone.',
      confirmLabel: 'Delete channel',
      variant: 'danger',
    });
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    const box = await dialog.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(440);
    expect(box?.width).toBeGreaterThan(380);
    await expect(dialog).toHaveCSS('border-radius', '20px');
    await expect(dialog).toHaveCSS('background-color', 'rgb(42, 43, 47)');
    const confirm = dialog.getByRole('button', { name: 'Delete channel' });
    await expect(confirm).toHaveCSS('color', 'rgb(255, 179, 168)');
    await expect(confirm).toHaveCSS('background-color', 'rgba(255, 90, 90, 0.14)');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // Actions are right-aligned.
    const cancel = await dialog.getByRole('button', { name: 'Cancel' }).boundingBox();
    const del = await confirm.boundingBox();
    expect(cancel!.x).toBeLessThan(del!.x);
    expect(box!.x + box!.width - (del!.x + del!.width)).toBeLessThan(30);
    await shoot(page, 'confirm-danger', { size: 'desktop', settle: 200 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('a plain confirm has one cream button; the dialog enters from scale .97 on the spring and the scrim fades', async ({ page }) => {
    await open(page);
    await callStore(page, '/src/stores/confirmStore.ts', null, 'confirm', {
      title: 'Mark everything in Fuel as read?',
      confirmLabel: 'Mark read',
    });
    // Mid-enter: the panel and the scrim are animating (65ms and 60ms), transform and opacity only.
    await page.waitForTimeout(10);
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === 'running')
        .map((animation) => {
          const effect = animation.effect as KeyframeEffect;
          const name = (animation as CSSAnimation).animationName;
          const timing = effect.getComputedTiming();
          const properties = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)));
          return { name, duration: timing.duration, properties: [...properties].filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)) };
        }),
    );
    const dialog = running.find((entry) => entry.name === 'pc-dialog-in');
    const scrim = running.find((entry) => entry.name === 'pc-fade');
    expect(dialog, 'the dialog animates in').toBeTruthy();
    expect(dialog?.duration).toBe(65);
    expect(dialog?.properties.sort()).toEqual(['opacity', 'transform']);
    expect(scrim?.duration).toBe(60);
    await page.waitForTimeout(500);
    const dialogEl = page.getByRole('alertdialog');
    const cream = await dialogEl.getByRole('button').evaluateAll((buttons) =>
      buttons.filter((button) => getComputedStyle(button).backgroundColor === 'rgb(244, 242, 237)').length,
    );
    expect(cream, 'one cream button per dialog').toBe(1);
    await shoot(page, 'confirm-default', { size: 'desktop', settle: 200 });
    await dialogEl.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialogEl).toBeHidden();
    await page.waitForTimeout(2000);
    expect(await animationIds(page)).toEqual([]);
  });
});

test.describe('toasts (§5.18, §6.8)', () => {
  test('a capsule top center of main under the toolbar; errors in the danger ink; gone after 4s', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    await callStore(page, '/src/stores/toastStore.ts', 'useToastStore', 'addToast', 'info', 'Link copied');
    await page.waitForTimeout(10);
    const entering = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => (animation as CSSAnimation).animationName === 'pc-toast-in')
        .map((animation) => ({
          duration: (animation.effect as KeyframeEffect).getComputedTiming().duration,
          properties: [...new Set((animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame)))].filter(
            (p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p),
          ),
        })),
    );
    expect(entering).toHaveLength(1);
    expect(entering[0].duration).toBe(90);
    expect(entering[0].properties.sort()).toEqual(['opacity', 'transform']);
    await page.waitForTimeout(450);
    const toast = page.getByRole('status').filter({ hasText: 'Link copied' });
    await expect(toast).toBeVisible();
    const main = await page.locator('.ix-main').boundingBox();
    const box = await toast.boundingBox();
    expect(Math.abs(box!.x + box!.width / 2 - (main!.x + main!.width / 2)), 'centered in main').toBeLessThan(2);
    expect(box!.y).toBeGreaterThanOrEqual(58 + 6);
    expect(box!.y).toBeLessThan(58 + 14);
    expect(parseFloat(await toast.evaluate((el) => getComputedStyle(el).borderRadius)), 'a capsule').toBeGreaterThan(1000);
    await expect(toast).toHaveCSS('font-size', '13.5px');
    await expect(toast).toHaveCSS('font-weight', '600');
    await callStore(page, '/src/stores/toastStore.ts', 'useToastStore', 'addToast', 'error', 'Could not send that message. Check your connection and try again.', 60_000);
    await page.evaluate(async () => {
      const mod = (await import('/src/stores/toastStore.ts' as string)) as Record<string, any>;
      mod.useToastStore.getState().addToast('success', 'Saved the last 30 seconds', 60_000, { label: 'Post to General', onClick: () => undefined });
    });
    await page.waitForTimeout(500);
    const error = page.getByRole('alert').filter({ hasText: 'Could not send' });
    await expect(error.locator('p')).toHaveCSS('color', 'rgb(255, 179, 168)');
    await expect(error).not.toHaveCSS('background-color', 'rgb(255, 90, 90)');
    await shoot(page, 'toasts', { size: 'desktop', settle: 200 });
    // The default is 4 seconds: the first toast is gone, the long ones are not.
    await expect(toast).toBeHidden({ timeout: 6_000 });
    await expect(error).toBeVisible();
  });
});

test.describe('menus and tooltips (§6.2, §6.11)', () => {
  test('context menus are the Index menu: near-solid, radius 14, rows 36 (a message, and a channel row)', async ({ page }) => {
    await open(page, await installRouteFor('gnLounge', page));
    for (const [name, target] of [
      ['message', page.getByRole('main').getByText('I always bring the good guns').first()],
      ['channel', sidebar(page).getByText('looking-for-group').first()],
    ] as const) {
      await target.click({ button: 'right' });
      const menu = page.getByRole('menu').first();
      await expect(menu).toBeVisible();
      await page.waitForTimeout(300);
      await expect(menu).toHaveCSS('border-radius', '14px');
      await expect(menu).toHaveCSS('background-color', 'rgba(22, 23, 26, 0.98)');
      const rows = await menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
      expect(rows.length, `${name} menu rows`).toBeGreaterThan(3);
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(34);
      expect(Math.max(...rows)).toBeLessThanOrEqual(46);
      await shoot(page, `menu-context-${name}`, { size: 'desktop', settle: 200 });
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  });

  test('a tooltip waits 400ms, is near-solid at radius 8, 12.5/600', async ({ page }) => {
    await open(page);
    const input = composerInput(page);
    await input.click();
    await composer(page).getByRole('button', { name: /^Format/ }).click();
    const bold = page.getByRole('button', { name: /^Bold/ }).first();
    await expect(bold).toBeVisible();
    await bold.hover();
    await page.waitForTimeout(250);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.waitForTimeout(450);
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveCSS('border-radius', '8px');
    await expect(tip).toHaveCSS('background-color', 'rgba(30, 31, 35, 0.98)');
    await expect(tip).toHaveCSS('font-size', '12.5px');
    await expect(tip).toHaveCSS('font-weight', '600');
    await expect(tip).toHaveCSS('backdrop-filter', 'none');
    await page.screenshot({ path: `${(await import('./fixtures/index')).outDir()}/tooltip@1440x900.png` });
  });
});

/** The route of one of the scene's channels. */
async function installRouteFor(key: keyof typeof CH, page: Page): Promise<string> {
  void page;
  const guild = key.startsWith('gn') ? GUILD.gameNight : GUILD.fuel;
  return `/app/guilds/${guild.id}/channels/${CH[key]}`;
}

test.describe('sizes and themes', () => {
  test('settings at 900x700: the column takes the room beside the index, clear of the close control', async ({ page }) => {
    await open(page, undefined, { width: 900, height: 700 });
    await openUserSettings(page, 'appearance');
    const col = await page.locator('.ix-settings__col').boundingBox();
    const close = await page.locator('.ix-settings__close').boundingBox();
    expect(col!.x).toBeGreaterThanOrEqual(240);
    expect(col!.x + col!.width).toBeLessThanOrEqual(close!.x);
    await shoot(page, 'settings-user-appearance', { size: 'narrow', settle: 250 });
  });

  test('settings on a phone: the index, then a section, then back', async ({ page }) => {
    await open(page, undefined, { width: 390, height: 844 });
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', true, null);
    const dialog = page.getByRole('dialog', { name: 'User settings' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    await shoot(page, 'settings-user-index', { size: 'phone', settle: 250 });
    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await page.waitForTimeout(500);
    await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await shoot(page, 'settings-user-appearance', { size: 'phone', settle: 250 });
    await dialog.getByRole('button', { name: 'Back to the settings index' }).click();
    await expect(dialog.getByRole('navigation', { name: 'User settings' })).toBeVisible();
  });

  test('server settings on a phone: the index in the server hue, then a section', async ({ page }) => {
    await open(page, undefined, { width: 390, height: 844 });
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'openGuildSettings', GUILD.fuel.id, null);
    const dialog = page.getByRole('dialog', { name: 'Server settings' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('.ix-settings')).toHaveCSS('--ix-hue', '350');
    await shoot(page, 'settings-server-index', { size: 'phone', settle: 250 });
    await dialog.getByRole('button', { name: 'Roles' }).click();
    await page.waitForTimeout(500);
    await expect(dialog.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    await shoot(page, 'settings-server-roles', { size: 'phone', settle: 250 });
  });

  test('High contrast and Reduced transparency: settings and a confirm stay legible and opaque', async ({ page }) => {
    await open(page);
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setTheme', 'glass-contrast');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass-contrast');
    await openUserSettings(page, 'voice');
    await shoot(page, 'settings-user-voice-contrast', { size: 'desktop', settle: 300 });
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', false);
    await page.waitForTimeout(250);
    await callStore(page, '/src/stores/confirmStore.ts', null, 'confirm', { title: 'Leave Fuel?', confirmLabel: 'Leave server', variant: 'danger' });
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, 'confirm-danger-contrast', { size: 'desktop', settle: 200 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setTheme', 'glass');
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setTransparency', 'reduced');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-transparency', 'true');
    await sidebar(page).getByText('clips').first().click({ button: 'right' });
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    await page.waitForTimeout(250);
    await expect(menu).toHaveCSS('background-color', 'rgb(22, 23, 26)');
    await shoot(page, 'menu-reduced-transparency', { size: 'desktop', settle: 200 });
  });

  test('Esc closes settings; the join-calls-muted setting is in Voice & video', async ({ page }) => {
    await open(page);
    await openUserSettings(page, 'voice');
    await expect(page.getByRole('switch', { name: /Join calls muted/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'User settings' })).toBeHidden();
  });
});
