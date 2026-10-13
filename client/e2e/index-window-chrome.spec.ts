import { expect, test, type Page } from '@playwright/test';
import {
  CLOCK,
  callView,
  installIndexScene,
  navigate,
  openCall,
  outDir,
  roomCard,
  shoot,
  toolbar,
  type IndexHarness,
} from './fixtures/index';
import { installSetupScene } from './fixtures/setup';

/**
 * The window's own chrome (docs/design/index-checkpoints/window-chrome.md,
 * docs/index-spec.md §3 "Window chrome"): the desktop window has no native
 * title bar on Linux and Windows, so the page draws minimize / maximize /
 * close at the top right, in the band of whatever holds it (main's toolbar, a
 * sheet's header, the call view's header), and every one of those leaves room.
 * macOS keeps its traffic lights over the sidebar.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-window-chrome PARACORD_E2E_INDEX_PORT=4713 \
 *   PARACORD_E2E_INDEX_RT_PORT=4715 PARACORD_E2E_INDEX_WP=window-chrome \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * A browser has no desktop window: the dev build's preview
 * (`window.__PARACORD_WINDOW_CHROME__`) draws a platform's chrome instead, and
 * its window state moves with the controls (or `paracord:window-chrome`).
 */

type Platform = 'linux' | 'windows' | 'macos';

async function scene(page: Page, platform: Platform, route?: (h: IndexHarness) => string): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((p) => {
    (window as unknown as { __PARACORD_WINDOW_CHROME__: unknown }).__PARACORD_WINDOW_CHROME__ = { platform: p };
  }, platform);
  const h = await installIndexScene(page);
  await h.open(route ? route(h) : h.routes.channel('fuelGeneral'));
  await expect(page.getByTestId('ix-sidebar')).toBeVisible();
  return h;
}

const controls = (page: Page) => page.getByTestId('window-controls');

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};

const centerY = (b: { y: number; height: number }) => b.y + b.height / 2;

async function setWindowState(page: Page, state: 'normal' | 'maximized' | 'fullscreen'): Promise<void> {
  await page.evaluate((s) => window.dispatchEvent(new CustomEvent('paracord:window-chrome', { detail: { state: s } })), state);
}

test.describe('window chrome', () => {
  test('Linux: the controls sit in the toolbar band, the toolbar leaves room, a hairline edge and resize edges', async ({ page }) => {
    await scene(page, 'linux');
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-window-chrome', 'frameless');
    await expect(root).toHaveAttribute('data-window-platform', 'linux');
    await expect(root).toHaveAttribute('data-window-surface', 'toolbar');

    const group = controls(page);
    await expect(group).toHaveAccessibleName('Window');
    await expect(group.getByRole('button')).toHaveText(['', '', '']);
    await expect(group.getByRole('button', { name: 'Minimize window' })).toHaveAttribute('title', 'Minimize');
    await expect(group.getByRole('button', { name: 'Maximize window' })).toBeVisible();
    await expect(group.getByRole('button', { name: 'Close window' })).toBeVisible();

    // Centered on the toolbar, clear of its last control (your avatar).
    const bar = (await toolbar(page).boundingBox())!;
    const ctl = (await group.boundingBox())!;
    expect(Math.abs(centerY(ctl) - centerY(bar))).toBeLessThanOrEqual(1);
    const me = await box(page, '.ix-toolbar__me');
    expect(me.x + me.width).toBeLessThanOrEqual(ctl.x - 8);
    expect(1280 - (ctl.x + ctl.width)).toBe(14);

    // The toolbar and the sidebar's top band move the window; their controls do not.
    await expect(toolbar(page)).toHaveAttribute('data-window-drag', 'deep');
    await expect(page.locator('.ix-side__drag')).toHaveAttribute('data-window-drag', '');

    // The edge: a 1px hairline; eight resize edges, invisible.
    const edge = await page.evaluate(() => getComputedStyle(document.body, '::after').boxShadow);
    expect(edge).toContain('inset');
    expect(edge).toContain('1px');
    await expect(page.locator('.wc-resize__edge')).toHaveCount(8);
    await expect(page.locator('.wc-resize__edge[data-edge="SouthEast"]')).toHaveCSS('cursor', 'se-resize');
    await shoot(page, 'linux');

    // Hover: the quiet fill; the label is the tooltip.
    await group.getByRole('button', { name: 'Maximize window' }).hover();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${outDir()}/linux-hover.png` });
    await page.screenshot({ path: `${outDir()}/linux-hover-crop.png`, clip: { x: 1280 - 420, y: 0, width: 420, height: 64 } });

    // Keyboard: a focus ring on each.
    await group.getByRole('button', { name: 'Minimize window' }).focus();
    await page.keyboard.press('Tab');
    await expect(group.getByRole('button', { name: 'Maximize window' })).toBeFocused();
    await page.screenshot({ path: `${outDir()}/linux-focus-crop.png`, clip: { x: 1280 - 420, y: 0, width: 420, height: 64 } });

    // Maximized: Restore, no edge, no resize edges.
    await group.getByRole('button', { name: 'Maximize window' }).click();
    await expect(root).toHaveAttribute('data-window-state', 'maximized');
    await expect(group.getByRole('button', { name: 'Restore window' })).toBeVisible();
    await expect(page.locator('.wc-resize__edge')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body, '::after').content)).toBe('none');
    await shoot(page, 'linux-maximized');

    // Full screen: no controls at all.
    await setWindowState(page, 'fullscreen');
    await expect(group).toHaveCount(0);
    await setWindowState(page, 'normal');
    await expect(controls(page)).toBeVisible();
  });

  test('a sheet and the call view take the controls into their own header', async ({ page }) => {
    const h = await scene(page, 'linux');
    // A sheet over main: its header's band, its close button clear of them.
    await toolbar(page).getByRole('button', { name: 'Members' }).click();
    const sheet = page.locator('.ix-sheet-host .ix-sheet__header').first();
    await expect(sheet).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-window-surface', 'sheet');
    await page.waitForTimeout(400);
    const header = (await sheet.boundingBox())!;
    const ctl = (await controls(page).boundingBox())!;
    expect(Math.abs(centerY(ctl) - centerY(header))).toBeLessThanOrEqual(1);
    const lastButton = await sheet.getByRole('button').last().boundingBox();
    if (lastButton) expect(lastButton.x + lastButton.width).toBeLessThanOrEqual(ctl.x - 8);
    await shoot(page, 'linux-sheet');
    await page.keyboard.press('Escape');

    // The call view over main.
    await h.step('arrive');
    await h.step('join');
    await expect(roomCard(page, 'yours')).toBeVisible();
    await page.waitForTimeout(900);
    await h.setClock(CLOCK.call);
    await openCall(page);
    await expect(page.locator('html')).toHaveAttribute('data-window-surface', 'call');
    await page.waitForTimeout(1200);
    const head = await box(page, '.ix-call-head');
    const back = await box(page, '.ix-call-head__back');
    const inCall = (await controls(page).boundingBox())!;
    expect(Math.abs(centerY(inCall) - centerY(back))).toBeLessThanOrEqual(1.5);
    expect(back.x + back.width).toBeLessThanOrEqual(inCall.x - 8);
    expect(head.y).toBeLessThan(inCall.y);
    await shoot(page, 'linux-call');
  });

  test('a stream filling the window: the controls ride with the call chrome; full screen hides them', async ({ page }) => {
    const h = await scene(page, 'linux');
    await h.step('arrive');
    await h.step('join');
    await page.waitForTimeout(900);
    await h.setClock(CLOCK.visit);
    await navigate(page, h.routes.channel('gnLounge'));
    const lounge = roomCard(page, 'streaming');
    await expect(lounge.getByTestId('ix-card-watch')).toHaveText('Watch Vincent');
    await page.waitForTimeout(900);
    await lounge.getByTestId('ix-card-watch').click();
    const view = callView(page);
    await expect(view.locator('.ix-call-stream')).toHaveAttribute('data-picture', 'true', { timeout: 10_000 });
    await page.keyboard.press('t');
    await expect(page.locator('html')).toHaveAttribute('data-window-surface', 'fill');
    await page.mouse.move(640, 400);
    await page.waitForTimeout(1200);
    const back = await box(page, '.ix-call-head__back');
    const ctl = (await controls(page).boundingBox())!;
    expect(back.x + back.width).toBeLessThanOrEqual(ctl.x - 8);
    await page.screenshot({ path: `${outDir()}/linux-theater-stream.png` });
    // After 2 s of stillness the call's chrome goes, and the controls with it.
    await page.waitForTimeout(3000);
    await expect(controls(page)).toHaveCSS('opacity', '0');
    await page.screenshot({ path: `${outDir()}/linux-theater-stream-still.png` });

    // The chat column beside the stream (H): its own top right holds the controls' band.
    await page.mouse.move(640, 420);
    await page.keyboard.press('h');
    await page.waitForTimeout(1200);
    await page.mouse.move(640, 400);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir()}/linux-theater-chat.png` });
    await page.keyboard.press('h');
    await page.waitForTimeout(800);

    // Full screen (§7.7): the window has no controls; the view's own Exit stays.
    await page.mouse.move(600, 300);
    await view.getByTestId('ix-call-fullscreen').click();
    await setWindowState(page, 'fullscreen');
    await expect(controls(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outDir()}/linux-fullscreen.png` });
  });

  test('the first run (a desktop scene): the controls on its title bar, which moves the window', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('paracord:v2:firstRun.launchSeen', '1');
      } catch {
        /* storage unavailable */
      }
    });
    const setup = await installSetupScene(page);
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: 'Welcome to Paracord' })).toBeVisible();
    // The scene is the desktop app (a stubbed Tauri) in a Linux user agent: the real path, no preview.
    await expect(page.locator('html')).toHaveAttribute('data-window-chrome', 'frameless');
    await expect(page.locator('html')).toHaveAttribute('data-window-band', '');
    const bar = await box(page, '.fr-tb');
    const ctl = (await controls(page).boundingBox())!;
    expect(Math.abs(centerY(ctl) - centerY(bar))).toBeLessThanOrEqual(1);
    await expect(page.locator('.fr-tb')).toHaveAttribute('data-window-drag', 'deep');
    await page.waitForTimeout(650);
    await page.screenshot({ path: `${outDir()}/linux-first-run.png` });
    // Sign in instead sits clear of the controls.
    await page.getByTestId('fr-choose-host').click();
    await expect(page.getByRole('heading', { name: 'What should we call your server?' })).toBeVisible();
    await page.waitForTimeout(650);
    const signIn = page.locator('.fr-tb__alt');
    if (await signIn.isVisible()) {
      const alt = (await signIn.boundingBox())!;
      expect(alt.x + alt.width).toBeLessThanOrEqual((await controls(page).boundingBox())!.x - 8);
    }
    await page.screenshot({ path: `${outDir()}/linux-first-run-step.png` });
    // The window chrome's own commands are all answered (the scene's other gaps are not this spec's).
    let gaps = '';
    try {
      setup.expectNothingUnhandled();
    } catch (error) {
      gaps = String(error);
    }
    expect(gaps).not.toMatch(/is_fullscreen|is_maximized|window_titlebar/);
  });

  test('Windows: the same controls, no drawn edge (the system draws it), no resize edges (the system keeps them)', async ({ page }) => {
    await scene(page, 'windows');
    await expect(page.locator('html')).toHaveAttribute('data-window-platform', 'windows');
    await expect(controls(page).getByRole('button')).toHaveCount(3);
    await expect(page.locator('.wc-resize__edge')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body, '::after').content)).toBe('none');
    await shoot(page, 'windows');
  });

  test('macOS: no drawn controls; the traffic lights get a band over the sidebar', async ({ page }) => {
    await scene(page, 'macos');
    await expect(page.locator('html')).toHaveAttribute('data-window-chrome', 'overlay');
    await expect(controls(page)).toHaveCount(0);
    const band = await box(page, '.ix-side__drag');
    expect(band.height).toBe(40);
    const header = await box(page, '[data-testid="ix-sidebar-header"]');
    expect(header.y).toBeGreaterThanOrEqual(40);
    await expect(toolbar(page)).toHaveCSS('padding-right', '20px');
    await shoot(page, 'macos');
  });
});
