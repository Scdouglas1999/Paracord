import { expect, test, type Page } from '@playwright/test';
import { GUILD, HISTORY_EPOCH, ME, PEOPLE, installIndexScene, shoot, sidebar, type IndexHarness, type SizeName } from './fixtures/index';

/**
 * Settings keep what they draw inside the settings surface.
 *
 * The bug this holds: Server settings > File storage drew a giant half circle
 * over the left of the app, on top of the index. The usage meter's fill
 * (`.pc-meter-fill`) was absolutely positioned and sized `inset: 0`, and its
 * track did not establish a containing block, so the fill took the whole
 * settings window as its box, slid left by the unused share of the quota and
 * wore the track's full-pill radius (a 1200 x 900 box with a 33-million-pixel
 * radius is a half circle). Nothing caught it because the scene's storage route
 * answers `[]`: no quota, no meter.
 *
 * What is asserted, for every section of User settings and of Server settings,
 * at 1280x800 and 1440x900, with the data a real server sends:
 *
 *   1. Nothing under the section's scroll box paints outside it (the check
 *      follows each element's containing-block chain, so an absolutely
 *      positioned fill that escapes its track is caught wherever it lands).
 *   2. Nothing under the index paints outside the index.
 *   3. Every index row is the topmost thing at its own center (a stray layer
 *      over the index would take the click).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-settings-containment PARACORD_E2E_INDEX_PORT=4793 \
 *   PARACORD_E2E_INDEX_RT_PORT=4795 PARACORD_E2E_INDEX_WP=settings-containment \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Shots land in output/design-reference/index-build/settings-containment/.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

async function open(page: Page, viewport = { width: 1440, height: 900 }): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize(viewport);
  const h = await installIndexScene(page);
  await h.open(h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

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

/* ------------------------------------------------------------------ the server's answers */

const MB = 1024 * 1024;
const GB = 1024 * MB;

type Answer = { status?: number; body?: unknown };

/** Answer `GET <pattern>` the way a server would. Routes are last-wins, so this sits over the scene's `[]`. */
async function answer(page: Page, pattern: string, response: Answer): Promise<void> {
  await page.route(pattern, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const status = response.status ?? 200;
    return route.fulfill({
      status,
      contentType: 'application/json',
      // An older server's router answers a route it lacks with an empty 404 and no history epoch.
      headers: status === 404 && response.body === undefined ? {} : { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
      body: response.body === undefined ? '' : JSON.stringify(response.body),
    });
  });
}

const files = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(910_000_000_000_000_000n + BigInt(i)),
    filename: i === 2 ? 'a-very-long-filename-for-a-screen-recording-of-the-whole-weekend-lan-party-final-v3.mp4' : `clip-${i + 1}.png`,
    content_type: i === 2 ? 'video/mp4' : 'image/png',
    size: (i + 1) * 3 * MB,
    uploader_id: null,
    created_at: '2026-09-28T19:20:00-05:00',
  }));

interface StorageCase {
  name: string;
  /** What the section must say: the readout, or why there is none. */
  shows?: 'older-server' | 'forbidden' | 'error';
  storage?: Answer;
  files?: Answer;
}

/** Server settings > File storage in every state it can be in (the owner's server is one that 404s). */
const STORAGE_CASES: StorageCase[] = [
  {
    name: 'quota-36pct-files',
    storage: {
      body: {
        usage: 180 * MB,
        quota: 500 * MB,
        policy: { max_file_size: 25 * MB, storage_quota: 500 * MB, retention_days: 90, allowed_types: null, blocked_types: ['application/x-msdownload'] },
      },
    },
    files: { body: files(6) },
  },
  { name: 'quota-0pct-empty', storage: { body: { usage: 0, quota: 5 * GB, policy: null } }, files: { body: [] } },
  { name: 'quota-60pct-empty', storage: { body: { usage: 3 * GB, quota: 5 * GB, policy: null } }, files: { body: [] } },
  { name: 'quota-95pct-files', storage: { body: { usage: 4.75 * GB, quota: 5 * GB, policy: null } }, files: { body: files(3) } },
  { name: 'quota-full', storage: { body: { usage: 5 * GB, quota: 5 * GB, policy: null } }, files: { body: files(2) } },
  { name: 'no-quota-files', storage: { body: { usage: 41 * MB, quota: null, policy: null } }, files: { body: files(4) } },
  { name: 'no-quota-empty', storage: { body: { usage: 0, quota: null, policy: null } }, files: { body: [] } },
  {
    name: 'forbidden-403',
    shows: 'forbidden',
    storage: { status: 403, body: { code: 'MISSING_PERMISSIONS', message: 'Missing permissions' } },
    files: { status: 403, body: { code: 'MISSING_PERMISSIONS', message: 'Missing permissions' } },
  },
  {
    name: 'route-answered-404',
    shows: 'error',
    storage: { status: 404, body: { code: 'NOT_FOUND', message: 'Unknown guild' } },
    files: { body: [] },
  },
  {
    name: 'server-error-500',
    shows: 'error',
    storage: { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' } },
    files: { body: [] },
  },
  // Last: the page remembers an older server until it reconnects. The owner's server is one,
  // and its router answers a route it lacks with an empty 404 (no body, no history epoch).
  { name: 'older-server-404', shows: 'older-server', storage: { status: 404 }, files: { status: 404 } },
];

/** Economy: your level a third of the way to the next, a leaderboard with you on it. */
async function answerEconomy(page: Page, guildId: string): Promise<void> {
  await answer(page, '**/api/v1/guilds/*/economy/me', {
    body: {
      guild_id: guildId,
      user_id: ME.id,
      xp: 340,
      level: 3,
      rank: 2,
      progress: { current_level_floor: 300, next_level_at: 600, xp_into_level: 40, xp_required_this_level: 300 },
      streak: { days: 4, longest_days: 9 },
      achievements: [],
    },
  });
  await answer(page, '**/api/v1/guilds/*/economy/leaderboard*', {
    body: {
      guild_id: guildId,
      limit: 8,
      entries: [PEOPLE.jeremy, ME, PEOPLE.vincent].map((p, i) => ({
        rank: i + 1,
        user: { id: p.id, username: p.username, display_name: p.display_name, discriminator: 0, avatar: null },
        xp: 900 - i * 280,
        level: 5 - i,
        streak_days: 7 - i * 2,
        last_xp_at: '2026-10-01T21:30:00-05:00',
      })),
    },
  });
}

async function answerStorage(page: Page, c: StorageCase): Promise<void> {
  if (c.storage) await answer(page, '**/api/v1/guilds/*/storage', c.storage);
  if (c.files) await answer(page, '**/api/v1/guilds/*/files*', c.files);
}

/* ------------------------------------------------------------------ the check */

interface Offender {
  where: 'section' | 'index';
  element: string;
  position: string;
  rect: [number, number, number, number];
  surface: [number, number, number, number];
}

/**
 * Every element under `.ix-settings__scroll` (the section) and `.ix-settings__nav`
 * (the index) whose visible rectangle leaves its own surface.
 *
 * The visible rectangle is the element's box clipped by every ancestor that
 * clips it. Which ancestors clip is a matter of containing blocks, not of the
 * DOM: an overflow clips a descendant only when the descendant's containing
 * block chain runs through it, so an absolutely positioned child of a static
 * track is NOT clipped by that track, only by whatever positioned ancestor
 * claims it. That is the escape this finds. `position: fixed` is clipped by
 * nothing (it is the viewport's), so it must sit inside the surface on its own.
 */
async function offenders(page: Page): Promise<Offender[]> {
  return page.evaluate(() => {
    const label = (el: Element) => {
      const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 3).join('.');
      return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
    };
    const establishesBlock = (cs: CSSStyleDeclaration) =>
      cs.position !== 'static' ||
      cs.transform !== 'none' ||
      cs.perspective !== 'none' ||
      cs.filter !== 'none' ||
      /transform|perspective|filter/.test(cs.willChange) ||
      /paint|layout|strict|content/.test(cs.contain);
    const containsPaint = (cs: CSSStyleDeclaration) => /paint|strict|content/.test(cs.contain);

    const visibleRect = (el: Element, ceiling: Element) => {
      const own = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      let left = box.left;
      let top = box.top;
      let right = box.right;
      let bottom = box.bottom;
      if (own.position === 'fixed') return { left, top, right, bottom };
      let skipping = own.position === 'absolute';
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (skipping) {
          if (!establishesBlock(cs)) continue;
          skipping = false;
        }
        const clipX = cs.overflowX !== 'visible' || containsPaint(cs);
        const clipY = cs.overflowY !== 'visible' || containsPaint(cs);
        if (clipX || clipY) {
          const clip = a.getBoundingClientRect();
          if (clipX) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (clipY) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        if (cs.position === 'fixed') break;
        if (cs.position === 'absolute') skipping = true;
        if (a === ceiling) break;
      }
      return { left, top, right, bottom };
    };

    const found: Offender[] = [];
    const scan = (surface: Element | null, where: Offender['where']) => {
      if (!surface) {
        found.push({ where, element: `(no .${where === 'section' ? 'ix-settings__scroll' : 'ix-settings__nav'})`, position: '', rect: [0, 0, 0, 0], surface: [0, 0, 0, 0] });
        return;
      }
      const s = surface.getBoundingClientRect();
      const slack = 1;
      for (const el of surface.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
        const v = visibleRect(el, surface);
        if (v.right - v.left <= 0 || v.bottom - v.top <= 0) continue;
        // A visually hidden 1px node (a live region, an sr-only label) paints nothing.
        if (v.right - v.left <= 1 && v.bottom - v.top <= 1) continue;
        if (v.left < s.left - slack || v.right > s.right + slack || v.top < s.top - slack || v.bottom > s.bottom + slack) {
          found.push({
            where,
            element: label(el),
            position: cs.position,
            rect: [Math.round(v.left), Math.round(v.top), Math.round(v.right - v.left), Math.round(v.bottom - v.top)],
            surface: [Math.round(s.left), Math.round(s.top), Math.round(s.width), Math.round(s.height)],
          });
        }
      }
    };
    scan(document.querySelector('.ix-settings__scroll'), 'section');
    scan(document.querySelector('.ix-settings__nav'), 'index');
    return found;
  });
}

/** Index rows that something else sits over: the topmost thing at a row's center is not the row. */
async function coveredIndexRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const covered: string[] = [];
    for (const row of document.querySelectorAll('.ix-settings__nav button, .ix-settings__nav [role="button"], .ix-settings__nav a')) {
      const r = row.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > innerHeight) continue; // scrolled out of the index's own scroll box
      const top = document.elementFromPoint(cx, cy);
      if (!top || !row.contains(top)) {
        covered.push(`${(row.textContent ?? '').trim()} (covered by ${top ? `${top.tagName.toLowerCase()}.${top.getAttribute('class') ?? ''}` : 'nothing'})`);
      }
    }
    return covered;
  });
}

async function expectContained(page: Page, what: string): Promise<void> {
  const found = await offenders(page);
  expect(found, `${what}: something paints outside the settings surface`).toEqual([]);
  expect(await coveredIndexRows(page), `${what}: something sits over the index`).toEqual([]);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Click every row of the index, one after the other, checking and shooting each. */
async function sweep(page: Page, dialog: 'User settings' | 'Server settings', prefix: string, sizes: SizeName[]): Promise<string[]> {
  const nav = page.locator('.ix-settings__nav');
  // The sections, not the index's footer (a portal link, Log out).
  const labels = (await nav.locator('.ix-settings__group button').allTextContents()).map((text) => text.trim()).filter(Boolean);
  expect(labels.length, `${dialog}: the index has rows`).toBeGreaterThan(4);
  for (const text of labels) {
    for (const size of sizes) {
      await page.setViewportSize(size === 'desktop' ? { width: 1440, height: 900 } : { width: 1280, height: 800 });
      const row = nav.getByRole('button', { name: text, exact: true });
      await row.click();
      await expect(row).toHaveAttribute('aria-current', 'page');
      await page.waitForTimeout(600);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectContained(page, `${dialog} > ${text} at ${size}`);
      await shoot(page, `${prefix}-${slug(text)}`, { size, settle: 200 });
    }
  }
  return labels;
}

/* ------------------------------------------------------------------ the specs */

test.describe('settings paint inside their surface', () => {
  test('File storage in every state: the meter stays in its track', async ({ page }) => {
    test.setTimeout(240_000);
    await open(page);
    for (const c of STORAGE_CASES) {
      await answerStorage(page, c);
      await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'openGuildSettings', GUILD.fuel.id, 'overview');
      await expect(page.getByRole('dialog', { name: 'Server settings' })).toBeVisible();
      await page.locator('.ix-settings__nav').getByRole('button', { name: 'File storage', exact: true }).click();
      await expect(page.locator('.ix-settings__title')).toHaveText('File storage');
      await page.waitForTimeout(700);
      await expectContained(page, `File storage (${c.name})`);

      // The meter, when the server reports a quota, is a bar inside its own track.
      const quota = (c.storage?.body as { quota?: number | null } | undefined)?.quota;
      const meter = page.getByRole('progressbar');
      const section = page.locator('.ix-settings__col');
      if (c.shows) {
        // No readout was given, so none is drawn: no 0 B, no empty policy form, no "no files".
        await expect(section.getByText('Storage used'), `${c.name}: no readout`).toHaveCount(0);
        await expect(section.getByText('no quota set'), `${c.name}: no readout`).toHaveCount(0);
        await expect(meter, `${c.name}: no meter`).toHaveCount(0);
        await expect(section.getByRole('button', { name: 'Save policy' }), `${c.name}: no policy form`).toHaveCount(0);
        await expect(section.getByText('No files stored yet'), `${c.name}: no empty list`).toHaveCount(0);
        const unavailable = section.getByTestId('file-storage-unavailable');
        const forbidden = section.getByTestId('file-storage-forbidden');
        const failed = section.getByTestId('file-storage-failed');
        await expect(unavailable).toHaveCount(c.shows === 'older-server' ? 1 : 0);
        await expect(forbidden).toHaveCount(c.shows === 'forbidden' ? 1 : 0);
        await expect(failed).toHaveCount(c.shows === 'error' ? 1 : 0);
        if (c.shows === 'older-server') await expect(unavailable).toContainText('older version of Paracord');
        if (c.shows === 'forbidden') await expect(forbidden).toContainText('Manage Server permission');
        if (c.shows === 'error') {
          await expect(failed).toContainText((c.storage?.body as { message: string }).message);
          await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
        }
      } else if (quota) {
        const track = await meter.boundingBox();
        const fill = await meter.locator('.pc-meter-fill').boundingBox();
        expect(track, `${c.name}: the track`).not.toBeNull();
        expect(fill, `${c.name}: the fill`).not.toBeNull();
        expect(track!.width, `${c.name}: a track, not a column`).toBeLessThan(720);
        expect(track!.height, `${c.name}: a track, not a column`).toBeLessThan(20);
        expect(fill!.height).toBeLessThanOrEqual(track!.height + 1);
        expect(fill!.width).toBeLessThanOrEqual(track!.width + 1);
      } else {
        await expect(meter).toHaveCount(0);
        await expect(section.getByText('no quota set')).toHaveCount(1);
      }
      await shoot(page, `file-storage-${c.name}`, { size: 'desktop', settle: 150 });
      await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setGuildSettingsId', null);
      await page.waitForTimeout(250);
    }
  });

  test('every meter shape keeps its fill inside its track, positioned or not', async ({ page }) => {
    await open(page);
    // The track markup of each `pc-meter-fill` consumer, plus the shape that broke (a static
    // track that only clips). Each fill is slid in by --pc-fill of the track's width.
    const tracks: Array<{ name: string; track: string; fill: string }> = [
      { name: 'static-clip-only', track: 'mt-3 h-2.5 w-full overflow-hidden rounded-[var(--radius-full)] bg-bg-mod-strong', fill: 'pc-meter-fill bg-accent-primary' },
      { name: 'file-storage', track: 'pc-meter mt-3 h-2.5 w-full rounded-[var(--radius-full)] bg-bg-mod-strong', fill: 'pc-meter-fill bg-accent-primary' },
      { name: 'activity-track', track: 'pc-meter h-1 w-full rounded-[var(--radius-full)] bg-bg-mod-strong', fill: 'pc-meter-fill is-live bg-text-secondary' },
      { name: 'mic-level', track: 'relative h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-mod-strong', fill: 'pc-meter-fill is-live bg-accent-primary' },
      { name: 'economy', track: 'glass-economy__meter', fill: 'pc-meter-fill glass-economy__fill' },
    ];
    const fills = [0, 0.36, 1];
    const measured = await page.evaluate(
      ({ tracks, fills }) => {
        const host = document.createElement('div');
        host.id = 'meter-lab';
        // Inside a positioned, clipped region the size of the window, the way settings sit.
        host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;padding:48px 280px;display:flex;flex-direction:column;gap:14px;overflow:hidden';
        document.body.appendChild(host);
        const out: Array<{ name: string; fill: number; track: DOMRect; bar: DOMRect }> = [];
        for (const t of tracks) {
          for (const fill of fills) {
            const track = document.createElement('div');
            track.className = t.track;
            track.dataset.lab = `${t.name}@${fill}`;
            const bar = document.createElement('div');
            bar.className = t.fill;
            bar.style.setProperty('--pc-fill', String(fill));
            bar.style.transition = 'none';
            track.appendChild(bar);
            host.appendChild(track);
            out.push({ name: t.name, fill, track: track.getBoundingClientRect(), bar: bar.getBoundingClientRect() });
          }
        }
        return out.map((m) => ({
          name: m.name,
          fill: m.fill,
          track: { x: m.track.x, y: m.track.y, width: m.track.width, height: m.track.height },
          bar: { x: m.bar.x, y: m.bar.y, width: m.bar.width, height: m.bar.height },
        }));
      },
      { tracks, fills },
    );
    for (const m of measured) {
      const where = `${m.name} at ${m.fill}`;
      expect(m.track.height, `${where}: the track is a bar`).toBeLessThan(20);
      expect(m.bar.height, `${where}: the fill is the track's height`).toBeCloseTo(m.track.height, 0);
      expect(m.bar.width, `${where}: the fill is the track's width`).toBeCloseTo(m.track.width, 0);
      // Slid in from the left: its right edge sits `fill` of the way along the track.
      const right = m.bar.x + m.bar.width;
      expect(right, `${where}: the right edge`).toBeCloseTo(m.track.x + m.track.width * m.fill, 0);
    }
    await shoot(page, 'meter-shapes', { size: 'desktop', settle: 100 });
  });

  test('Server settings: every section', async ({ page }) => {
    test.setTimeout(480_000);
    await open(page);
    await answerStorage(page, STORAGE_CASES[0]);
    await answerEconomy(page, GUILD.fuel.id);
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'openGuildSettings', GUILD.fuel.id, 'overview');
    await expect(page.getByRole('dialog', { name: 'Server settings' })).toBeVisible();
    const labels = await sweep(page, 'Server settings', 'server', ['reference', 'desktop']);
    expect(labels).toContain('File storage');
    expect(labels).toContain('Economy');
  });

  test('User settings: every section', async ({ page }) => {
    test.setTimeout(240_000);
    await open(page);
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', true, 'account');
    await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
    const labels = await sweep(page, 'User settings', 'user', ['reference', 'desktop']);
    expect(labels).toContain('Appearance');
  });
});
