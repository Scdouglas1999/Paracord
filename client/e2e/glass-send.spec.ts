import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_EPOCH, installGlassScene } from './fixtures/glass/install';
import { BASECAMP_ID, CAST, CH, GAME_NIGHT_ID, MESSAGES, SCENE_NOW_ISO, snowflakeAt, userRecord } from './fixtures/glass/scene';

/**
 * The send flight (docs/glass-spec.md §9, "a protected signature gesture"): a
 * message floating out of the message box into the conversation, filmed frame by
 * frame on the mocked Glass scene, and held to what the spec says it must be.
 *
 *   cd client
 *   npx playwright test -c e2e/glass-send.config.ts
 *
 * Frames: PARACORD_E2E_SEND_FRAMES, else output/design-reference/glass-build/send.
 *
 * The scene's REST mock answers a POST to a channel's messages with nothing, so
 * `mockServer` answers it the way the server does — the delivery itself, after
 * a configurable delay, and the message is then vouched for by the same recovery
 * feed the scene already serves. That is the only path a message reaches the
 * timeline by, so the flight is exercised exactly as it runs in the app.
 */
const FRAMES = process.env.PARACORD_E2E_SEND_FRAMES
  ? path.resolve(process.env.PARACORD_E2E_SEND_FRAMES)
  : path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', 'send');

const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const dmBrendan = `/app/dms/${CH.dmBrendan}`;
const basecampGeneral = `/app/guilds/${BASECAMP_ID}/channels/${CH.basecampGeneral}`;

/** The flight's own frames, in milliseconds from the keystroke. */
const OFFSETS = [0, 50, 110, 150, 260, 620] as const;

const seeded = MESSAGES.length;
test.afterEach(() => {
  MESSAGES.length = seeded;
});

interface ServerOptions {
  /** How long the server takes to answer a send. */
  latencyMs?: number;
  /** Refuse the send (403) instead of delivering it. */
  refuse?: boolean;
}

async function mockServer(page: Page, options: ServerOptions = {}) {
  const sends: string[] = [];
  await page.route('**/api/v1/channels/*/messages', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.fallback();
      return;
    }
    const channelId = new URL(request.url()).pathname.split('/')[4];
    const body = request.postDataJSON() as { content: string; nonce: string; referenced_message_id?: string };
    sends.push(body.content);
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    if (options.refuse) {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
        body: JSON.stringify({ code: 'FORBIDDEN', message: 'You cannot post here.' }),
      });
      return;
    }
    const seed = {
      id: snowflakeAt(SCENE_NOW_ISO),
      channel_id: channelId,
      author: 'sean' as const,
      content: body.content,
      created_at: SCENE_NOW_ISO,
      ...(body.referenced_message_id ? { reference_id: body.referenced_message_id } : {}),
    };
    MESSAGES.push(seed);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
      body: JSON.stringify({
        id: seed.id,
        channel_id: channelId,
        author: userRecord(CAST.sean),
        content: body.content,
        created_at: SCENE_NOW_ISO,
        timestamp: SCENE_NOW_ISO,
        nonce: body.nonce,
        tts: false,
        mention_everyone: false,
        pinned: false,
        type: body.referenced_message_id ? 19 : 0,
        ...(body.referenced_message_id ? { reference_id: body.referenced_message_id } : {}),
        attachments: [],
        reactions: [],
      }),
    });
  });
  return sends;
}

/**
 * The scene answers `POST /api/v2/rt/session` without the history-epoch header
 * every other answer carries, and the client then reconnects its gateway every
 * second or two — and every reconnect aborts a send in flight. A send has to be
 * watched against a gateway that stays up, as the real one does.
 */
async function steadyGateway(page: Page) {
  // Marking a channel read is answered the same way (an empty 204, no epoch), and
  // the client reconnects after that too: the timeline marks read as it scrolls.
  await page.route('**/api/v1/channels/*/read', (route) =>
    route.fulfill({ status: 204, headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH }, body: '' }),
  );
  await page.route('**/api/v2/rt/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
      body: JSON.stringify({ ws_url: 'ws://127.0.0.1:0/gateway', session_id: 'glass-session', token: 'glass-rt-token', cursor: 0 }),
    }),
  );
}

async function open(page: Page, size: keyof typeof SIZES, route: string, server: ServerOptions = {}) {
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page);
  await steadyGateway(page);
  const sends = await mockServer(page, server);
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('.glass-msg').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // The messaging runtime recovers the conversation after it opens, and a send
  // in that window is refused ("Wait for this account's authenticated message
  // recovery"). The flight is about the send that is accepted, so let it settle.
  await page.waitForTimeout(1500);

  return sends;
}

const composer = (page: Page) => page.locator('textarea[data-composer-input]');

/** Type into the message box and let the draft settle. */
async function type(page: Page, text: string) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.waitForTimeout(400);
}

/** The region around the composer and the last of the conversation, for frames. */
async function frameRegion(page: Page) {
  const capsule = await page.locator('.glass-composer__capsule').boundingBox();
  const timeline = await page.locator('.glass-timeline').boundingBox();
  if (!capsule || !timeline) throw new Error('no composer or timeline');
  const top = Math.max(timeline.y, capsule.y - 420);
  return { x: timeline.x, y: top, width: timeline.width, height: capsule.y + capsule.height + 24 - top };
}

/**
 * Stop every animation the flight started and hold them where `at` says, the
 * way the prototype's film was taken: the app keeps running, the clock of the
 * thing being looked at does not.
 */
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

/** Send, and film the flight at each offset. Returns once everything has landed. */
async function film(page: Page, name: string, clip: { x: number; y: number; width: number; height: number }) {
  const dir = path.join(FRAMES, name);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'before.png'), clip });
  await page.keyboard.press('Enter');
  const airborne = await freeze(page);
  expect(airborne, 'the flight is airborne on the keystroke').toBeGreaterThan(0);
  for (const at of OFFSETS) {
    await seek(page, at);
    await page.screenshot({ path: path.join(dir, `${String(at).padStart(3, '0')}ms.png`), clip });
  }
  await resume(page);
  await expect(page.locator('.glass-flight')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, 'after.png'), clip });
}

/** What a landed send must look like, wherever it was sent. */
async function expectLanded(page: Page, text: string) {
  const rows = page.locator('.glass-msg[data-own]', { hasText: text });
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toBeVisible();
  // Handed off: no hold left on the row, no ghost, nothing still animating on it.
  await expect(row).not.toHaveAttribute('data-flight', /.*/);
  await expect(row).not.toHaveAttribute('aria-hidden', /.*/);
  await expect(page.locator('.glass-flight')).toHaveCount(0);
  const running = await row.evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running, 'no second animation on the delivered row').toBe(0);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

/**
 * Watch one send, frame by frame, in the page itself: at every frame, how many
 * rows carry the words, whether the ghost is in the air, whether the row can be
 * seen, and where its bubble is. The invariants of the handoff are then checked
 * against the whole run rather than against one lucky frame.
 */
async function watch(page: Page, text: string, forMs: number) {
  await page.evaluate(
    ({ text: words, forMs: span }) => {
      const log: Array<{ t: number; rows: number; ghost: boolean; visible: boolean; top: number | null; left: number | null }> = [];
      (window as unknown as { __watch: typeof log }).__watch = log;
      const t0 = performance.now();
      const tick = () => {
        const rows = [...document.querySelectorAll<HTMLElement>('.glass-msg[data-own]')].filter((row) => row.textContent?.includes(words));
        const bubble = rows[0]?.querySelector('.glass-bubble')?.getBoundingClientRect();
        log.push({
          t: performance.now() - t0,
          rows: rows.length,
          ghost: Boolean(document.querySelector('.glass-flight')),
          visible: rows[0] ? getComputedStyle(rows[0]).visibility === 'visible' : false,
          top: bubble ? Math.round(bubble.top * 10) / 10 : null,
          left: bubble ? Math.round(bubble.left * 10) / 10 : null,
        });
        if (performance.now() - t0 < span) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { text, forMs },
  );
}

async function watched(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __watch: Array<{ t: number; rows: number; ghost: boolean; visible: boolean; top: number | null; left: number | null }> }).__watch,
  );
}

test.describe('the send flight', () => {
  test('a one-line message floats out of the message box into the conversation', async ({ page }) => {
    const text = 'count me in, give me ten minutes';
    await open(page, 'desktop', general);
    await type(page, text);
    const clip = await frameRegion(page);
    const start = await box(composer(page));
    await film(page, 'desktop-general', clip);
    await expectLanded(page, text);
    // The composer is empty again, and visible.
    await expect(composer(page)).toHaveValue('');
    expect(Number(await composer(page).evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    // It really travelled: the bubble landed well clear of where the words were.
    const landed = await box(page.locator('.glass-msg[data-own]', { hasText: text }).locator('.glass-bubble'));
    expect(start.y - landed.y).toBeGreaterThan(40);
  });

  test('only transform, opacity and color move, and no frame of the flight is a hang', async ({ page }) => {
    const text = 'measure me';
    await open(page, 'desktop', general);
    await type(page, text);
    await page.evaluate(() => {
      const bag = { frames: [] as number[], animations: [] as Array<{ id: string; props: string[]; duration: number; target: string }> };
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
          bag.animations.push({
            id: animation.id,
            props: [...props],
            duration: Number(effect.getTiming().duration),
            target: (effect.target as HTMLElement | null)?.className?.toString() ?? '',
          });
        }
        if (now - t0 < 1400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1600);
    const { frames, animations } = await page.evaluate(
      () =>
        (window as unknown as { __measure: { frames: number[]; animations: Array<{ id: string; props: string[]; duration: number; target: string }> } })
          .__measure,
    );
    const worst = Math.max(...frames.slice(2));
    console.log(`send flight: ${frames.length} frames, worst ${worst.toFixed(1)}ms, median ${[...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)].toFixed(1)}ms`);
    const flight = animations.filter((a) => a.id.startsWith('data-motion-recipe:send'));
    expect(flight.length).toBeGreaterThan(5);
    // The law: transform and opacity, plus the color of the flying words and of the send control.
    const allowed = new Set(['transform', 'opacity', 'color', 'backgroundColor', 'offset', 'easing', 'composite', 'computedOffset']);
    for (const animation of flight) for (const property of animation.props) expect(allowed.has(property), `${animation.id} animates ${property}`).toBe(true);
    // One flight, 620ms, on the layers and rows the spec names.
    const flying = flight.filter((a) => a.id.startsWith('data-motion-recipe:send-flight'));
    expect(flying.map((a) => a.duration)).toContain(620);
    // Only a hang fails this. The frame of the keystroke itself (React committing the send, the draft
    // saved, the stand-in laid out) costs 75-130ms in headless Chromium on this box with or without
    // the flight: the same worst frame shows under reduced motion, where nothing flies. What the
    // flight adds is five compositor animations, and the median frame through it is 16ms.
    expect(worst).toBeLessThan(250);
  });

  test('a three-line message keeps its shape in the air', async ({ page }) => {
    const text = 'heading into the lobby now\nbring the clip we made last night\nand somebody grab the good controller';
    await open(page, 'desktop', general);
    await type(page, text);
    const clip = await frameRegion(page);
    await film(page, 'desktop-three-lines', clip);
    const row = page.locator('.glass-msg[data-own]', { hasText: 'heading into the lobby now' });
    await expect(row).toHaveCount(1);
    await expect(row).not.toHaveAttribute('data-flight', /.*/);
    await expect(page.locator('.glass-flight')).toHaveCount(0);
    await expect(composer(page)).toHaveValue('');
  });

  test('a send the composer cannot hand to the outbox gives the words back and lets the bubble go', async ({ page }) => {
    // The scene's direct message is end-to-end encrypted and its other person has not set encryption
    // up, so the runtime refuses the send AFTER the composer has let it fly: the failure path, for real.
    const text = 'yes, I will be there at nine';
    await open(page, 'desktop', dmBrendan);
    await type(page, text);
    const clip = await frameRegion(page);
    const dir = path.join(FRAMES, 'desktop-dm-refused');
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'before.png'), clip });
    await page.keyboard.press('Enter');
    for (const [index, wait] of [0, 50, 70, 90, 120, 200, 400].entries()) {
      await page.waitForTimeout(wait);
      await page.screenshot({ path: path.join(dir, `frame-${index}.png`), clip });
    }
    await expect(page.getByRole('alert').filter({ hasText: 'finish encryption setup' })).toBeVisible();
    // The words are back in the box, visible; nothing is left in the air, held or standing in.
    await expect(composer(page)).toHaveValue(text);
    expect(Number(await composer(page).evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    await expect(page.locator('.glass-flight')).toHaveCount(0);
    await expect(page.locator('[data-flight]')).toHaveCount(0);
    await expect(page.locator('.glass-msg[data-own]', { hasText: text })).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir, 'after.png'), clip });
  });

  test('the first thing said in an empty conversation flies into an empty timeline', async ({ page }) => {
    const text = 'first one in here';
    await page.setViewportSize(SIZES.desktop);
    await installGlassScene(page);
    await steadyGateway(page);
    await mockServer(page);
    // Nobody has said anything in Basecamp's General yet.
    await page.route(`**/api/v1/channels/${CH.basecampGeneral}/messages?*`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH }, body: '[]' });
    });
    await page.goto(basecampGeneral);
    await expect(page.getByText('Nobody has posted here yet')).toBeVisible();
    await page.waitForTimeout(1500);
    await type(page, text);
    const clip = await frameRegion(page);
    await film(page, 'desktop-first-message', clip);
    await expectLanded(page, text);
    await expect(page.getByText('Nobody has posted here yet')).toHaveCount(0);
  });

  test('a reply flies too, to a row that already has its chip', async ({ page }) => {
    const text = 'it was great, thanks';
    await open(page, 'desktop', general);
    const parent = page.locator('.glass-msg', { hasText: 'new personal best btw' }).first();
    await parent.hover();
    await parent.getByRole('button', { name: 'Reply to Nick' }).click();
    await expect(page.locator('.glass-composer__reply')).toBeVisible();
    await type(page, text);
    const clip = await frameRegion(page);
    await film(page, 'desktop-reply', clip);
    await expectLanded(page, text);
    // The chip is on the delivered row from the first frame it can be seen in: the stand-in
    // carried it, so the row did not grow when the server answered.
    await expect(page.locator('.glass-msg[data-own]', { hasText: text }).locator('.glass-tl-reply')).toHaveCount(1);
  });

  test('on a phone it flies in the phone layout', async ({ page }) => {
    const text = 'on my way, ten minutes';
    await open(page, 'phone', general);
    await type(page, text);
    const clip = await frameRegion(page);
    await film(page, 'phone-general', clip);
    await expectLanded(page, text);
  });

  test('the handoff never shows a double, a gap or a jump, however slow the server is', async ({ page }) => {
    const text = 'slow server, same bubble';
    // 900ms: the bubble has landed (620ms) and is held, then the server answers.
    await open(page, 'desktop', general, { latencyMs: 900 });
    await type(page, text);
    await watch(page, text, 4800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    // From takeoff on (the frames before the keystroke have nothing to say).
    const seen = await watched(page);
    const frames = seen.slice(Math.max(0, seen.findIndex((frame) => frame.ghost)));
    const airborne = frames.filter((frame) => frame.ghost);
    expect(airborne.length, 'the flight was seen in the air').toBeGreaterThan(10);
    for (const frame of frames) {
      expect(frame.rows, `one row at ${frame.t.toFixed(0)}ms`).toBeLessThanOrEqual(1);
      // Exactly one of them can be seen: the ghost in the air, or the row on its mark.
      expect(Number(frame.ghost) + Number(frame.visible), `one bubble visible at ${frame.t.toFixed(0)}ms`).toBe(1);
    }
    // Once the ghost has landed the bubble does not move again, not even when the server answers.
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

  test('two sends in quick succession are two bubbles, each landing once', async ({ page }) => {
    await open(page, 'desktop', general, { latencyMs: 150 });
    await type(page, 'first of two');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    await composer(page).fill('second of two');
    await page.keyboard.press('Enter');
    await expect(page.locator('.glass-flight')).toHaveCount(0, { timeout: 5_000 });
    await expectLanded(page, 'first of two');
    await expectLanded(page, 'second of two');
    const first = await box(page.locator('.glass-msg[data-own]', { hasText: 'first of two' }));
    const second = await box(page.locator('.glass-msg[data-own]', { hasText: 'second of two' }));
    expect(second.y).toBeGreaterThan(first.y);
  });

  test('a delivery the server refuses lets the bubble go, and the card keeps the words', async ({ page }) => {
    const text = 'this one will be refused';
    await open(page, 'desktop', general, { refuse: true });
    await type(page, text);
    const clip = await frameRegion(page);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Refused — not delivered')).toBeVisible({ timeout: 8_000 });
    // No bubble in the air, no stand-in row, nothing held out of sight.
    await expect(page.locator('.glass-flight')).toHaveCount(0);
    await expect(page.locator('.glass-msg[data-own]', { hasText: text })).toHaveCount(0);
    await expect(page.locator('[data-flight]')).toHaveCount(0);
    await page.waitForTimeout(400);
    await mkdir(path.join(FRAMES, 'refused'), { recursive: true });
    await page.screenshot({ path: path.join(FRAMES, 'refused', 'after.png'), clip: { ...clip, y: clip.y - 200, height: clip.height + 200 } });
  });

  test('with reduced motion the text clears and the row appears, with no flight', async ({ page }) => {
    const text = 'no flight for me';
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'desktop', general);
    await type(page, text);
    let sawGhost = false;
    await page.exposeFunction('__sawGhost', () => {
      sawGhost = true;
    });
    await page.evaluate(() => {
      new MutationObserver(() => {
        if (document.querySelector('.glass-flight')) void (window as unknown as { __sawGhost: () => void }).__sawGhost();
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.keyboard.press('Enter');
    await expectLanded(page, text);
    expect(sawGhost).toBe(false);
    await expect(composer(page)).toHaveValue('');
    expect(await page.locator('[data-flight]').count()).toBe(0);
  });
});
