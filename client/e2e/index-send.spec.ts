import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_EPOCH, installIndexScene, outDir, type IndexHarness } from './fixtures/index';

/**
 * M1 (send-flight merge): the send flight (docs/glass-spec.md §9, the owner's
 * protected signature gesture) in the Index frame, on the Index scene. The
 * Glass spec (`glass-send.spec.ts`) films it on the Glass scene and goes when
 * IX-19 retires the Glass specs; this one stays, so the flight keeps coverage
 * through IX-11 (timeline rebuild) and IX-12 (message box rebuild).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-send PARACORD_E2E_INDEX_PORT=4683 \
 *   PARACORD_E2E_INDEX_RT_PORT=4685 PARACORD_E2E_INDEX_WP=m1 \
 *   npx playwright test -c e2e/index-review.config.ts
 *
 * Frames: output/design-reference/index-build/<WP>/send/<case>/ (full window
 * `NNNms.png`, conversation crop `NNNms-crop.png`).
 *
 * The selectors below are the flight's DOM contract (docs/design/
 * index-checkpoints/M1.md). IX-11 and IX-12 may restyle everything around them
 * but must keep these hooks, or move them here and in the flight together.
 */
const SEL = {
  /** The message box's text area: the flight reads where the words sit from it. */
  input: 'textarea[data-composer-input]',
  /** A timeline row is `#msg-<id>`; your own carries `data-own`. */
  ownRow: '[id^="msg-"][data-own]',
  /** The bubble inside a row: what the ghost lands on. */
  bubble: '.glass-bubble',
  /** The ghost the engine flies, in the fixed ghost layer. */
  ghost: '.glass-flight',
  /** A row held for the flight ('air': hidden, 'held': landed, awaiting the server). */
  held: '[data-flight]',
} as const;

const OFFSETS = [0, 50, 110, 150, 260, 620] as const;
const FRAMES = path.join(outDir(), 'send');

const composer = (page: Page) => page.locator(SEL.input);

async function open(page: Page, options: { busy?: boolean } = {}): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page, { video: false });
  await h.open(h.routes.channel('fuelGeneral'));
  if (options.busy !== false) {
    await h.step('arrive');
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await expect(page.getByText('yep, bringing the projector', { exact: true })).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  // The messaging runtime recovers the conversation after it opens; a send in
  // that window is refused. The flight is about the send that is accepted.
  await page.waitForTimeout(1500);
  return h;
}

/** Answer sends after `latencyMs`, or refuse them; otherwise the harness's own POST answers. */
async function server(page: Page, options: { latencyMs?: number; refuse?: boolean }) {
  await page.route('**/api/v1/channels/*/messages', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    if (options.refuse) {
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
        body: JSON.stringify({ code: 'FORBIDDEN', message: 'You cannot post here.' }),
      });
    }
    return route.fallback();
  });
}

async function type(page: Page, text: string) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.waitForTimeout(400);
}

/** The conversation column from 420px above the composer down to below it. */
async function crop(page: Page) {
  const input = await composer(page).boundingBox();
  const main = await page.getByRole('main').boundingBox();
  if (!input || !main) throw new Error('no composer or main');
  const top = Math.max(main.y, input.y - 420);
  return { x: main.x, y: top, width: main.width, height: Math.min(main.y + main.height, input.y + input.height + 40) - top };
}

async function freeze(page: Page) {
  return page.evaluate(() => {
    const flight = document
      .getAnimations()
      .filter((animation) => animation.id.startsWith('data-motion-recipe:send') && animation.playState === 'running');
    (window as unknown as { __flight: Animation[] }).__flight = flight;
    for (const animation of flight) animation.pause();
    return flight.length;
  });
}

async function seek(page: Page, at: number) {
  await page.evaluate((time) => {
    for (const animation of (window as unknown as { __flight: Animation[] }).__flight) animation.currentTime = time;
  }, at);
}

async function resume(page: Page) {
  await page.evaluate(() => {
    for (const animation of (window as unknown as { __flight: Animation[] }).__flight) animation.play();
  });
}

/** Send and film the flight at each offset, full window and conversation crop. */
async function film(page: Page, name: string) {
  const dir = path.join(FRAMES, name);
  await mkdir(dir, { recursive: true });
  const clip = await crop(page);
  await page.screenshot({ path: path.join(dir, 'before.png') });
  await page.keyboard.press('Enter');
  const airborne = await freeze(page);
  expect(airborne, 'the flight is airborne on the keystroke').toBeGreaterThan(0);
  // Mark the stand-in row's node, to prove the delivered row is the same node.
  const marked = await page.evaluate((held) => {
    const row = document.querySelector<HTMLElement>(held);
    if (!row) return null;
    (row as unknown as { __standIn: boolean }).__standIn = true;
    return row.id;
  }, SEL.held);
  expect(marked, 'a stand-in row is held for the flight').toMatch(/^msg-sending:/);
  for (const at of OFFSETS) {
    await seek(page, at);
    const stamp = String(at).padStart(3, '0');
    await page.screenshot({ path: path.join(dir, `${stamp}ms.png`) });
    await page.screenshot({ path: path.join(dir, `${stamp}ms-crop.png`), clip });
  }
  await resume(page);
  await expect(page.locator(SEL.ghost)).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'after.png') });
}

async function expectLanded(page: Page, text: string, options: { sameNode?: boolean } = {}) {
  const rows = page.locator(SEL.ownRow, { hasText: text });
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toBeVisible();
  // The delivered message, not the stand-in.
  await expect(row).not.toHaveAttribute('id', /^msg-sending:/);
  await expect(row).not.toHaveAttribute('data-flight', /.*/);
  await expect(row).not.toHaveAttribute('aria-hidden', /.*/);
  await expect(page.locator(SEL.ghost)).toHaveCount(0);
  const running = await row.evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running, 'no second animation on the delivered row').toBe(0);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  if (options.sameNode) {
    const same = await row.evaluate((el) => Boolean((el as unknown as { __standIn?: boolean }).__standIn));
    expect(same, 'the delivered row is the stand-in row\'s DOM node').toBe(true);
  }
}

test.describe('the send flight in the Index frame', () => {
  test('a one-line message flies from the message box onto its row in the timeline', async ({ page }) => {
    const text = 'count me in, give me ten minutes';
    await open(page);
    await expect(page.locator('.ix-frame')).toBeVisible();
    await type(page, text);
    const start = await composer(page).boundingBox();
    await film(page, 'busy-general');
    await expectLanded(page, text, { sameNode: true });
    await expect(composer(page)).toHaveValue('');
    expect(Number(await composer(page).evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    const landed = await page.locator(SEL.ownRow, { hasText: text }).locator(SEL.bubble).boundingBox();
    if (!start || !landed) throw new Error('no box');
    // It travelled up into the timeline, and it is the newest row.
    expect(start.y - landed.y).toBeGreaterThan(40);
    const last = await page.locator(SEL.ownRow).last().textContent();
    expect(last).toContain(text);
  });

  test('only transform, opacity and color move, on a 620ms flight, with no hang', async ({ page }) => {
    const text = 'measure me';
    await open(page);
    await type(page, text);
    await page.evaluate(() => {
      const bag = { frames: [] as number[], animations: [] as Array<{ id: string; props: string[]; duration: number }> };
      (window as unknown as { __measure: typeof bag }).__measure = bag;
      const seen = new WeakSet<Animation>();
      const t0 = performance.now();
      let last = t0;
      const tick = (now: number) => {
        bag.frames.push(now - last);
        last = now;
        for (const animation of document.getAnimations()) {
          const effect = animation.effect as KeyframeEffect | null;
          if (!effect || seen.has(animation)) continue;
          seen.add(animation);
          const props = new Set<string>();
          for (const frame of effect.getKeyframes()) for (const property of Object.keys(frame)) props.add(property);
          bag.animations.push({ id: animation.id, props: [...props], duration: Number(effect.getTiming().duration) });
        }
        if (now - t0 < 1400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1600);
    const { frames, animations } = await page.evaluate(
      () => (window as unknown as { __measure: { frames: number[]; animations: Array<{ id: string; props: string[]; duration: number }> } }).__measure,
    );
    const worst = Math.max(...frames.slice(2));
    console.log(`index send flight: ${frames.length} frames, worst ${worst.toFixed(1)}ms, median ${[...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)].toFixed(1)}ms`);
    const flight = animations.filter((a) => a.id.startsWith('data-motion-recipe:send'));
    expect(flight.length).toBeGreaterThan(5);
    const allowed = new Set(['transform', 'opacity', 'color', 'backgroundColor', 'offset', 'easing', 'composite', 'computedOffset']);
    for (const animation of flight) for (const property of animation.props) expect(allowed.has(property), `${animation.id} animates ${property}`).toBe(true);
    expect(flight.filter((a) => a.id.startsWith('data-motion-recipe:send-flight')).map((a) => a.duration)).toContain(620);
    expect(worst).toBeLessThan(250);
    await expectLanded(page, text);
  });

  test('the handoff never shows a double, a gap or a jump, however slow the server is', async ({ page }) => {
    const text = 'slow server, same bubble';
    await open(page);
    await server(page, { latencyMs: 900 });
    await type(page, text);
    await page.evaluate(
      ({ words, ownRow, bubble, ghost }) => {
        const log: Array<{ t: number; rows: number; ghost: boolean; visible: boolean; top: number | null; left: number | null }> = [];
        (window as unknown as { __watch: typeof log }).__watch = log;
        const t0 = performance.now();
        const tick = () => {
          const rows = [...document.querySelectorAll<HTMLElement>(ownRow)].filter((row) => row.textContent?.includes(words));
          const box = rows[0]?.querySelector(bubble)?.getBoundingClientRect();
          log.push({
            t: performance.now() - t0,
            rows: rows.length,
            ghost: Boolean(document.querySelector(ghost)),
            visible: rows[0] ? getComputedStyle(rows[0]).visibility === 'visible' : false,
            top: box ? Math.round(box.top * 10) / 10 : null,
            left: box ? Math.round(box.left * 10) / 10 : null,
          });
          if (performance.now() - t0 < 4800) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { words: text, ownRow: SEL.ownRow, bubble: SEL.bubble, ghost: SEL.ghost },
    );
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    const seen = await page.evaluate(
      () => (window as unknown as { __watch: Array<{ t: number; rows: number; ghost: boolean; visible: boolean; top: number | null; left: number | null }> }).__watch,
    );
    const frames = seen.slice(Math.max(0, seen.findIndex((frame) => frame.ghost)));
    expect(frames.filter((frame) => frame.ghost).length, 'the flight was seen in the air').toBeGreaterThan(10);
    for (const frame of frames) {
      expect(frame.rows, `one row at ${frame.t.toFixed(0)}ms`).toBeLessThanOrEqual(1);
      expect(Number(frame.ghost) + Number(frame.visible), `one bubble visible at ${frame.t.toFixed(0)}ms`).toBe(1);
    }
    const landedAt = frames.findIndex((frame) => !frame.ghost && frame.visible);
    expect(landedAt).toBeGreaterThan(0);
    const after = frames.slice(landedAt).filter((frame) => frame.top !== null);
    const top = after[0].top as number;
    const left = after[0].left as number;
    for (const frame of after) {
      expect(Math.abs((frame.top as number) - top), `no vertical jump at ${frame.t.toFixed(0)}ms`).toBeLessThan(1);
      expect(Math.abs((frame.left as number) - left), `no horizontal jump at ${frame.t.toFixed(0)}ms`).toBeLessThan(1);
    }
    await expectLanded(page, text);
  });

  test('the rows below the landing (someone typing) make room straight down, never sideways', async ({ page }) => {
    // KNOWN DEFECT carried in from feat/send-flight (also in its own Glass frames):
    // the timeline's virtual rows are keyed by index, so when the stand-in takes
    // the typing row's index, React reuses the bottom sentinel's node for the
    // typing row and the "make room" FLIP plays it from the sentinel's box: the
    // typing bubble slides in ~150px from the left during the flight. IX-11 keys
    // rows by identity (the stand-in and its delivered message sharing one key)
    // and removes `test.fail` here. See docs/design/index-checkpoints/M1.md.
    test.fail();
    const text = 'typing below me';
    const h = await open(page);
    await h.step('typing', { channel: 'fuelGeneral', who: 'maya' });
    const typing = page.locator('.glass-tl-typing-row');
    await expect(typing).toBeVisible();
    await type(page, text);
    await page.evaluate((selector) => {
      const lefts: number[] = [];
      (window as unknown as { __lefts: number[] }).__lefts = lefts;
      const t0 = performance.now();
      const tick = () => {
        const el = document.querySelector(selector);
        if (el) lefts.push(el.getBoundingClientRect().left);
        if (performance.now() - t0 < 900) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, '.glass-tl-typing-row .glass-msg__typing');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1100);
    const lefts = await page.evaluate(() => (window as unknown as { __lefts: number[] }).__lefts);
    const drift = Math.max(...lefts) - Math.min(...lefts);
    console.log(`typing row horizontal drift during the flight: ${drift.toFixed(1)}px`);
    expect(drift, 'the typing row never moves sideways').toBeLessThan(1);
  });

  test('the first thing said in a new server flies into the empty timeline', async ({ page }) => {
    const text = 'first one in here';
    await open(page, { busy: false });
    await expect(page.locator('[data-timeline-empty]')).toBeVisible();
    await type(page, text);
    await film(page, 'empty-general');
    await expectLanded(page, text, { sameNode: true });
    await expect(page.locator('[data-timeline-empty]')).toHaveCount(0);
  });

  test('a delivery the server refuses lets the bubble go, with nothing left held', async ({ page }) => {
    const text = 'this one will be refused';
    await open(page);
    await server(page, { refuse: true });
    await type(page, text);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Refused — not delivered')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator(SEL.ghost)).toHaveCount(0);
    await expect(page.locator(SEL.ownRow, { hasText: text })).toHaveCount(0);
    await expect(page.locator(SEL.held)).toHaveCount(0);
  });

  test('with reduced motion the text clears and the row appears, with no flight', async ({ page }) => {
    const text = 'no flight for me';
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await type(page, text);
    let sawGhost = false;
    await page.exposeFunction('__sawGhost', () => {
      sawGhost = true;
    });
    await page.evaluate((ghost) => {
      new MutationObserver(() => {
        if (document.querySelector(ghost)) void (window as unknown as { __sawGhost: () => void }).__sawGhost();
      }).observe(document.body, { childList: true, subtree: true });
    }, SEL.ghost);
    await page.keyboard.press('Enter');
    await expectLanded(page, text);
    expect(sawGhost).toBe(false);
    await expect(composer(page)).toHaveValue('');
    expect(await page.locator(SEL.held).count()).toBe(0);
  });
});
