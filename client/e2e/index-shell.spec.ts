import { expect, test, type Page } from '@playwright/test';
import {
  CH,
  GUILD,
  PEOPLE,
  dockItem,
  installIndexScene,
  outDir,
  shoot,
  sidebar,
  toolbar,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-4 (Shell): the Index frame with today's slots (docs/index-spec.md §3,
 * §5.1, §5.9, §5.14; docs/design/index-plan.md §3 IX-4).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-shell PARACORD_E2E_INDEX_PORT=4523 \
 *   PARACORD_E2E_INDEX_RT_PORT=4525 PARACORD_E2E_INDEX_WP=ix4 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * The sidebar, dock, card, call and sheets are stubs until wave C fills them
 * (the sidebar shows the Glass places panel, the call the Glass stage), so this
 * holds the GEOMETRY the slots will sit in, the place slide and tint, the
 * toolbar, and the large-title fold, not what fills them.
 */

const MOTION_GONE_MS = 2_000;

async function open(page: Page, route?: string): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page);
  await h.open(route ?? h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

const rectOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });

/** Every animation in the document right now (ids where set), and every pane and tint layer. */
const census = (page: Page) =>
  page.evaluate(() => ({
    animations: document.getAnimations().map((animation) => animation.id || animation.constructor.name),
    panes: [...document.querySelectorAll<HTMLElement>('.ix-pane')].map((pane) => pane.dataset.place),
    side: [...document.querySelectorAll<HTMLElement>('[data-ix-tint="side"]')].map((layer) => layer.dataset.hue),
    main: [...document.querySelectorAll<HTMLElement>('[data-ix-tint="main"]')].map((layer) => layer.dataset.hue),
  }));

/**
 * Render a `LargeTitlePage` over today's page in main, with the app's own React
 * (the module URLs carry the dev server's dependency hash, read from a module
 * that imports React). The toolbar store is the app's, so the frame's toolbar
 * shows what the page registers: a real fold in a real browser before IX-10 and
 * IX-15 build pages on it.
 */
async function mountLargeTitlePage(page: Page, lines: number): Promise<void> {
  await page.evaluate(async (count) => {
    const source = await (await fetch('/src/components/ix/page/LargeTitlePage.tsx')).text();
    const reactUrl = /["'](\/node_modules\/\.vite\/deps\/react\.js\?v=[^"']+)["']/.exec(source)?.[1];
    if (!reactUrl) throw new Error('could not find the app\'s React module URL');
    const version = reactUrl.split('?')[1];
    const reactModule = (await import(/* @vite-ignore */ reactUrl)) as any;
    const clientModule = (await import(/* @vite-ignore */ `/node_modules/.vite/deps/react-dom_client.js?${version}`)) as any;
    const React = reactModule.default ?? reactModule;
    const client = clientModule.default ?? clientModule;
    const { LargeTitlePage } = (await import(/* @vite-ignore */ '/src/components/ix/page/index.ts')) as any;
    const host = document.createElement('div');
    host.id = 'ix4-large-title-probe';
    host.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;z-index:2;background:transparent';
    document.querySelector('.ix-main__content')?.appendChild(host);
    // Hide today's page under it (it still holds the toolbar's place: legacy).
    const legacy = document.querySelector<HTMLElement>('.ix-main__content > .glass-outlet');
    if (legacy) legacy.style.visibility = 'hidden';
    const h = React.createElement;
    const body = Array.from({ length: count }, (_, i) =>
      h('p', { key: i, style: { margin: '0 0 14px', color: 'var(--ix-ink-2)', fontSize: 15 } }, `Line ${i + 1} of the page body.`),
    );
    client.createRoot(host).render(
      h(LargeTitlePage, { title: 'general', subtitle: 'Fuel’s main channel', 'data-testid': 'ix4-page' }, body),
    );
  }, lines);
  await expect(page.getByTestId('ix4-page')).toBeVisible();
}

test.describe('IX-4 shell', () => {
  test('the frame: two flush columns, the hairline, the toolbar, one tint layer each, nothing moving at rest', async ({ page }) => {
    await open(page);
    const frame = await rectOf(page, '.ix-frame');
    const side = await rectOf(page, '.ix-side');
    const main = await rectOf(page, '.ix-main');
    expect(side).toMatchObject({ x: 0, width: 316 });
    expect(main.x).toBe(316);
    expect(main.right).toBe(frame.right);
    expect(side.height).toBe(frame.height);
    // The right hairline is the sidebar's own.
    const hairline = await page.locator('.ix-side').evaluate((element) => getComputedStyle(element, '::after').backgroundColor);
    expect(hairline).toBe('rgba(255, 255, 255, 0.05)');
    // The toolbar floats over main: 58 tall, flush with its top.
    const bar = await rectOf(page, '[data-testid="ix-toolbar"]');
    expect(bar).toMatchObject({ x: 316, y: main.y, height: 58, width: main.width });
    await expect(toolbar(page).getByRole('button', { name: 'Search messages' })).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: 'Members' })).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: 'Your account' })).toBeVisible();
    // Fuel's hue tints both columns.
    const fuelHue = String(350);
    await expect.poll(async () => (await census(page)).side).toEqual([fuelHue]);
    expect((await census(page)).main).toEqual([fuelHue]);
    // No room light: no backdrop canvas.
    await expect(page.locator('.glass-room-backdrop')).toHaveCount(0);
    // Quiet at rest: nothing of the frame's runs.
    await page.waitForTimeout(MOTION_GONE_MS);
    const animations = (await census(page)).animations.filter((id) => id.startsWith('ix-'));
    expect(animations).toEqual([]);
  });

  test('switching place slides the panes by dock order and crossfades the tint, then settles to one of each', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(800);
    await dockItem(page, 'gameNight').click();
    // Mid-move: both panes mounted, the new one coming from the right (Game Night is right of Fuel in the dock).
    await expect.poll(async () => (await census(page)).panes.length).toBe(2);
    const moving = await page.evaluate(() =>
      document.getAnimations().map((animation) => ({
        id: animation.id,
        frames: (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame.transform ?? null),
      })),
    );
    const into = moving.find((animation) => animation.id === 'ix-pane:in');
    const out = moving.find((animation) => animation.id === 'ix-pane:out');
    expect(into?.frames[0]).toBe('translateX(60%)');
    expect(out?.frames[1]).toBe('translateX(-40%)');
    expect(moving.some((animation) => animation.id === 'ix-tint:side')).toBe(true);
    expect(moving.some((animation) => animation.id === 'ix-tint:main')).toBe(true);

    await page.waitForTimeout(MOTION_GONE_MS);
    const after = await census(page);
    expect(after.panes).toEqual([GUILD.gameNight.id]);
    expect(after.side).toEqual(['195']);
    expect(after.main).toEqual(['195']);
    expect(after.animations.filter((id) => id.startsWith('ix-'))).toEqual([]);
    await shoot(page, 'shell-game-night', { settle: 0 });

    // Back to the left: the new pane comes from the left.
    await dockItem(page, 'fuel').click();
    await expect.poll(async () => (await census(page)).panes.length).toBe(2);
    const back = await page.evaluate(() =>
      document.getAnimations().filter((a) => a.id === 'ix-pane:in').map((a) => (a.effect as KeyframeEffect).getKeyframes()[0].transform),
    );
    expect(back).toEqual(['translateX(-60%)']);
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await census(page)).panes).toEqual([GUILD.fuel.id]);
  });

  test('a large-title page under the toolbar folds with the scroll (§5.14)', async ({ page }) => {
    await open(page);
    await mountLargeTitlePage(page, 60);
    await expect(page.locator('.ix-main')).toHaveAttribute('data-page', 'index');
    // The routed conversation has its own large title now (IX-15): this is the page the test mounted.
    const title = page.getByTestId('ix4-page').getByTestId('ix-title');
    await expect(title).toHaveText('general');
    // At rest: the title sits 48px into main, under the toolbar; the toolbar is clear.
    const at = await rectOf(page, '[data-testid="ix4-page"] [data-testid="ix-title"]');
    expect(at.x).toBe(316 + 48);
    await expect(toolbar(page)).toHaveAttribute('data-folded', 'false');
    await shoot(page, 'shell-large-title', { settle: 400 });

    // 30px: half folded, toolbar still clear.
    await page.getByTestId('ix4-page').evaluate((element) => element.scrollTo({ top: 30 }));
    await page.waitForTimeout(100);
    const half = await page.getByTestId('ix4-page').locator('.ix-large-title').evaluate((element) => ({ t: element.style.transform, o: element.style.opacity }));
    expect(half.t).toBe('scale(0.95)');
    expect(Number(half.o)).toBeCloseTo(0.55, 2);
    await expect(toolbar(page)).toHaveAttribute('data-folded', 'false');

    // Past 40px: the folded title and the toolbar's fill (no blur).
    await page.getByTestId('ix4-page').evaluate((element) => element.scrollTo({ top: 200 }));
    await expect(toolbar(page)).toHaveAttribute('data-folded', 'true');
    await page.waitForTimeout(500);
    const bar = await toolbar(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, blur: style.backdropFilter };
    });
    expect(bar.background).toBe('rgba(16, 17, 19, 0.92)');
    expect(bar.blur === 'none' || bar.blur === '').toBe(true);
    const folded = toolbar(page).locator('.ix-toolbar__title');
    await expect(folded).toHaveText('general');
    await expect(folded).toHaveCSS('opacity', '1');
    await shoot(page, 'shell-large-title-folded', { settle: 400 });
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await census(page)).animations.filter((id) => id.startsWith('ix-'))).toEqual([]);
  });

  test('the call host sits over main at inset 10, and over the window in theater with the sidebar dimmed', async ({ page }) => {
    await open(page);
    const main = await rectOf(page, '.ix-main');
    const host = await rectOf(page, '#ix-call-host');
    expect(host).toMatchObject({ x: main.x + 10, y: main.y + 10, width: main.width - 20, height: main.height - 20 });
    // Empty, it takes no clicks: main stays usable under it.
    expect(await page.locator('#ix-call-host').evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    await expect(page.locator('#ix-call-host')).toBeEmpty();

    // Vincent's stream in Lounge (the Glass stage, until IX-13) on the Index surface.
    // A stream, not the call: the Glass call stage has no theater.
    const stage = (mode: 'side' | 'theater' | null) =>
      page.evaluate(
        async ({ mode, guildId, channelId, streamerId }) => {
          const { useGlassStore } = (await import(/* @vite-ignore */ '/src/stores/glassStore.ts')) as {
            useGlassStore: { getState(): { openStage(t: object, m?: string): void; closeStage(): void } };
          };
          if (mode) useGlassStore.getState().openStage({ serverId: '__local__', guildId, channelId, streamerId }, mode);
          else useGlassStore.getState().closeStage();
        },
        { mode, guildId: GUILD.gameNight.id, channelId: CH.gnRoomLounge, streamerId: PEOPLE.vincent.id },
      );
    await stage('side');
    const surface = page.getByRole('region', { name: 'Call' });
    await expect(surface).toBeVisible();
    expect(await rectOf(page, '.ix-inset-surface')).toMatchObject({ x: main.x + 10, y: main.y + 10, width: main.width - 20 });
    expect(await surface.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe('24px');
    await expect(page.locator('.ix-main')).toHaveAttribute('inert', '');
    await shoot(page, 'shell-call', { settle: 600 });

    await stage('theater');
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-stage', 'theater');
    const frame = await rectOf(page, '.ix-frame');
    expect(await rectOf(page, '.ix-inset-surface')).toMatchObject({ x: frame.x + 10, y: frame.y + 10, width: frame.width - 20 });
    await page.waitForTimeout(800);
    expect(await page.locator('.ix-side').evaluate((element) => getComputedStyle(element).opacity)).toBe('0.4');
    await expect(page.locator('.ix-side')).toHaveAttribute('inert', '');

    await stage(null);
    await expect(page.locator('#ix-call-host')).toBeEmpty();
    await expect(page.locator('.ix-main')).not.toHaveAttribute('inert', '');
  });

  test('the pinned card host: above the panes, collapsed when empty, the header 18px under a card', async ({ page }) => {
    await open(page);
    const pinned = page.locator('.ix-side__pinned');
    const panePadding = () => page.locator('.ix-pane').first().evaluate((element) => getComputedStyle(element).paddingTop);
    // No call elsewhere: the host takes no room and the pane starts 16px down.
    await expect(pinned).toBeHidden();
    expect(await panePadding()).toBe('16px');
    // A card (what IX-7 renders: margin-top 12) lands where the prototype's s4 has it.
    await pinned.evaluate((element) => {
      const card = document.createElement('div');
      card.style.cssText = 'margin-top:12px;height:176px;border-radius:16px;background:rgba(255,170,90,.11)';
      element.appendChild(card);
    });
    const card = await rectOf(page, '.ix-side__pinned > div');
    expect(card).toMatchObject({ x: 12, y: 28, width: 292 });
    expect(await panePadding()).toBe('14px');
    const pane = await rectOf(page, '.ix-pane');
    expect(pane.y).toBe(card.bottom);
  });

  test('the sheet host: inside main on its right, 400 wide (480 for search), full inset under 760px of main', async ({ page }) => {
    await open(page);
    const main = await rectOf(page, '.ix-main');
    const host = await rectOf(page, '#ix-sheet-host');
    expect(host).toMatchObject({ width: 400, right: main.right - 10, y: main.y + 10, height: main.height - 20 });
    await page.locator('#ix-sheet-host').evaluate((element) => element.setAttribute('data-sheet', 'search'));
    expect((await rectOf(page, '#ix-sheet-host')).width).toBe(480);
    await page.setViewportSize({ width: 900, height: 700 });
    const narrowMain = await rectOf(page, '.ix-main');
    expect(narrowMain.x).toBe(280);
    const narrowHost = await rectOf(page, '#ix-sheet-host');
    expect(narrowHost).toMatchObject({ x: narrowMain.x + 10, width: narrowMain.width - 20 });
  });

  test('the frame at every size', async ({ page }) => {
    await open(page);
    await shoot(page, 's0-quiet');
    await shoot(page, 's0-quiet', { size: 'desktop' });
    await shoot(page, 's0-quiet', { size: 'narrow' });
    expect((await rectOf(page, '.ix-side')).width).toBe(280);
    await shoot(page, 's0-quiet', { size: 'phone' });
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-layout', 'phone');
    // A deep link opens on its page, the sidebar behind it.
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-screen', 'conversation');
    await toolbar(page).getByRole('button', { name: 'Back to the sidebar' }).click();
    await expect(page.locator('.ix-frame')).toHaveAttribute('data-screen', 'places');
    await shoot(page, 's0-quiet-root', { size: 'phone' });
    console.log(`shots in ${outDir()}`);
  });
});
