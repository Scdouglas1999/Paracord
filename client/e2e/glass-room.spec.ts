import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { BASECAMP_ID, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * The room light (WP-G8, docs/glass-spec.md §4) in a real Chromium, against
 * the mocked Glass scene with the DEV fixture stream lighting Game Night.
 *
 *   PARACORD_E2E_GLASS_WP=g8 npx playwright test -c e2e/glass-room.config.ts
 *
 * Shots land in output/design-reference/glass-build/<WP>/room-*.png, and the
 * measured budget in room-budget.json beside them.
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'latest';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const route = (guild: string, channel: string) => `/app/guilds/${guild}/channels/${channel}`;

const hsv = ([r, g, b]: number[]) => {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r / 255) h = 60 * ((((g - b) / 255) / d) % 6);
    else if (max === g / 255) h = 60 * (((b - r) / 255) / d + 2);
    else h = 60 * (((r - g) / 255) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
};

async function roomRgb(page: Page): Promise<number[]> {
  const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--room-rgb'));
  return value.split(',').map((part) => Number(part.trim()));
}

async function waitLit(page: Page, source: string) {
  const backdrop = page.locator('.glass-room-backdrop');
  await expect(backdrop).toHaveAttribute('data-room-source', source);
  await expect(backdrop).toHaveAttribute('data-room-phase', 'lit', { timeout: 15_000 });
}

async function open(page: Page, url: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installGlassScene(page);
  // Count the backdrop's canvas paints (putImageData on a room layer).
  await page.addInitScript(() => {
    const w = window as unknown as { __roomPaints: number };
    w.__roomPaints = 0;
    const original = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function patched(this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (this.canvas.classList.contains('glass-room-backdrop__layer')) w.__roomPaints += 1;
      return (original as (...a: unknown[]) => void).apply(this, args);
    };
  });
  await page.goto(url);
  await expect(page.getByRole('main')).toBeVisible();
}

/**
 * The real READY carries no `banner_hash` (only the REST guild list does), and
 * today a READY landing while that list is in flight replaces the REST
 * projection in `guildStore` (see docs/design/glass-g8-checkpoint.md,
 * "Banner race"). Put the REST projection's banner back, as a finished list
 * would, so the banner path is tested on its own.
 */
async function landBanner(page: Page, guildId: string) {
  await page.evaluate(async (id) => {
    const modulePath = '/src/stores/guildStore.ts';
    const { useGuildStore } = (await import(/* @vite-ignore */ modulePath)) as typeof import('../src/stores/guildStore');
    const state = useGuildStore.getState();
    const guild = state.guilds.find((candidate) => candidate.id === id);
    if (!guild) throw new Error('no guild');
    state.updateGuildData(id, { banner_hash: `/api/v1/guilds/${id}/banner` }, guild.scope);
  }, guildId);
}

async function shot(page: Page, name: string) {
  await page.mouse.move(1437, 897);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test('a server with a live stream lights the room from the stream (warm)', async ({ page }) => {
  await open(page, route(GAME_NIGHT_ID, CH.general));
  await waitLit(page, 'stream-ambient');
  await page.waitForTimeout(2_500);
  const rgb = await roomRgb(page);
  const color = hsv(rgb);
  expect(color.s).toBeLessThanOrEqual(0.856);
  expect(color.v).toBeGreaterThanOrEqual(0.774);
  // The fixture cave is lit by an amber lamp.
  expect(color.h).toBeGreaterThan(10);
  expect(color.h).toBeLessThan(60);
  await shot(page, 'room-01-warm');
});

test('a server with nothing live lights the room from its banner (cool)', async ({ page }) => {
  await open(page, route(BASECAMP_ID, CH.trips));
  await landBanner(page, BASECAMP_ID);
  await waitLit(page, 'banner');
  await page.waitForTimeout(2_500);
  const color = hsv(await roomRgb(page));
  expect(color.h).toBeGreaterThan(180);
  expect(color.h).toBeLessThan(250);
  await shot(page, 'room-02-cool');
});

test('switching servers crossfades the room over 1.2 s', async ({ page }) => {
  await open(page, route(GAME_NIGHT_ID, CH.general));
  await waitLit(page, 'stream-ambient');
  await page.waitForTimeout(2_000);
  await landBanner(page, BASECAMP_ID);
  await page.locator('[title="Basecamp"]').first().click();
  const samples: Array<{ at: number; opacities: number[]; room: string }> = [];
  const started = Date.now();
  for (const at of [0, 300, 600, 900, 1_300, 2_500]) {
    const wait = at - (Date.now() - started);
    if (wait > 0) await page.waitForTimeout(wait);
    samples.push({
      at,
      opacities: await page.$$eval('.glass-room-backdrop__layer', (layers) =>
        layers.map((layer) => Number(getComputedStyle(layer).opacity)),
      ),
      room: await page.evaluate(() => document.documentElement.style.getPropertyValue('--room-rgb')),
    });
    await shot(page, `room-crossfade-${String(at).padStart(4, '0')}ms`);
  }
  await writeFile(path.join(OUT_DIR, 'room-crossfade.json'), JSON.stringify(samples, null, 2));
  // Mid-fade both layers are partly visible; at the end only one is.
  const mid = samples.find((sample) => sample.at === 600)!;
  expect(mid.opacities.every((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true);
  const end = samples[samples.length - 1];
  expect(end.opacities.sort()).toEqual([0, 1]);
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-source', 'banner');
});

test('the budget: --room-rgb at most 4 writes a second, nothing else written on <html>, paints at most 4 a second', async ({ page }) => {
  await open(page, route(GAME_NIGHT_ID, CH.general));
  await waitLit(page, 'stream-ambient');
  const result = await page.evaluate(async () => {
    const root = document.documentElement;
    const writes: Array<{ at: number; value: string }> = [];
    let lastStyle = root.getAttribute('style') ?? '';
    const otherChanges: string[] = [];
    const observer = new MutationObserver(() => {
      const style = root.getAttribute('style') ?? '';
      if (style === lastStyle) return;
      const without = (s: string) => s.replace(/--room-rgb:[^;]*;?/, '').trim();
      if (without(style) !== without(lastStyle)) otherChanges.push(style);
      lastStyle = style;
      writes.push({ at: performance.now(), value: root.style.getPropertyValue('--room-rgb') });
    });
    observer.observe(root, { attributes: true, attributeFilter: ['style'] });
    const w = window as unknown as { __roomPaints: number };
    const paintsBefore = w.__roomPaints;
    const t0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    observer.disconnect();
    let maxInOneSecond = 0;
    for (const write of writes) {
      const inWindow = writes.filter((other) => other.at >= write.at && other.at < write.at + 1000).length;
      maxInOneSecond = Math.max(maxInOneSecond, inWindow);
    }
    return {
      seconds: (performance.now() - t0) / 1000,
      writes: writes.length,
      maxWritesInOneSecond: maxInOneSecond,
      otherChanges,
      paints: w.__roomPaints - paintsBefore,
      values: writes.map((write) => write.value),
    };
  });
  await writeFile(path.join(OUT_DIR, 'room-budget.json'), JSON.stringify(result, null, 2));
  expect(result.maxWritesInOneSecond).toBeLessThanOrEqual(4);
  expect(result.otherChanges).toEqual([]);
  expect(result.paints / result.seconds).toBeLessThanOrEqual(4.2);
});

test('Home rests on the default room and stops lighting', async ({ page }) => {
  await open(page, route(GAME_NIGHT_ID, CH.general));
  await waitLit(page, 'stream-ambient');
  await page.getByRole('button', { name: /^Home and direct messages/ }).click();
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-source', 'none');
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-phase', 'idle');
  // Most of the ease is over in under two seconds; the last few channel units
  // land when it settles, about three and a half seconds after a full swing.
  await page.waitForTimeout(5_000);
  expect(await roomRgb(page)).toEqual([82, 143, 219]);
  await shot(page, 'room-home-default');
});

test('reduced transparency keeps the room but takes the blur away', async ({ page }) => {
  await open(page, route(BASECAMP_ID, CH.trips));
  await landBanner(page, BASECAMP_ID);
  await waitLit(page, 'banner');
  await page.evaluate(() => document.documentElement.setAttribute('data-reduced-transparency', 'true'));
  await page.waitForTimeout(2_500);
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-phase', 'lit');
  await shot(page, 'room-02-reduced-transparency');
});
