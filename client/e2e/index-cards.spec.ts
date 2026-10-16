import { existsSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * IX-8 (conversation cards): the DEV gallery at `/ix-cards` shows the Index card
 * family in every state (docs/index-spec.md §4.11, §8.4), and this spec shoots
 * it, holds the event card to the prototype's `.event`, and drives the parts that
 * move: the RSVP and Maybe buttons, the poll's share bars, the viewer an image
 * opens, the select menus.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-cards \
 *   PARACORD_E2E_INDEX_PORT=4563 PARACORD_E2E_INDEX_RT_PORT=4565 \
 *   PARACORD_E2E_INDEX_WP=ix8 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Shots land in `output/design-reference/index-build/<WP>/` (gitignored). The
 * gallery needs no scene: every card is drawn from data with its clock pinned,
 * except the two "wired" ones at the end, whose API calls this spec answers.
 */

const WP = process.env.PARACORD_E2E_INDEX_WP || 'ix8';
const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'output', 'design-reference', 'index-build', WP);
const REF = path.join(ROOT, 'output', 'design-reference', 'index', 'ref', 's0-plan-a-night.png');

/* ---------------------------------------------------------------- pictures */

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const byte of body) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** A small valid PNG: a vertical wash from one gray-blue to another, so a picture reads as one. */
function picture(width: number, height: number, from: [number, number, number], to: [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    const t = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) raw[row + 1 + x * 3 + channel] = Math.round(from[channel] + (to[channel] - from[channel]) * t);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PICTURES: Record<string, Buffer> = {
  'ridge.png': picture(480, 300, [58, 66, 82], [24, 28, 38]),
  'video.png': picture(640, 360, [92, 70, 62], [30, 24, 26]),
  'thumb.png': picture(128, 128, [64, 84, 96], [28, 36, 44]),
  'poster.png': picture(112, 168, [88, 74, 54], [26, 22, 18]),
};

/* ------------------------------------------------------------------ the API */

interface WiredState {
  going: boolean;
  poll: { yes: number; no: number; voted: 'yes' | 'no' | null };
  rsvpCalls: string[];
  voteCalls: string[];
}

/** The gallery's two wired cards: their API, answered from a little state the spec can read. */
async function wire(page: Page): Promise<WiredState> {
  const state: WiredState = { going: false, poll: { yes: 3, no: 1, voted: null }, rsvpCalls: [], voteCalls: [] };

  await page.route('**/ix-gallery/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = PICTURES[name];
    if (body) await route.fulfill({ status: 200, contentType: 'image/png', body });
    else await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from('x') });
  });

  await page.route('**/api/v1/guilds/gal-guild/events/gal-event', async (route) => {
    const start = new Date();
    start.setDate(start.getDate() + 3);
    start.setHours(21, 0, 0, 0);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'gal-event',
        guild_id: 'gal-guild',
        name: 'Wired game night',
        channel_id: null,
        creator_id: '1001',
        scheduled_start: start.toISOString(),
        location: 'Brendan’s garage',
        status: 1,
        user_count: 3 + (state.going ? 1 : 0),
        user_rsvp: state.going,
      }),
    });
  });
  await page.route('**/api/v1/guilds/gal-guild/events/gal-event/rsvp', async (route) => {
    const method = route.request().method();
    state.rsvpCalls.push(method);
    state.going = method === 'PUT';
    await route.fulfill({ status: 204 });
  });

  const pollBody = () => {
    const { yes, no, voted } = state.poll;
    return {
      id: 'gal-poll',
      message_id: 'm1',
      channel_id: 'gal-channel',
      question: 'Wired poll?',
      allow_multiselect: false,
      expires_at: null,
      created_at: '2026-10-05T20:35:00Z',
      total_votes: yes + no,
      options: [
        { id: 'o0', text: 'Yes', emoji: null, position: 0, vote_count: yes, voted: voted === 'yes' },
        { id: 'o1', text: 'No', emoji: null, position: 1, vote_count: no, voted: voted === 'no' },
      ],
    };
  };
  await page.route('**/api/v1/channels/gal-channel/polls/gal-poll', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pollBody()) });
  });
  await page.route('**/api/v1/channels/gal-channel/polls/gal-poll/votes/*', async (route) => {
    const option = new URL(route.request().url()).pathname.split('/').pop();
    const method = route.request().method();
    state.voteCalls.push(`${method} ${option}`);
    const key = option === 'o0' ? 'yes' : 'no';
    if (method === 'PUT') {
      if (state.poll.voted) state.poll[state.poll.voted] -= 1;
      state.poll[key] += 1;
      state.poll.voted = key;
    } else {
      state.poll[key] -= 1;
      state.poll.voted = null;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pollBody()) });
  });
  return state;
}

async function open(page: Page, query = ''): Promise<WiredState> {
  const state = await wire(page);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto(`/ix-cards${query}`);
  await expect(page.getByTestId('ix-cards-gallery')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // The wired cards have asked the API by now.
  await expect(page.locator('[data-cell="wired-event"] .ix-event__title')).toHaveText('Wired game night');
  expect(problems, 'the gallery throws nothing').toEqual([]);
  return state;
}

const cell = (page: Page, id: string): Locator => page.locator(`[data-cell="${id}"]`);

async function css(locator: Locator, props: string[], pseudo?: string): Promise<Record<string, string>> {
  return locator.evaluate(
    (element, { props, pseudo }) => {
      const style = getComputedStyle(element, pseudo);
      return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
    },
    { props, pseudo },
  );
}

/** Mean per-channel difference, as a percent of full scale, between a rectangle of the reference and a shot. */
async function regionDiff(page: Page, refFile: string, clip: { x: number; y: number; width: number; height: number }, shot: Buffer): Promise<number> {
  const ref = (await readFile(refFile)).toString('base64');
  return page.evaluate(
    async ({ ref, shot, clip }) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [a, b] = await Promise.all([load(ref), load(shot)]);
      const draw = (img: HTMLImageElement, sx: number, sy: number) => {
        const canvas = document.createElement('canvas');
        canvas.width = clip.width;
        canvas.height = clip.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, sx, sy, clip.width, clip.height, 0, 0, clip.width, clip.height);
        return ctx.getImageData(0, 0, clip.width, clip.height).data;
      };
      const da = draw(a, clip.x, clip.y);
      const db = draw(b, 0, 0);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < da.length; i += 4) {
        for (let c = 0; c < 3; c += 1) {
          sum += Math.abs(da[i + c] - db[i + c]);
          n += 1;
        }
      }
      return (sum / n / 255) * 100;
    },
    { ref, shot: shot.toString('base64'), clip },
  );
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  const file = path.join(OUT, `${name}.png`);
  if (target) {
    await target.screenshot({ path: file });
    return;
  }
  // The gallery is its own scroller (the app's root never scrolls): the whole of it is
  // one shot when the window is as tall as it is.
  const size = page.viewportSize()!;
  const height = await page.getByTestId('ix-cards-gallery').evaluate((element) => element.scrollHeight);
  await page.setViewportSize({ width: size.width, height });
  await page.waitForTimeout(300);
  await page.screenshot({ path: file });
  await page.setViewportSize(size);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

/* ------------------------------------------------------------------- tests */

test.describe('the gallery', () => {
  test('draws every card without an error, and nothing is running at rest', async ({ page }) => {
    await open(page);
    for (const id of ['events', 'polls', 'files', 'links', 'text', 'bots', 'wired']) {
      await expect(page.locator(`[data-section="${id}"]`)).toBeVisible();
    }
    // No loop anywhere: a card moves on an event, never at rest (docs/index-spec.md §1.2).
    await page.waitForTimeout(2_000);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    // Every picture the gallery asked for arrived (the spec supplies them).
    const broken = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter((img) => img.complete && img.naturalWidth === 0)
        .map((img) => img.src),
    );
    expect(broken).toEqual([]);
  });
});

test.describe('the event card (the prototype\'s .event)', () => {
  test('has the prototype\'s metrics', async ({ page }) => {
    await open(page);
    const card = cell(page, 'event-draft').locator('.ix-event');
    await expect(card).toHaveAttribute('role', 'group');
    await expect(card).toHaveAccessibleName('Event: Game night');

    const box = await card.boundingBox();
    expect(box?.width).toBe(400);
    expect(await css(card, ['border-top-left-radius', 'padding-top', 'padding-left', 'background-color', 'column-gap', 'row-gap'])).toEqual({
      'border-top-left-radius': '20px',
      'padding-top': '16px',
      'padding-left': '16px',
      'background-color': 'rgb(42, 43, 47)',
      'column-gap': '14px',
      'row-gap': '4px',
    });

    const tile = card.locator('.ix-event__day');
    const tileBox = await tile.boundingBox();
    expect([tileBox?.width, tileBox?.height]).toEqual([48, 52]);
    expect((await css(tile, ['border-top-left-radius']))['border-top-left-radius']).toBe('12px');
    const weekday = card.locator('.ix-event__day small');
    expect(await css(weekday, ['font-size', 'font-weight', 'letter-spacing', 'text-transform'])).toMatchObject({
      'font-size': '11px',
      'font-weight': '700',
      'text-transform': 'uppercase',
    });
    expect((await css(card.locator('.ix-event__day b'), ['font-size', 'font-weight']))).toEqual({ 'font-size': '20px', 'font-weight': '700' });
    expect(await css(card.locator('.ix-event__title'), ['font-size', 'font-weight'])).toEqual({ 'font-size': '16px', 'font-weight': '700' });
    expect((await css(card.locator('.ix-event__meta'), ['font-size']))['font-size']).toBe('13.5px');

    const post = card.getByRole('button', { name: 'Post it' });
    const edit = card.getByRole('button', { name: 'Edit' });
    expect(await css(post, ['background-color', 'color', 'border-top-left-radius', 'padding-left', 'font-size', 'font-weight'])).toEqual({
      'background-color': 'rgb(244, 242, 237)',
      color: 'rgb(20, 20, 20)',
      'border-top-left-radius': '10px',
      'padding-left': '12px',
      'font-size': '13.5px',
      'font-weight': '600',
    });
    expect(await css(edit, ['border-top-left-radius', 'padding-left', 'font-size', 'font-weight'])).toEqual({
      'border-top-left-radius': '10px',
      'padding-left': '12px',
      'font-size': '13.5px',
      'font-weight': '600',
    });
    // Both read the same height, and the two are 8px apart.
    const [p, e] = [await post.boundingBox(), await edit.boundingBox()];
    expect(p?.height).toBe(e?.height);
    expect((e?.x ?? 0) - ((p?.x ?? 0) + (p?.width ?? 0))).toBe(8);
  });

  test('is the prototype\'s card to the pixel (held against s0-plan-a-night)', async ({ page }) => {
    // The references are local renders of the prototype (index-reference.mjs),
    // not in the repository: CI has none to hold the card against.
    test.skip(!existsSync(REF), `no reference render at ${REF} (make it with e2e/index-reference.mjs)`);
    await open(page);
    const card = cell(page, 'event-draft').locator('.ix-event');
    await shoot(page, 'event-card-draft', card);
    const shot = await readFile(path.join(OUT, 'event-card-draft.png'));
    // The reference card, found in the 1280x800 render: 400 wide, 130 tall, at (832, 526).
    const diff = await regionDiff(page, REF, { x: 832, y: 526, width: 400, height: 130 }, shot);
    console.log(`event card against the reference: mean difference ${diff.toFixed(2)}%`);
    // Text anti-aliasing and the lit top edge are the whole of it.
    expect(diff).toBeLessThan(2);
  });

  test('"I\'m in" is the one cream button; pressing it gives "You\'re in", pressing that gives the spot back', async ({ page }) => {
    await open(page);
    const card = page.getByTestId('gallery-event').locator('.ix-event');
    const imIn = card.getByRole('button', { name: 'I’m in' });
    const maybe = card.getByRole('button', { name: 'Maybe' });
    await expect(card.locator('.ix-cream')).toHaveCount(1);
    expect((await css(imIn, ['background-color']))['background-color']).toBe('rgb(244, 242, 237)');
    await expect(maybe).toHaveAttribute('aria-pressed', 'false');
    await expect(card.locator('.ix-event__meta')).toHaveText('Friday at 9:00 PM · in General · 3 going');

    await imIn.click();
    const youre = card.getByRole('button', { name: 'You’re in' });
    await expect(youre).toBeVisible();
    await expect(card.locator('.ix-cream')).toHaveCount(0);
    await expect(card.locator('.ix-event__meta')).toHaveText('Friday at 9:00 PM · in General · 4 going');
    expect(await youre.locator('svg').count()).toBe(1);

    await maybe.click();
    // Maybe is not going: the spot goes back, and Maybe is pressed.
    await expect(maybe).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('button', { name: 'I’m in' })).toBeVisible();
    await expect(card.locator('.ix-event__meta')).toHaveText('Friday at 9:00 PM · in General · 3 going');

    await maybe.click();
    await expect(maybe).toHaveAttribute('aria-pressed', 'false');
  });

  test('says when it is live, over and canceled, and offers no answer to what is over', async ({ page }) => {
    await open(page);
    const live = cell(page, 'event-live').locator('.ix-event');
    await expect(live.locator('.ix-event__live')).toHaveText('Happening now');
    expect((await css(live.locator('.ix-event__live'), ['color']))['color']).toBe('rgb(255, 194, 126)');
    expect((await css(live.locator('.ix-event__day small'), ['color']))['color']).toBe('rgb(255, 194, 126)');

    const over = cell(page, 'event-over').locator('.ix-event');
    await expect(over.getByRole('button')).toHaveCount(0);
    const canceled = cell(page, 'event-canceled').locator('.ix-event');
    await expect(canceled.locator('.ix-event__meta')).toHaveText('Canceled');
    await expect(canceled.getByRole('button')).toHaveCount(0);
    expect((await css(canceled.locator('.ix-event__title'), ['text-decoration-line']))['text-decoration-line']).toBe('line-through');
  });

  test('a narrow card breaks its line between the parts, never inside "3 going"', async ({ page }) => {
    await open(page);
    // The wired card has a place and a count after the time: the longest line the card draws.
    const parts = cell(page, 'wired-event').locator('.ix-event__part');
    expect(await parts.count()).toBe(2);
    const rects = await parts.evaluateAll((elements) => elements.map((element) => element.getClientRects().length));
    expect(rects).toEqual([1, 1]);
    // And the card never makes its page wider (at the phone's width too).
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await cell(page, 'wired-event').locator('.ix-event').boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  });

  test('the weekday takes the place\'s hue', async ({ page }) => {
    await open(page, '?hue=350');
    const warm = (await css(cell(page, 'event-draft').locator('.ix-event__day small'), ['color']))['color'];
    await page.goto('/ix-cards?hue=150');
    await expect(page.getByTestId('ix-cards-gallery')).toBeVisible();
    const green = (await css(cell(page, 'event-draft').locator('.ix-event__day small'), ['color']))['color'];
    expect(warm).not.toBe(green);
    // hsl(350 75% 74%) is a pink, hsl(150 75% 74%) a green: red leads in one, green in the other.
    const parse = (value: string) => value.match(/\d+/g)!.map(Number);
    const [wr, wg] = parse(warm);
    const [gr, gg] = parse(green);
    expect(wr).toBeGreaterThan(wg);
    expect(gg).toBeGreaterThan(gr);
  });

  test('wired to the API: I\'m in is a PUT, giving it back a DELETE, and Maybe stays on this device', async ({ page }) => {
    const wired = await open(page);
    const card = cell(page, 'wired-event').locator('.ix-event');
    await expect(card.locator('.ix-event__meta')).toContainText('3 going');

    await card.getByRole('button', { name: 'I’m in' }).click();
    await expect(card.getByRole('button', { name: 'You’re in' })).toBeVisible();
    await expect(card.locator('.ix-event__meta')).toContainText('4 going');
    expect(wired.rsvpCalls).toEqual(['PUT']);

    // Maybe while in: the RSVP is withdrawn, and the mark is kept.
    await card.getByRole('button', { name: 'Maybe' }).click();
    await expect(card.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => wired.rsvpCalls).toEqual(['PUT', 'DELETE']);
    await expect(card.locator('.ix-event__meta')).toContainText('3 going');

    await page.reload();
    const again = cell(page, 'wired-event').locator('.ix-event');
    await expect(again.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
    // The mark is this device's: the count did not move, and nothing was sent for it.
    expect(wired.rsvpCalls).toEqual(['PUT', 'DELETE']);
  });
});

test.describe('the poll card', () => {
  test('draws each option\'s share as a scaleX bar, and your vote checked', async ({ page }) => {
    await open(page);
    const poll = page.getByTestId('gallery-poll').locator('.ix-poll');
    await expect(poll).toHaveAccessibleName('Poll: Late one after the run?');
    await expect(poll.locator('.ix-plan__meta')).toHaveText('Pick one · 12 votes');
    const bar = (index: number) => poll.locator('.ix-poll__option').nth(index).locator('.ix-poll__bar');
    await page.waitForTimeout(600);
    // 6 of 12, 4 of 12, 2 of 12.
    expect((await css(bar(0), ['transform']))['transform']).toBe('matrix(0.5, 0, 0, 1, 0, 0)');
    expect((await css(bar(2), ['transform-origin']))['transform-origin']).toBe('0px 20px');
    const shares = await Promise.all([0, 1, 2].map(async (index) => Number((await css(bar(index), ['transform']))['transform'].match(/matrix\(([\d.]+)/)?.[1])));
    expect(shares[0]).toBeCloseTo(0.5, 2);
    expect(shares[1]).toBeCloseTo(0.33, 2);
    expect(shares[2]).toBeCloseTo(0.17, 2);
    // Nothing is voted yet in this one.
    await expect(poll.locator('.ix-poll__option[data-voted]')).toHaveCount(0);
  });

  test('a vote moves the bars, and a second press takes it back', async ({ page }) => {
    await open(page);
    const poll = page.getByTestId('gallery-poll').locator('.ix-poll');
    const first = poll.getByRole('button', { name: /Count me in/ });
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(first.locator('svg')).toHaveCount(1);
    await expect(poll.locator('.ix-plan__meta')).toHaveText('Pick one · 13 votes');
    await page.waitForTimeout(700);
    // 7 of 13.
    const transform = (await css(first.locator('.ix-poll__bar'), ['transform']))['transform'];
    expect(Number(transform.match(/matrix\(([\d.]+)/)?.[1])).toBeCloseTo(0.54, 2);
    // Cream and checked: the choice mark is yours.
    expect((await css(first.locator('.ix-poll__mark'), ['background-color']))['background-color']).toBe('rgb(244, 242, 237)');

    // One choice only: voting for another moves it.
    await poll.getByRole('button', { name: /Bed/ }).click();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(poll.getByRole('button', { name: /Bed/ })).toHaveAttribute('aria-pressed', 'true');
    await poll.getByRole('button', { name: /Bed/ }).click();
    await expect(poll.locator('.ix-poll__option[data-voted]')).toHaveCount(0);
  });

  test('only a transform (and a color, on hover) animates, and nothing runs two seconds later', async ({ page }) => {
    await open(page);
    const option = page.getByTestId('gallery-poll').getByRole('button', { name: /Maybe one round/ });
    const bar = option.locator('.ix-poll__bar');
    const props = await css(bar, ['transition-property', 'transition-duration']);
    expect(props['transition-property']).toBe('transform');
    await option.click();
    // While it plays, only a transform animates; two seconds later nothing does.
    const running = await page.evaluate(() => document.getAnimations().map((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().map((k) => Object.keys(k).filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))).flat()));
    for (const names of running) for (const name of names ?? []) expect(['transform', 'opacity', 'backgroundColor', 'color']).toContain(name);
    await page.waitForTimeout(2_000);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test('is closed or locked when it cannot be voted in', async ({ page }) => {
    await open(page);
    const closed = cell(page, 'poll-closed').locator('.ix-poll');
    await expect(closed.locator('.ix-poll__state')).toHaveText('Closed');
    for (const button of await closed.getByRole('button').all()) await expect(button).toBeDisabled();
    const locked = cell(page, 'poll-locked').locator('.ix-poll');
    for (const button of await locked.getByRole('button').all()) await expect(button).toBeDisabled();
    // A poll with an end says when: "ends Fri".
    await expect(cell(page, 'poll-voted').locator('.ix-plan__meta')).toHaveText('Pick one · 12 votes · ends Fri');
  });

  test('wired to the API: a vote is a PUT and the bars follow the answer', async ({ page }) => {
    const wired = await open(page);
    const poll = cell(page, 'wired-poll').locator('.ix-poll');
    await expect(poll.locator('.ix-plan__meta')).toHaveText('Pick one · 4 votes');
    await poll.getByRole('button', { name: /^Yes/ }).click();
    await expect(poll.locator('.ix-plan__meta')).toHaveText('Pick one · 5 votes');
    expect(wired.voteCalls).toEqual(['PUT o0']);
  });
});

test.describe('files and media', () => {
  test('a file is a card with a hue tile, its name and size, and downloads on press', async ({ page }) => {
    await open(page);
    const file = cell(page, 'file-generic').locator('a.ix-file');
    await expect(file).toHaveAttribute('download', 'Q3-roadmap.pdf');
    await expect(file.locator('.ix-file__name')).toHaveText('Q3-roadmap.pdf');
    await expect(file.locator('.ix-file__size')).toHaveText('2.3 MB');
    const tile = await file.locator('.ix-file__tile').boundingBox();
    expect([tile?.width, tile?.height]).toEqual([38, 38]);
    expect(await css(file, ['background-color', 'border-top-left-radius'])).toEqual({ 'background-color': 'rgb(42, 43, 47)', 'border-top-left-radius': '20px' });
    // A long name ends in an ellipsis, inside the card.
    const long = cell(page, 'file-long').locator('a.ix-file');
    const fit = await long.evaluate((element) => {
      const name = element.querySelector('.ix-file__name') as HTMLElement;
      return { clipped: name.scrollWidth > name.clientWidth, inside: name.getBoundingClientRect().right <= element.getBoundingClientRect().right };
    });
    expect(fit).toEqual({ clipped: true, inside: true });
  });

  test('a picture opens the viewer, and Escape closes it', async ({ page }) => {
    await open(page);
    const open_ = cell(page, 'file-image').getByRole('button', { name: 'Open image preview: ridge.png' });
    await open_.click();
    const viewer = page.getByRole('dialog', { name: 'Image preview: ridge.png' });
    await expect(viewer).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close image preview' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
  });

  test('a blocked link and a failure say so, quietly and in the danger ink', async ({ page }) => {
    await open(page);
    const notes = cell(page, 'file-notes');
    await expect(notes.getByText('Attachment link blocked.')).toBeVisible();
    const failure = notes.getByRole('alert');
    await expect(failure).toContainText('notes.txt: This attachment could not be decrypted.');
    expect((await css(failure, ['color']))['color']).toBe('rgb(255, 179, 168)');
  });

  test('the timeline\'s own file wears the same card', async ({ page }) => {
    await open(page);
    const file = cell(page, 'file-glass').locator('.ix-file--timeline');
    expect(await css(file, ['background-color', 'border-top-left-radius'])).toEqual({ 'background-color': 'rgb(42, 43, 47)', 'border-top-left-radius': '20px' });
    const icon = await file.locator('.ix-file__tile').boundingBox();
    expect([icon?.width, icon?.height]).toEqual([38, 38]);
  });
});

test.describe('links, GitHub, feeds and scores', () => {
  test('a link preview is a card; the title is the link; the source\'s color is a 4px edge', async ({ page }) => {
    await open(page);
    const embed = cell(page, 'embed-image').locator('a.ix-embed');
    await expect(embed).toHaveAttribute('href', 'https://example.com/release');
    await expect(embed).toHaveAttribute('target', '_blank');
    await expect(embed).toHaveAttribute('rel', /noopener/);
    const thumb = await embed.locator('.ix-embed__thumb').boundingBox();
    expect([thumb?.width, thumb?.height]).toEqual([64, 64]);
    expect((await css(embed.locator('.ix-embed__title'), ['font-size', 'font-weight']))).toEqual({ 'font-size': '15px', 'font-weight': '700' });
    const accent = cell(page, 'embed-accent').locator('.ix-embed__accent');
    expect((await accent.boundingBox())?.width).toBe(4);
    // No accent unless the source sent one; the card without a link is not a link.
    await expect(cell(page, 'embed-plain').locator('.ix-embed__accent')).toHaveCount(0);
    await expect(cell(page, 'embed-plain').locator('a.ix-embed')).toHaveCount(1);
  });

  test('GitHub events are cards; only what removes something is tinted', async ({ page }) => {
    await open(page);
    const labels = cell(page, 'github').locator('.ix-gh__label');
    await expect(labels).toHaveText(['Pull request', 'Push', 'Deleted']);
    expect((await css(labels.nth(0), ['background-color']))['background-color']).toBe('rgba(255, 255, 255, 0.1)');
    expect((await css(labels.nth(2), ['color']))['color']).toBe('rgb(255, 179, 168)');
    await expect(cell(page, 'github').getByRole('link', { name: 'View on GitHub' }).first()).toHaveAttribute('href', 'https://github.com/acme/app/pull/42');
  });

  test('a feed leads a video with its thumbnail and a play mark, and ends a post with a picture', async ({ page }) => {
    await open(page);
    const video = cell(page, 'feed-video').locator('.ix-feed');
    await expect(video.getByRole('link', { name: 'Play Making the lantern, start to finish on YouTube' })).toBeVisible();
    const media = await video.locator('.ix-feed__media').boundingBox();
    expect(Math.round((media?.width ?? 0) / (media?.height ?? 1) * 100)).toBe(178);
    const post = cell(page, 'feed-post').locator('.ix-feed');
    expect(await post.locator('.ix-feed__thumb').getAttribute('data-shape')).toBe('square');
    await expect(post.getByRole('button', { name: 'Watch together' })).toBeVisible();
    const poster = await cell(page, 'feed-poster').locator('.ix-feed__thumb').boundingBox();
    expect([poster?.width, poster?.height]).toEqual([56, 84]);
    await expect(cell(page, 'feed-poster').getByRole('link', { name: 'and 7 more from Lantern Journal' })).toBeVisible();
  });

  test('a score is a card: two marks, two scores, the play; a team color is a rule under its score', async ({ page }) => {
    await open(page);
    const score = cell(page, 'score').locator('.ix-score').first();
    await expect(score).toContainText('Touchdown');
    await expect(score).toContainText('8:41 2nd');
    const numbers = score.locator('.ix-score__n');
    expect(await numbers.nth(0).evaluate((n) => n.style.getPropertyValue('--team'))).toBe('#e31837');
    // No team color: no rule of one.
    const plain = cell(page, 'score').locator('.ix-score').nth(1);
    expect(await plain.locator('.ix-score__n').first().evaluate((n) => n.style.getPropertyValue('--team'))).toBe('');
    await expect(plain).toContainText('Final (OT)');
  });
});

test.describe('chips, ephemeral and code', () => {
  test('chips are 24px and read on a bubble and on your cream bubble', async ({ page }) => {
    await open(page);
    const others = cell(page, 'chips-others');
    const live = others.locator('.ix-inline--live');
    expect((await live.boundingBox())?.height).toBe(24);
    expect((await css(live, ['color']))['color']).toBe('rgb(255, 194, 126)');
    await expect(live).toContainText('Lounge');
    await expect(live).toContainText('3 in');
    expect((await css(others.locator('.ix-inline--channel').first(), ['background-color', 'color']))).toEqual({
      'background-color': 'rgba(255, 255, 255, 0.06)',
      color: 'rgb(242, 243, 245)',
    });
    expect((await css(others.locator('.ix-inline--event'), ['background-color']))['background-color']).toBe('rgb(42, 43, 47)');
    // Others' mentions are ink 600; yours is the white chip with dark ink.
    expect(await css(others.locator('.glass-mention:not(.glass-mention-self)'), ['color', 'font-weight', 'background-color'])).toEqual({
      color: 'rgb(242, 243, 245)',
      'font-weight': '600',
      'background-color': 'rgba(0, 0, 0, 0)',
    });
    expect(await css(others.locator('.glass-mention-self'), ['background-color', 'color', 'border-top-left-radius', 'padding-left'])).toEqual({
      'background-color': 'rgb(242, 243, 245)',
      color: 'rgb(17, 18, 20)',
      'border-top-left-radius': '6px',
      'padding-left': '5px',
    });

    // Inside the cream bubble every chip turns to a dark wash: ink on it is dark, never ink on cream.
    const own = cell(page, 'chips-own');
    for (const chip of await own.locator('.ix-inline--channel, .ix-inline--event').all()) {
      expect((await css(chip, ['color']))['color']).toBe('rgb(20, 20, 20)');
    }
    expect((await css(own.locator('.ix-inline--live'), ['background-color', 'color']))).toEqual({
      'background-color': 'rgb(20, 20, 20)',
      color: 'rgb(255, 194, 126)',
    });
    expect((await css(own.locator('.glass-mention:not(.glass-mention-self)'), ['color']))['color']).toBe('rgb(20, 20, 20)');
  });

  test('the ephemeral line sits under the message in the tertiary ink', async ({ page }) => {
    await open(page);
    const note = cell(page, 'ephemeral').locator('.ix-ephemeral__note').first();
    await expect(note).toHaveText('Only you can see this');
    expect(await css(note, ['font-size', 'color'])).toEqual({ 'font-size': '12px', color: 'rgba(235, 238, 242, 0.62)' });
    const ownNote = cell(page, 'ephemeral').locator('.ix-ephemeral__note').nth(1);
    // On cream the tertiary ink is the dark one.
    expect((await css(ownNote, ['color']))['color']).toMatch(/^color\(srgb 0\.0784|^rgba\(20, 20, 20, 0\.62\)/);
  });

  test('a code block is --ix-code, radius 12, the keywords carry the hue, and it scrolls instead of wrapping', async ({ page }) => {
    await open(page);
    const block = cell(page, 'code').locator('.ix-code');
    expect(await css(block, ['background-color', 'border-top-left-radius'])).toEqual({ 'background-color': 'rgb(24, 25, 28)', 'border-top-left-radius': '12px' });
    await expect(block.locator('.ix-code__lang')).toHaveText('typescript');
    const keyword = block.locator('.hljs-keyword').first();
    const color = (await css(keyword, ['color']))['color'];
    // hsl(350 75% 74%): a pink; not the cream the old rule gave every keyword.
    expect(color).not.toBe('rgb(244, 242, 237)');
    const [r, g] = color.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g);
    const long = cell(page, 'code-long').locator('.ix-code__pre');
    expect(await long.evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true);
    expect((await css(long, ['overflow-x']))['overflow-x']).toBe('auto');
  });

  test('Copy copies, and says so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    const block = cell(page, 'code-long').locator('.ix-code');
    await block.getByRole('button', { name: 'Copy code to clipboard' }).click();
    await expect(block.getByRole('button', { name: 'Code copied to clipboard' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('cargo build --release');
  });
});

test.describe('bot components', () => {
  test('a primary button is cream only when it is the message\'s only primary', async ({ page }) => {
    await open(page);
    const one = cell(page, 'bot-one-primary');
    expect((await css(one.getByRole('button', { name: 'Approve' }), ['background-color', 'color']))).toEqual({
      'background-color': 'rgb(244, 242, 237)',
      color: 'rgb(20, 20, 20)',
    });
    // The quiet one, the danger one and the link are not cream.
    expect((await css(one.getByRole('button', { name: 'Later' }), ['background-color']))['background-color']).toBe('rgba(255, 255, 255, 0.08)');
    expect((await css(one.getByRole('button', { name: 'Reject' }), ['color']))['color']).toBe('rgb(255, 179, 168)');
    await expect(one.getByRole('button', { name: 'Disabled' })).toBeDisabled();

    const two = cell(page, 'bot-two-primary');
    for (const name of ['Ship it', 'Hold', 'Done']) {
      expect((await css(two.getByRole('button', { name }), ['background-color']))['background-color']).not.toBe('rgb(244, 242, 237)');
    }
    await expect(two.locator('.ix-bot-btn[data-tone="cream"]')).toHaveCount(0);
  });

  test('a select opens a near-solid list; several choices wait for Confirm, which is cream', async ({ page }) => {
    await open(page);
    const selects = cell(page, 'bot-selects');
    const single = selects.locator('.ix-bot-select__btn').first();
    await expect(single).toHaveAttribute('aria-expanded', 'false');
    await single.click();
    await expect(single).toHaveAttribute('aria-expanded', 'true');
    const pop = selects.locator('.ix-bot-select__pop').first();
    expect((await css(pop, ['border-top-left-radius', 'background-color']))).toEqual({ 'border-top-left-radius': '16px', 'background-color': 'rgba(22, 23, 26, 0.98)' });
    await expect(pop.getByRole('button')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(selects.locator('.ix-bot-select__pop')).toHaveCount(0);

    const multi = selects.locator('.ix-bot-select__btn').nth(1);
    await multi.click();
    const list = selects.locator('.ix-bot-select__pop');
    await list.getByRole('button', { name: 'Saturday' }).click();
    await expect(list.getByRole('button', { name: 'Confirm (2 selected)' })).toBeVisible();
    expect((await css(list.getByRole('button', { name: /Confirm/ }), ['background-color']))['background-color']).toBe('rgb(244, 242, 237)');
    // Three is the most; a fourth is not taken (there is no fourth), and Friday comes off.
    await list.getByRole('button', { name: 'Friday' }).click();
    await expect(list.getByRole('button', { name: 'Confirm (1 selected)' })).toBeVisible();
  });
});

test.describe('High contrast', () => {
  test('every card keeps an edge you can see, and the weekday keeps its hue', async ({ page }) => {
    await open(page, '?theme=glass-contrast');
    const card = cell(page, 'event-draft').locator('.ix-event');
    const shadow = (await css(card, ['box-shadow']))['box-shadow'];
    // inset 0 0 0 1px at .2: a ring, no drop.
    expect(shadow).toBe('rgba(255, 255, 255, 0.2) 0px 0px 0px 1px inset');
    expect((await css(cell(page, 'event-draft').locator('.ix-event__meta'), ['color']))['color']).toBe('rgba(235, 238, 242, 0.78)');
    expect((await css(cell(page, 'file-generic').locator('a.ix-file'), ['box-shadow']))['box-shadow']).toBe('rgba(255, 255, 255, 0.2) 0px 0px 0px 1px inset');
  });
});

test.describe('shots', () => {
  test('1280x800, 1440x900, 900x700 and 390x844', async ({ page }) => {
    await open(page);
    for (const [name, size] of [
      ['1280x800', { width: 1280, height: 800 }],
      ['1440x900', { width: 1440, height: 900 }],
      ['900x700', { width: 900, height: 700 }],
      ['390x844', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size);
      await shoot(page, `gallery@${name}`);
      // No horizontal scroll at any size: a card never makes the page wider than the window.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const id of ['events', 'polls', 'files', 'links', 'text', 'bots', 'wired']) {
      await shoot(page, `section-${id}`, page.locator(`[data-section="${id}"]`));
    }
    await open(page, '?hue=150');
    await shoot(page, 'gallery-hue-150@1440x900');
    await open(page, '?theme=glass-contrast');
    await shoot(page, 'gallery-high-contrast@1440x900');
  });
});
