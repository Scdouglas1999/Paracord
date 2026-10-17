import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  GUILD,
  HISTORY_EPOCH,
  dockItem,
  installIndexScene,
  navigate,
  outDir,
  routes,
  shoot,
  sidebar,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-6 (Dock): the dock at the sidebar's foot and the Add a server sheet
 * (docs/index-spec.md §4.8, §5.1, §5.5, §5.15, §6.1; docs/design/index-plan.md §3 IX-6).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-dock PARACORD_E2E_INDEX_PORT=4543 \
 *   PARACORD_E2E_INDEX_RT_PORT=4545 PARACORD_E2E_INDEX_WP=ix6 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Held against the dock of `output/design-reference/index/ref/` (s0, s1, s4, s6):
 * People's circle, the separator, three marks and + at the prototype's x, the
 * indicator under the current mark, the live dots and the unread dots.
 */

const SETTLE = 1_600;

/** A mocked reply the page accepts: the scene's database history epoch rides on every one. */
const epoch = { 'X-Paracord-History-Epoch': HISTORY_EPOCH };

/** The dock alone, to hold against the same crop of `ref/<state>.png`. */
async function shootDock(page: Page, file: string): Promise<void> {
  await mkdir(outDir(), { recursive: true });
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(150);
  await dock(page).screenshot({ path: path.join(outDir(), file) });
}

async function open(page: Page, route?: string): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page);
  await h.open(route ?? h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  await expect(dock(page)).toBeVisible();
  return h;
}

const dock = (page: Page) => page.getByTestId('ix-dock');
const items = (page: Page) => page.getByTestId('ix-dock-item');
const add = (page: Page) => page.getByTestId('ix-dock-add');
const indicator = (page: Page) => page.getByTestId('ix-dock-indicator');

/** An element's center x and y, and size, in the page. */
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.x, top: b.y, width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height };
};

/**
 * Every animation running now inside the dock, by id. (Animations elsewhere belong
 * to other surfaces: the sidebar's rows and cards have their own packages' specs.)
 */
const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => (animation.effect as KeyframeEffect | null)?.target?.closest('[data-testid="ix-dock"]'))
      .map((animation) => animation.id || animation.constructor.name),
  );

/**
 * Record every Web Animation the page starts from now on, so one that has
 * already finished (a 165ms glide on a slow machine) can still be read.
 */
const recordAnimations = (page: Page) =>
  page.evaluate(() => {
    const seen: Animation[] = [];
    (window as unknown as { __ixAnimations: Animation[] }).__ixAnimations = seen;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = original.apply(this, args);
      seen.push(animation);
      return animation;
    };
  });

/** The recorded animation with this id: its timing and which properties it moves. */
const recorded = (page: Page, id: string) =>
  page.evaluate((wanted) => {
    const all = (window as unknown as { __ixAnimations?: Animation[] }).__ixAnimations ?? [];
    const animation = [...all].reverse().find((candidate) => candidate.id === wanted);
    const timing = animation?.effect?.getTiming();
    const frames = (animation?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
    return {
      duration: timing?.duration,
      easing: timing?.easing,
      props: [...new Set(frames.flatMap((frame) => Object.keys(frame).filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))],
      from: frames[0]?.transform,
      to: frames[frames.length - 1]?.transform,
    };
  }, id);

const state = (locator: Locator) =>
  locator.evaluate((element) => ({
    current: element.hasAttribute('data-current'),
    live: element.hasAttribute('data-live'),
    attention: element.getAttribute('data-attention'),
    label: element.getAttribute('aria-label'),
    tabindex: element.getAttribute('tabindex'),
  }));

test.describe('the dock at rest (§4.8)', () => {
  test('People, a separator, the servers in order and + sit where the prototype puts them', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(SETTLE);

    // The toolbar is named, and its places are People first and then the servers in order.
    await expect(dock(page)).toHaveAttribute('role', 'toolbar');
    await expect(dock(page)).toHaveAttribute('aria-label', 'Servers');
    const order = await items(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.place));
    expect(order).toEqual(['people', GUILD.fuel.id, GUILD.gameNight.id, GUILD.basecamp.id]);

    // 1280x800, the prototype's centers: S 33, F 92, G 140, B 188, + 236 at y 765; the dock starts at 734.
    const centers = await Promise.all([
      box(dockItem(page, 'people')),
      box(dockItem(page, 'fuel')),
      box(dockItem(page, 'gameNight')),
      box(dockItem(page, 'basecamp')),
      box(add(page)),
    ]);
    expect(centers.map((c) => Math.round(c.x))).toEqual([33, 92, 140, 188, 236]);
    for (const c of centers) expect(Math.round(c.y)).toBe(765);
    expect(centers.every((c) => Math.round(c.width) === 42 && Math.round(c.height) === 42)).toBe(true);
    const frame = await box(dock(page));
    expect(Math.round(frame.top)).toBe(734);
    expect(Math.round(frame.height)).toBe(66);

    // Marks are 34px, People's a circle and a server a rounded square (28%).
    const marks = await page.locator('.ix-dock__mark').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), radius: style.borderRadius, opacity: style.opacity };
      }),
    );
    // The current mark is scaled 1.08 (34 -> 37), the others are 34.
    expect(marks.map((m) => m.w)).toEqual([34, 37, 34, 34]);
    expect(marks[0].radius).toBe('50%');
    expect(marks[1].radius).toMatch(/9\.52px|28%/);

    // The current place is full strength at 1.08; the others sit at .82.
    expect(marks.map((m) => m.opacity)).toEqual(['0.82', '1', '0.82', '0.82']);

    // The separator: 1x24 at x 62.
    const sep = await box(page.locator('.ix-dock__sep'));
    expect(Math.round(sep.left)).toBe(62);
    expect(Math.round(sep.width)).toBe(1);
    expect(Math.round(sep.height)).toBe(24);

    // One indicator, 16x3, centered under the current mark, 7px above the dock's bottom.
    await expect(page.locator('.ix-dock__ind')).toHaveCount(1);
    const bar = await box(indicator(page));
    expect(Math.round(bar.x)).toBe(92);
    expect(Math.round(bar.width)).toBe(16);
    expect(Math.round(bar.height)).toBe(3);
    expect(Math.round(frame.bottom - bar.bottom)).toBe(7);
    expect(await indicator(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');

    // Nothing is moving once it has settled.
    expect(await running(page)).toEqual([]);
    await shoot(page, 's0-quiet');
    await shootDock(page, 'dock-s0-quiet.png');
  });

  test('live and unread: Game Night is live with something unread (the prototype\'s s0), the current place shows no dots but live', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(SETTLE);
    const fuel = await state(dockItem(page, 'fuel'));
    const game = await state(dockItem(page, 'gameNight'));
    const base = await state(dockItem(page, 'basecamp'));
    const people = await state(dockItem(page, 'people'));
    expect(fuel).toMatchObject({ current: true, live: false, attention: null, label: 'Fuel', tabindex: '0' });
    expect(game).toMatchObject({ current: false, live: true, attention: 'dot', label: 'Game Night, live, unread', tabindex: '-1' });
    expect(base).toMatchObject({ live: false, attention: null, label: 'Basecamp' });
    expect(people.label).toBe('People');

    // The dots are drawn at the spec's places: live at top 1 right 1 (10px), unread at top 3 left 2 (8px).
    const g = await box(dockItem(page, 'gameNight'));
    const live = await box(dockItem(page, 'gameNight').locator('.ix-dock__live'));
    const unread = await box(dockItem(page, 'gameNight').locator('.ix-dock__unread'));
    expect(Math.round(live.right - g.right)).toBe(-1);
    expect(Math.round(live.top - g.top)).toBe(1);
    expect(Math.round(live.width)).toBe(10);
    expect(Math.round(unread.left - g.left)).toBe(2);
    expect(Math.round(unread.top - g.top)).toBe(3);
    expect(Math.round(unread.width)).toBe(8);
    // The live dot is amber, the unread dot is ink, both bitten by the sidebar's foot color.
    const colors = await dockItem(page, 'gameNight').evaluate((element) => ({
      live: getComputedStyle(element.querySelector('.ix-dock__live')!).backgroundColor,
      unread: getComputedStyle(element.querySelector('.ix-dock__unread')!).backgroundColor,
      ring: getComputedStyle(element.querySelector('.ix-dock__live')!).boxShadow,
    }));
    expect(colors.live).toBe('rgb(255, 194, 126)');
    expect(colors.unread).toBe('rgb(242, 243, 245)');
    expect(colors.ring).toContain('rgb(17, 18, 21)');
  });

  test('someone arrives in Fuel (s1): its live dot shows while you are in it, with no ping', async ({ page }) => {
    const h = await open(page);
    await page.waitForTimeout(500);
    await h.step('arrive');
    await expect(dockItem(page, 'fuel')).toHaveAttribute('data-live', '');
    // You are looking at it: never a ping.
    expect(await running(page)).not.toContain('ix-dock:ping');
    await page.waitForTimeout(SETTLE);
    expect(await state(dockItem(page, 'fuel'))).toMatchObject({ current: true, live: true, attention: null, label: 'Fuel, live' });
    await shoot(page, 's1-someone-arrives');
    await shootDock(page, 'dock-s1-someone-arrives.png');
  });
});

test.describe('switching (§5.1)', () => {
  test('the indicator glides to the new place in 165ms on the spring while the mark scales', async ({ page }) => {
    const h = await open(page);
    // s1 first, so the dock is the prototype's s4: Fuel live with something unread.
    await h.step('arrive');
    await page.waitForTimeout(SETTLE);
    await recordAnimations(page);
    await dockItem(page, 'gameNight').click();
    // The glide: one Web Animation on the indicator, transform only, from Fuel's x to Game Night's.
    await expect.poll(async () => (await recorded(page, 'ix-dock:indicator')).duration).toBeDefined();
    const glide = await recorded(page, 'ix-dock:indicator');
    expect(glide.duration).toBe(165);
    expect(glide.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(glide.props).toEqual(['transform']);
    expect(glide.from).not.toBe(glide.to);

    await page.waitForTimeout(SETTLE);
    const bar = await box(indicator(page));
    const game = await box(dockItem(page, 'gameNight'));
    expect(Math.abs(bar.x - game.x)).toBeLessThan(1);
    expect(await state(dockItem(page, 'gameNight'))).toMatchObject({ current: true, live: true, attention: null, label: 'Game Night, live' });
    expect(await state(dockItem(page, 'fuel'))).toMatchObject({ current: false, live: true, attention: 'dot', label: 'Fuel, live, unread' });
    expect(await running(page)).toEqual([]);

    // The old place's mark is back at .82 and the new one at full strength, scaled.
    const marks = await page.locator('.ix-dock__mark').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).opacity));
    expect(marks).toEqual(['0.82', '0.82', '1', '0.82']);
    await shoot(page, 's4-other-server');
    await shootDock(page, 'dock-s4-other-server.png');
  });

  test('People is a place: its mark is your avatar and the indicator goes back to it', async ({ page }) => {
    await open(page);
    await dockItem(page, 'people').click();
    await expect(page).toHaveURL(/\/app\/dms/);
    await page.waitForTimeout(SETTLE);
    const bar = await box(indicator(page));
    const people = await box(dockItem(page, 'people'));
    expect(Math.abs(bar.x - people.x)).toBeLessThan(1);
    expect(await state(dockItem(page, 'people'))).toMatchObject({ current: true });
    await shootDock(page, 'dock-s6-people.png');
  });

  test('a click on the place you are in changes nothing', async ({ page }) => {
    await open(page);
    const before = page.url();
    await dockItem(page, 'fuel').click();
    await page.waitForTimeout(300);
    expect(page.url()).toBe(before);
    expect(await running(page)).not.toContain('ix-dock:indicator');
  });
});

test.describe('the ping (§5.5)', () => {
  test('a server you are not in going live pings once; one already live, or the one you are in, does not', async ({ page }) => {
    const h = await open(page, routes.channel('gnLounge'));
    await page.waitForTimeout(SETTLE);
    // Game Night was live before the dock saw it, and it is the place you are in: no ping on load.
    expect(await running(page)).toEqual([]);

    await h.step('arrive');
    await expect(dockItem(page, 'fuel')).toHaveAttribute('data-live', '');
    // The ring: a 2px amber ring from scale(1), opacity 1 to scale(2.2), opacity 0, 365ms ease.
    await expect.poll(async () => (await running(page)).includes('ix-dock:ping')).toBe(true);
    const ping = await page.evaluate(() => {
      const animation = document.getAnimations().find((candidate) => candidate.id === 'ix-dock:ping');
      const frames = (animation?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
      return {
        target: (animation?.effect as KeyframeEffect | undefined)?.target?.closest('[data-dock-item]')?.getAttribute('data-place'),
        duration: animation?.effect?.getTiming().duration,
        easing: animation?.effect?.getTiming().easing,
        frames: frames.map((frame) => ({ transform: frame.transform, opacity: frame.opacity })),
        keys: [...new Set(frames.flatMap((frame) => Object.keys(frame).filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))],
        border: getComputedStyle((animation?.effect as KeyframeEffect).target as Element).borderTopWidth,
      };
    });
    expect(ping.target).toBe(GUILD.fuel.id);
    expect(ping.duration).toBe(365);
    expect(ping.easing).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
    expect(ping.keys.sort()).toEqual(['opacity', 'transform']);
    expect(ping.frames).toEqual([
      { transform: 'scale(1)', opacity: '1' },
      { transform: 'scale(2.2)', opacity: '0' },
    ]);
    expect(ping.border).toBe('2px');
    // Exactly one ping, and nothing left running after it.
    expect((await running(page)).filter((id) => id === 'ix-dock:ping')).toHaveLength(1);
    await page.waitForTimeout(SETTLE + 600);
    expect(await running(page)).toEqual([]);
  });
});

test.describe('reduced motion (§5)', () => {
  test('no lift, no ping, and the glide is a 65ms fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const h = await open(page, routes.channel('gnLounge'));
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await page.waitForTimeout(500);

    // Hover does not lift it.
    const fuel = dockItem(page, 'fuel');
    const before = await box(fuel);
    await fuel.hover();
    await page.waitForTimeout(500);
    expect((await box(fuel)).y).toBe(before.y);

    // Going live while you are elsewhere does not ping.
    await h.step('arrive');
    await expect(fuel).toHaveAttribute('data-live', '');
    await page.waitForTimeout(300);
    expect(await running(page)).not.toContain('ix-dock:ping');

    // The indicator moves with a 65ms opacity fade, not a glide.
    await recordAnimations(page);
    await dockItem(page, 'basecamp').click();
    await expect.poll(async () => (await recorded(page, 'ix-dock:indicator')).duration).toBeDefined();
    const { duration, props } = await recorded(page, 'ix-dock:indicator');
    expect({ duration, props }).toEqual({ duration: 65, props: ['opacity'] });
    await page.waitForTimeout(SETTLE);
    const bar = await box(indicator(page));
    const base = await box(dockItem(page, 'basecamp'));
    expect(Math.abs(bar.x - base.x)).toBeLessThan(1);
    expect(await running(page)).toEqual([]);
  });
});

test.describe('keyboard (§4.8, §10)', () => {
  test('one roving Tab stop, Left and Right wrap, Home and End, Enter switches', async ({ page }) => {
    await open(page);
    // One stop in the Tab order, on the current place.
    const stops = () => page.locator('[data-dock-stop]');
    expect(await stops().evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('tabindex') === '0').map((node) => (node as HTMLElement).dataset.dockStop))).toEqual([GUILD.fuel.id]);

    await dockItem(page, 'fuel').focus();
    await page.keyboard.press('ArrowRight');
    await expect(dockItem(page, 'gameNight')).toBeFocused();
    await page.keyboard.press('End');
    await expect(add(page)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(dockItem(page, 'people')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(add(page)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(dockItem(page, 'people')).toBeFocused();
    // The stop follows focus...
    expect(await stops().evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('tabindex') === '0').map((node) => (node as HTMLElement).dataset.dockStop))).toEqual(['people']);

    // ...and Enter on a place switches to it; the stop goes back to the current place.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dockItem(page, 'gameNight')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD.gameNight.id}/`));
    await expect(dockItem(page, 'gameNight')).toHaveAttribute('aria-current', 'page');
    expect(await stops().evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('tabindex') === '0').map((node) => (node as HTMLElement).dataset.dockStop))).toEqual([GUILD.gameNight.id]);
  });

  test('Ctrl+Alt+Up/Down step through the places and Ctrl+1…9 jump to the nth server', async ({ page }) => {
    await open(page);
    const here = async () => (await items(page).evaluateAll((nodes) => nodes.find((node) => node.hasAttribute('data-current'))?.getAttribute('data-place'))) ?? null;

    await page.keyboard.press('Control+Alt+ArrowDown');
    await expect.poll(here).toBe(GUILD.gameNight.id);
    await page.keyboard.press('Control+Alt+ArrowDown');
    await expect.poll(here).toBe(GUILD.basecamp.id);
    // Down from the last wraps to People; up from People wraps to the last.
    await page.keyboard.press('Control+Alt+ArrowDown');
    await expect.poll(here).toBe('people');
    await page.keyboard.press('Control+Alt+ArrowUp');
    await expect.poll(here).toBe(GUILD.basecamp.id);
    await page.keyboard.press('Control+Alt+ArrowUp');
    await expect.poll(here).toBe(GUILD.gameNight.id);

    await page.keyboard.press('Control+1');
    await expect.poll(here).toBe(GUILD.fuel.id);
    await page.keyboard.press('Control+3');
    await expect.poll(here).toBe(GUILD.basecamp.id);
    // A number with no server behind it does nothing.
    await page.keyboard.press('Control+9');
    await page.waitForTimeout(300);
    expect(await here()).toBe(GUILD.basecamp.id);
  });

  test('the shortcuts work with the message box focused', async ({ page }) => {
    await open(page);
    const input = page.getByRole('main').getByRole('textbox').first();
    await input.click();
    await expect(input).toBeFocused();
    await page.keyboard.press('Control+2');
    await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD.gameNight.id}/`));
  });
});

test.describe('the tooltip (§4.8)', () => {
  test('the name appears above the item after 400ms and lifts the item 2px', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(500);
    const target = dockItem(page, 'gameNight');
    const before = await box(target);
    await target.hover();
    // Not yet at 300ms...
    await page.waitForTimeout(250);
    expect(await page.locator('.ix-dock__tip').evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    // ...there at about 400ms (+ the fade).
    await expect(page.locator('.ix-dock__tip[data-open]')).toHaveText('Game Night');
    await page.waitForTimeout(400);
    const tip = await box(page.locator('.ix-dock__tip'));
    const lifted = await box(target);
    expect(Math.round(before.y - lifted.y)).toBe(2);
    // Centered over the item, above it, near-solid with radius 8 and 12.5/600.
    expect(Math.abs(tip.x - lifted.x)).toBeLessThan(1);
    expect(tip.bottom).toBeLessThan(lifted.top);
    const style = await page.locator('.ix-dock__tip').evaluate((element) => {
      const s = getComputedStyle(element);
      return { radius: s.borderRadius, size: s.fontSize, weight: s.fontWeight, bg: s.backgroundColor };
    });
    expect(style).toEqual({ radius: '8px', size: '12.5px', weight: '600', bg: 'rgba(30, 31, 35, 0.98)' });
    await mkdir(outDir(), { recursive: true });
    await page.screenshot({ path: path.join(outDir(), 'dock-tooltip.png'), clip: { x: 0, y: 640, width: 316, height: 160 } });
  });

  test('keyboard focus names an item at once', async ({ page }) => {
    await open(page);
    await dockItem(page, 'fuel').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ix-dock__tip[data-open]')).toHaveText('Game Night');
  });
});

test.describe('right-click (§6.2)', () => {
  test('on a server it opens the server menu; on People it does not', async ({ page }) => {
    await open(page);
    await dockItem(page, 'gameNight').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Mark as read/ })).toBeVisible();
    await page.waitForTimeout(400);
    await mkdir(outDir(), { recursive: true });
    await page.screenshot({ path: path.join(outDir(), 'dock-server-menu.png'), clip: { x: 0, y: 360, width: 460, height: 440 } });
    // At the pointer: the menu's corner is where the right click was.
    const mark = await box(dockItem(page, 'gameNight'));
    const at = await box(menu);
    expect(Math.abs(at.left - mark.x)).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await dockItem(page, 'people').click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('overflow (§4.8)', () => {
  /** Put nine more servers in the store, as READY would, for 12 in all. */
  async function addServers(page: Page, count: number): Promise<void> {
    // None of them has channels, so a click lands on the server's own page.
    await page.route(/\/api\/v1\/guilds\/9100\d+\/channels$/, (route) => route.fulfill({ headers: epoch, json: [] }));
    await page.route(/\/api\/v1\/guilds\/9100\d+\/channels\/visible$/, (route) => route.fulfill({ headers: epoch, json: { channel_ids: [] } }));
    await page.evaluate(async (extra) => {
      const guildStore = (await import('/src/stores/guildStore.ts' as string)) as {
        useGuildStore: { getState(): { guilds: Array<Record<string, any>>; addGuild(guild: Record<string, any>, scope: Record<string, any>): void } };
      };
      const state = guildStore.useGuildStore.getState();
      const seed = state.guilds[0];
      const names = ['Atlas', 'Birch', 'Cedar', 'Delta', 'Ember', 'Falcon', 'Garden', 'Harbor', 'Iron'];
      for (let i = 0; i < extra; i++) {
        const { scope: _scope, key: _key, originServerId: _origin, server_url: _url, ...guild } = seed;
        state.addGuild({ ...guild, id: `91000000000000${i}00${i}`, name: names[i % names.length], icon: null, icon_hash: null, hue: null, member_count: 4 }, seed.scope);
      }
    }, count);
  }

  test('twelve servers scroll sideways, People and + stay put, fades on the edges, the wheel scrolls it', async ({ page }) => {
    await open(page);
    await addServers(page, 9);
    await expect(items(page)).toHaveCount(13);
    await page.waitForTimeout(SETTLE);

    const scroller = page.locator('.ix-dock__scroll');
    // The dock is still one row inside the sidebar: People first, + last and in view.
    const side = await box(sidebar(page));
    const addBox = await box(add(page));
    const peopleBox = await box(dockItem(page, 'people'));
    expect(addBox.right).toBeLessThanOrEqual(side.right);
    expect(peopleBox.left).toBeGreaterThanOrEqual(side.left);
    expect(Math.round(peopleBox.x)).toBe(33);
    const frame = await box(dock(page));
    expect(Math.round(frame.height)).toBe(66);

    // It overflows, with a fade on the end it has more beyond, and none on the start.
    const metrics = await scroller.evaluate((element) => ({ sw: element.scrollWidth, cw: element.clientWidth, left: element.scrollLeft }));
    expect(metrics.sw).toBeGreaterThan(metrics.cw);
    await expect(scroller).toHaveAttribute('data-fade-end', '');
    await expect(scroller).not.toHaveAttribute('data-fade-start', '');
    expect(await scroller.evaluate((element) => getComputedStyle(element).maskImage || getComputedStyle(element).webkitMaskImage)).toContain('linear-gradient');
    expect(await scroller.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('none');

    // The wheel's vertical delta scrolls it sideways.
    const s = await box(scroller);
    await page.mouse.move(s.x, s.y);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
    await expect(scroller).toHaveAttribute('data-fade-start', '');
    await shoot(page, 'overflow-12-scrolled');
    await shootDock(page, 'dock-overflow-scrolled.png');

    // Going to a server far along scrolls it into view and the indicator follows it.
    await page.keyboard.press('Control+9');
    await page.waitForTimeout(SETTLE);
    const nine = page.getByTestId('ix-dock-item').nth(9);
    const nineBox = await box(nine);
    const view = await box(scroller);
    expect(nineBox.x).toBeGreaterThan(view.left);
    expect(nineBox.x).toBeLessThan(view.right);
    const bar = await box(indicator(page));
    expect(Math.abs(bar.x - nineBox.x)).toBeLessThan(1);
    expect(await indicator(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await shoot(page, 'overflow-12');

    // Scrolling the current server out of view takes the indicator with it.
    await scroller.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect.poll(() => indicator(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  });
});

test.describe('Add a server (§4.8, §6.1)', () => {
  const templates = [
    {
      id: '5000000000000000001',
      name: 'Study group',
      description: 'Channels for notes, questions and a quiet room to work in.',
      creator_id: '1',
      source_guild_id: null,
      usage_count: 12,
      created_at: '2026-09-01T00:00:00Z',
      template_data: {
        channels: [
          { name: 'Study', type: 4, position: 0, parent_name: null },
          { name: 'notes', type: 0, position: 1, parent_name: 'Study' },
          { name: 'questions', type: 0, position: 2, parent_name: 'Study' },
          { name: 'Quiet hour', type: 2, position: 3, parent_name: 'Study' },
        ],
        roles: [{ name: 'Tutor', permissions: '0', color: 0, position: 1 }],
      },
    },
    {
      id: '5000000000000000002',
      name: 'Game night',
      description: '',
      creator_id: '1',
      source_guild_id: null,
      usage_count: 3,
      created_at: '2026-09-02T00:00:00Z',
      template_data: { channels: [{ name: 'lobby', type: 0, position: 0, parent_name: null }], roles: [] },
    },
  ];

  async function openSheet(page: Page) {
    await open(page);
    // Routes are last-wins: these come after the scene's own.
    await page.route('**/api/v1/templates', (route) => route.fulfill({ headers: epoch, json: templates }));
    await add(page).click();
    const sheet = page.getByRole('dialog', { name: 'Add a server' });
    await expect(sheet).toBeVisible();
    // Its entrance (24px, 115ms) has played before anything is measured.
    await page.waitForTimeout(500);
    return sheet;
  }

  test('+ opens the sheet inside main with Create, Join and Discover; Escape closes it and gives focus back', async ({ page }) => {
    const sheet = await openSheet(page);
    await expect(add(page)).toHaveAttribute('aria-expanded', 'true');
    // Inside main, on its right (the sheet host), not over the sidebar.
    const main = await box(page.getByRole('main'));
    const frame = await box(sheet);
    expect(frame.left).toBeGreaterThanOrEqual(main.left);
    expect(frame.right).toBeLessThanOrEqual(main.right);
    await expect(sheet.getByRole('tab')).toHaveText(['Create', 'Join', 'Discover']);
    await expect(sheet.getByRole('tab', { name: 'Create' })).toHaveAttribute('aria-selected', 'true');
    // The name has focus, with the suggestion in it.
    await expect(sheet.getByLabel('Server name')).toBeFocused();
    await expect(sheet.getByLabel('Server name')).toHaveValue(/'s server$/);
    await page.waitForTimeout(SETTLE);
    await shoot(page, 'add-a-server-create');

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(add(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(add(page)).toBeFocused();
  });

  test('Create offers Blank and the instance\'s templates; a template creates the server from it', async ({ page }) => {
    const sheet = await openSheet(page);
    const choices = sheet.getByRole('radio');
    await expect(choices).toHaveCount(3);
    await expect(choices.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.getByText('Study group')).toBeVisible();
    await expect(sheet.getByText('3 channels · 1 role')).toBeVisible();

    let applied: { url: string; body: unknown } | null = null;
    await page.route('**/api/v1/templates/*/apply', async (route) => {
      applied = { url: route.request().url(), body: route.request().postDataJSON() };
      await route.fulfill({
        headers: epoch,
        json: { ...(await page.evaluate(() => (window as any).__ixProbe.guilds.getState().guilds[0])), id: '5100000000000000001', name: 'Book club', scope: undefined, key: undefined },
        status: 201,
      });
    });
    // The new server has no channels yet: its landing falls back to its own page.
    await page.route('**/api/v1/guilds/5100000000000000001/channels', (route) => route.fulfill({ headers: epoch, json: [] }));
    await page.route('**/api/v1/guilds/5100000000000000001/channels/visible', (route) =>
      route.fulfill({ headers: epoch, json: { channel_ids: [] } }),
    );
    await choices.nth(1).click();
    await expect(choices.nth(1)).toHaveAttribute('aria-checked', 'true');
    // A picture applies to a blank server only: choosing a template puts its row away.
    await expect(sheet.getByText('Add a picture')).toHaveCount(0);
    await sheet.getByLabel('Server name').fill('Book club');
    await page.waitForTimeout(SETTLE);
    await shoot(page, 'add-a-server-template');
    await sheet.getByRole('button', { name: 'Create server' }).click();
    await expect.poll(() => applied).not.toBeNull();
    expect(applied!.url).toContain('/templates/5000000000000000001/apply');
    expect(applied!.body).toEqual({ name: 'Book club' });
    // It lands on the new server and puts the sheet away.
    await expect(page).toHaveURL(/\/app\/guilds\/5100000000000000001/);
    await expect(sheet).toBeHidden();
  });

  test('Join takes a link or a code and says in words when the invite is refused', async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByRole('tab', { name: 'Join' }).click();
    await expect(sheet.getByRole('tab', { name: 'Join' })).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.getByRole('button', { name: 'Join server' })).toBeDisabled();
    await page.route('**/api/v1/invites/*', (route) =>
      route.fulfill({ status: 404, headers: epoch, json: { code: 'NOT_FOUND', message: 'That invite has expired.' } }),
    );
    await sheet.getByLabel('Invite link').fill('hTKzmak');
    await page.waitForTimeout(SETTLE);
    await shoot(page, 'add-a-server-join');
    await sheet.getByRole('button', { name: 'Join server' }).click();
    await expect(sheet.getByRole('alert')).toContainText('That invite has expired.');
    // The form stays as it was.
    await expect(sheet.getByLabel('Invite link')).toHaveValue('hTKzmak');
    await page.waitForTimeout(400);
    await shoot(page, 'add-a-server-join-error');
  });

  test('Discover opens the Discover page in main and puts the sheet away; the tabs take arrow keys', async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByRole('tab', { name: 'Create' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(sheet.getByRole('tab', { name: 'Join' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(sheet.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(sheet.getByRole('tab', { name: 'Create' })).toHaveAttribute('aria-selected', 'true');
    await sheet.getByRole('tab', { name: 'Discover' }).click();
    await page.waitForTimeout(SETTLE);
    await shoot(page, 'add-a-server-discover');
    await sheet.getByRole('button', { name: 'Discover servers' }).click();
    await expect(page).toHaveURL(/\/app\/discovery/);
    await expect(sheet).toBeHidden();
  });

  test('moving to another place puts the sheet away', async ({ page }) => {
    const sheet = await openSheet(page);
    await navigate(page, routes.channel('gnLounge'));
    await expect(sheet).toBeHidden();
  });
});

test.describe('sizes', () => {
  test('1440x900, 900x700 and 390x844', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await page.waitForTimeout(SETTLE);
    await shoot(page, 'dock', { size: 'desktop' });
    await shoot(page, 'dock', { size: 'narrow' });
    // At 900 the sidebar is 280 wide and the dock is still one row of four places and +.
    const side = await box(sidebar(page));
    expect(Math.round(side.width)).toBe(280);
    const addBox = await box(add(page));
    expect(addBox.right).toBeLessThanOrEqual(side.right);
    await shoot(page, 'dock', { size: 'phone' });
    // The phone's root screen is the sidebar with the dock at its foot (IX-16 finishes it:
    // 64px bar, 44px targets). The dock is still one working row there.
    await page.getByRole('button', { name: 'Back to the sidebar' }).first().click();
    await page.waitForTimeout(SETTLE);
    await expect(dock(page)).toBeVisible();
    const phoneDock = await box(dock(page));
    expect(phoneDock.right).toBeLessThanOrEqual(390);
    expect(Math.round(phoneDock.bottom)).toBe(844);
    await shoot(page, 'dock-root', { size: 'phone' });
  });
});
