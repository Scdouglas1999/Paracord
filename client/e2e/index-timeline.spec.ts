import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CLOCK,
  installIndexScene,
  navigate,
  outDir,
  shoot,
  type IndexHarness,
} from './fixtures/index';
import { chatter, say } from './fixtures/index/steps/timeline';

/**
 * IX-11 (Timeline): docs/index-spec.md §3.1, §4.11, §5.10, §6.13;
 * docs/design/index-plan.md §3 IX-11.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-timeline PARACORD_E2E_INDEX_PORT=4593 \
 *   PARACORD_E2E_INDEX_RT_PORT=4595 PARACORD_E2E_INDEX_WP=ix11 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Shoots s2, s4, s5 and s6 at 1280x800 (held against ref/ with
 * `node e2e/index-compare.mjs ix11`), s5 at the other sizes, and crops of the
 * timeline's own moments under `<WP>/timeline/`; holds the feed to the
 * prototype's metrics, and checks the arrival motion, the New divider, jump to
 * latest, hover, the menu, reactions, replies, media, editing and density.
 */

const SHOTS = path.join(outDir(), 'timeline');

const feed = (page: Page) => page.getByRole('feed', { name: 'Message history' });
const row = (page: Page, text: string): Locator => page.locator('[role="article"]', { hasText: text }).last();
const bubbleOf = (page: Page, text: string): Locator => row(page, text).locator('.glass-bubble');

async function open(page: Page, route?: (h: IndexHarness) => string): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page, { video: false });
  await h.open(route ? route(h) : h.routes.channel('fuelGeneral'));
  await page.evaluate(() => document.fonts.ready);
  return h;
}

async function busy(page: Page, h: IndexHarness) {
  await h.step('arrive');
  await h.step('crowd');
  await h.step('busy', { pace: 0 });
  await expect(page.getByText('yep, bringing the projector', { exact: true })).toBeVisible();
  await toBottom(page);
  await page.waitForTimeout(600);
}

/** A crop of the conversation column (main, below the old header). */
async function crop(page: Page, name: string, box?: { x: number; y: number; width: number; height: number }) {
  await mkdir(SHOTS, { recursive: true });
  await page.mouse.move(1270, 790);
  const main = await page.getByRole('main').boundingBox();
  if (!main) throw new Error('no main');
  await page.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    clip: box ?? { x: main.x, y: Math.max(main.y, 120), width: main.width, height: Math.min(main.height, 800) - Math.max(main.y, 120) },
  });
}

/** Put the conversation at its newest message (the feed itself, whether or not it overflows). */
async function toBottom(page: Page) {
  await feed(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
}

/** Every Index timeline animation still running. */
const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => typeof animation.id === 'string' && animation.id.startsWith('ix-timeline') && animation.playState === 'running')
      .map((animation) => animation.id),
  );

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  return box;
}

async function css(locator: Locator, properties: string[]) {
  return locator.evaluate((el, props) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
  }, properties);
}

test.describe('the timeline (§4.11)', () => {
  test('the reference states: joined, another server, busy, People', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await page.waitForTimeout(1600);
    await expect(page.getByText('You joined General')).toBeVisible();
    await shoot(page, 's2-joined');
    await crop(page, 's2-feed');
    await h.setClock(CLOCK.visit);
    await navigate(page, h.routes.place('gameNight'));
    await shoot(page, 's4-other-server');
    await crop(page, 's4-feed');
    await navigate(page, h.routes.channel('fuelGeneral'));
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await page.waitForTimeout(1600);
    await toBottom(page);
    await shoot(page, 's5-busy');
    await crop(page, 's5-feed');
    for (const size of ['desktop', 'narrow', 'phone'] as const) await shoot(page, 's5-busy', { size });
    await page.setViewportSize({ width: 1280, height: 800 });
    await navigate(page, h.routes.place('people'));
    await shoot(page, 's6-people');
    await crop(page, 's6-feed');
    // The join stays where it happened: between Jeremy's 9:41 messages and the busy stretch.
    await navigate(page, h.routes.channel('fuelGeneral'));
    await toBottom(page);
    const line = page.getByText('You joined General');
    await line.scrollIntoViewIfNeeded();
    const joined = await rect(line);
    expect((await rect(bubbleOf(page, 'I’m in General'))).y).toBeLessThan(joined.y);
    expect((await rect(bubbleOf(page, 'already in, come heckle'))).y).toBeGreaterThan(joined.y);
  });

  test('the feed keeps the prototype’s metrics', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    const main = await rect(page.getByRole('main'));
    const firstB = bubbleOf(page, 'need two more for a haz 5 run');
    const secondB = bubbleOf(page, 'Nick you in?');
    // Bubble: 9 14 padding, 19 radius, 15/1.42 on #26272b; the joins are 7 on the face's side.
    expect(await css(firstB, ['padding-top', 'padding-left', 'font-size', 'line-height', 'background-color', 'border-top-left-radius', 'border-bottom-left-radius', 'border-top-right-radius']))
      .toEqual({
        'padding-top': '9px',
        'padding-left': '14px',
        'font-size': '15px',
        'line-height': '21.3px',
        'background-color': 'rgb(38, 39, 43)',
        'border-top-left-radius': '19px',
        'border-bottom-left-radius': '7px',
        'border-top-right-radius': '19px',
      });
    expect((await css(secondB, ['border-top-left-radius', 'border-bottom-left-radius']))).toEqual({
      'border-top-left-radius': '7px',
      'border-bottom-left-radius': '19px',
    });
    const a = await rect(firstB);
    const b = await rect(secondB);
    expect(Math.round(a.height * 10) / 10).toBeCloseTo(39.3, 0);
    // 3px inside a group.
    expect(b.y - (a.y + a.height)).toBeCloseTo(3, 0);
    // The column: 48px in from main; bubbles 40 further (30 face + 10).
    expect(a.x - main.x).toBeCloseTo(48 + 40, 0);
    // The 30px face sits at the bottom of the group, beside its last bubble.
    const face = row(page, 'Nick you in?').locator('.ix-msg__face .ix-av');
    const f = await rect(face);
    expect([f.width, f.height]).toEqual([30, 30]);
    expect(f.y + f.height).toBeCloseTo(b.y + b.height, 0);
    expect(f.x - main.x).toBeCloseTo(48, 0);
    // The name: 12.5 ink-3, 13px in from the bubble, 3px above it.
    const name = row(page, 'need two more for a haz 5 run').locator('.ix-msg__name');
    expect(await css(name, ['font-size'])).toEqual({ 'font-size': '12.5px' });
    const n = await rect(name.getByRole('button', { name: 'Brendan' }));
    expect(n.x - a.x).toBeCloseTo(13, 0);
    expect(a.y - (n.y + n.height)).toBeCloseTo(3, 0);
    // 9px between groups.
    const nick = await rect(row(page, 'new personal best btw').locator('.ix-msg__name'));
    expect(nick.y - (b.y + b.height)).toBeCloseTo(9, 0);
    // Yours: cream, at the column's right edge, 3px under the group above.
    const mine = bubbleOf(page, 'that’s actually insane');
    expect(await css(mine, ['background-color', 'color'])).toEqual({ 'background-color': 'rgb(244, 242, 237)', color: 'rgb(20, 20, 20)' });
    const m = await rect(mine);
    expect(main.x + main.width - (m.x + m.width)).toBeCloseTo(48, 0);
    const above = await rect(bubbleOf(page, 'new personal best btw'));
    expect(m.y - (above.y + above.height)).toBeCloseTo(3, 0);
    // The last bubble sits 16px above the bottom of the scroller.
    const last = await rect(bubbleOf(page, 'yep, bringing the projector'));
    const scroller = await rect(feed(page));
    expect(scroller.y + scroller.height - (last.y + last.height)).toBeCloseTo(16, 0);
    // The system line: 13 ink-3 with an amber 14px glyph; the divider 12/500, its day 600.
    // At rest, nothing in the timeline moves.
    await page.waitForTimeout(2000);
    expect(await running(page)).toEqual([]);
  });

  test('a time divider and your own voice join read as the prototype’s', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await page.waitForTimeout(800);
    const divider = feed(page).getByRole('separator').first();
    await expect(divider).toHaveAccessibleName(/^Today 9:41\s?PM$/);
    expect(await css(divider, ['font-size', 'font-weight'])).toEqual({ 'font-size': '12px', 'font-weight': '500' });
    expect(await css(divider.locator('b'), ['font-weight'])).toEqual({ 'font-weight': '600' });
    const line = page.locator('.ix-tl-system', { hasText: 'You joined General' });
    expect(await css(line, ['font-size'])).toEqual({ 'font-size': '13px' });
    expect(await css(line.locator('.ix-tl-system__glyph'), ['color'])).toEqual({ color: 'rgb(255, 194, 126)' });
    const glyph = await rect(line.locator('svg'));
    expect([glyph.width, glyph.height]).toEqual([14, 14]);
    await crop(page, 'divider-and-join');
  });

  test('hover shows the time on the far side and the capsule at the top trailing corner', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    const target = row(page, 'clip it next time');
    const time = target.locator('.ix-msg__time');
    const capsule = target.locator('.ix-capsule');
    expect(await css(time, ['opacity'])).toEqual({ opacity: '0' });
    await expect(capsule).toBeHidden();
    await bubbleOf(page, 'clip it next time').hover();
    await expect(capsule).toBeVisible();
    await page.waitForTimeout(250);
    expect(await css(time, ['opacity', 'font-size'])).toEqual({ opacity: '1', 'font-size': '12px' });
    const bubble = await rect(bubbleOf(page, 'clip it next time'));
    const t = await rect(time);
    // Outside the bubble, on the far side.
    expect(t.x).toBeGreaterThan(bubble.x + bubble.width);
    await expect(time).toHaveText(/^10:00\s?PM$/);
    const c = await rect(capsule);
    expect(c.y).toBeLessThan(bubble.y);
    expect(c.x + c.width).toBeGreaterThan(bubble.x + bubble.width - 10);
    const buttons = capsule.getByRole('button');
    await expect(buttons).toHaveCount(4);
    const one = await rect(buttons.first());
    expect([one.width, one.height]).toEqual([28, 26]);
    await page.screenshot({ path: path.join(SHOTS, 'hover-others.png'), clip: { x: bubble.x - 60, y: bubble.y - 40, width: 560, height: 110 } });
    // Your own: the time on the left, the capsule at its top-left.
    await bubbleOf(page, 'that’s actually insane').hover();
    const mine = await rect(bubbleOf(page, 'that’s actually insane'));
    const myTime = await rect(row(page, 'that’s actually insane').locator('.ix-msg__time'));
    expect(myTime.x + myTime.width).toBeLessThan(mine.x);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, 'hover-own.png'), clip: { x: mine.x - 300, y: mine.y - 40, width: 560, height: 110 } });
    // More: the message's menu, under its button.
    await row(page, 'that’s actually insane').getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await page.waitForTimeout(300);
    await crop(page, 'menu-own');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('reactions bite the corner; a reply quotes its line above the bubble; edited says so', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    const target = h.world.channels.get('fuelGeneral')!.messages.find((m) => m.content === 'new personal best btw. 41 minutes, nobody went down')!;
    await h.step(say, {
      channel: 'fuelGeneral',
      who: 'brendan',
      text: 'no way, clip or it didn’t happen',
      replyTo: target.id,
      reactions: [
        { emoji: '\u{1F525}', count: 3, me: true },
        { emoji: '\u{1F602}', count: 1, me: false },
      ],
    });
    const reply = row(page, 'no way, clip or it didn’t happen');
    await expect(reply).toBeVisible();
    const line = reply.locator('.glass-tl-reply');
    await expect(line).toHaveText(/Nick: new personal best btw/);
    expect(await css(line, ['font-size'])).toEqual({ 'font-size': '13px' });
    const l = await rect(line);
    const bubble = await rect(reply.locator('.glass-bubble'));
    expect(l.y + l.height).toBeLessThanOrEqual(bubble.y);
    // One chip at the top-right corner, #34353a with a 3px ring in the main color; yours with a white count.
    const chip = reply.getByRole('group', { name: 'Reactions' });
    expect(await css(chip, ['background-color'])).toEqual({ 'background-color': 'rgb(52, 53, 58)' });
    const c = await rect(chip);
    expect(c.y).toBeLessThan(bubble.y);
    expect(c.x + c.width).toBeGreaterThan(bubble.x + bubble.width);
    expect(await css(chip.getByRole('button', { name: /3 reactions, including yours/ }).locator('.ix-bite__count'), ['color'])).toEqual({ color: 'rgb(242, 243, 245)' });
    // The quoted line jumps to the original and rings it.
    await line.click();
    await expect(page.locator(`#msg-${target.id}`)).toHaveAttribute('data-jump', 'true');
    // The jump holds its target in view for a moment; then back to the newest.
    await page.waitForTimeout(1800);
    await toBottom(page);
    await page.waitForTimeout(2600);
    await crop(page, 'reply-and-reactions');
  });

  test('somebody else’s message rises in from the avatar’s side and the conversation makes room', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    await page.evaluate(() => {
      const seen: Array<{ id: string; frames: Keyframe[]; duration: number; easing: string; composite: string; target: string }> = [];
      (window as unknown as { __ixArrive: typeof seen }).__ixArrive = seen;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        const animation = animate.apply(this, args);
        queueMicrotask(() => {
          if (!animation.id.startsWith('ix-timeline')) return;
          const timing = (animation.effect as KeyframeEffect).getTiming();
          seen.push({
            id: animation.id,
            frames: (animation.effect as KeyframeEffect).getKeyframes(),
            duration: Number(timing.duration),
            easing: String(timing.easing),
            composite: (animation.effect as KeyframeEffect).composite,
            target: this.id || this.className,
          });
        });
        return animation;
      };
    });
    const before = await rect(bubbleOf(page, 'yep, bringing the projector'));
    await h.step(say, { channel: 'fuelGeneral', who: 'jeremy', text: 'see you all in there' });
    await expect(row(page, 'see you all in there')).toBeVisible();
    await page.waitForTimeout(150);
    await crop(page, 'arrive-150ms');
    await page.waitForTimeout(700);
    const seen = await page.evaluate(() => (window as unknown as { __ixArrive: Array<{ id: string; frames: Keyframe[]; duration: number; easing: string; composite: string; target: string }> }).__ixArrive);
    const pops = seen.filter((entry) => entry.id === 'ix-timeline:arrive');
    expect(pops).toHaveLength(1);
    expect(pops[0].duration).toBe(550);
    expect(pops[0].easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(pops[0].frames[0]).toMatchObject({ opacity: '0', transform: 'translateY(14px) scale(0.96)', transformOrigin: '0% 100%' });
    const glides = seen.filter((entry) => entry.id === 'ix-timeline:make-room');
    expect(glides.length).toBeGreaterThan(3);
    expect(glides.every((entry) => entry.composite === 'add')).toBe(true);
    for (const entry of seen) {
      for (const frame of entry.frames) {
        for (const property of Object.keys(frame)) {
          expect(['transform', 'opacity', 'transformOrigin', 'offset', 'easing', 'composite', 'computedOffset']).toContain(property);
        }
      }
    }
    // What was at the bottom moved up by the new row, and is at rest there.
    const after = await rect(bubbleOf(page, 'yep, bringing the projector'));
    expect(after.y).toBeLessThan(before.y - 30);
    await page.waitForTimeout(1500);
    expect(await running(page)).toEqual([]);
    await crop(page, 'arrive-after');
  });

  test('typing: dots beside the typist’s face, then two typists by name', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    await h.step('typing', { channel: 'fuelGeneral', who: 'maya' });
    const typing = page.locator('.glass-tl-typing-row');
    await expect(typing).toBeVisible();
    const bubble = await rect(typing.locator('.ix-typing__bubble'));
    expect([Math.round(bubble.width), Math.round(bubble.height)]).toEqual([58, 39]);
    const face = await rect(typing.locator('.ix-av').first());
    expect(face.y + face.height).toBeCloseTo(bubble.y + bubble.height, 0);
    await crop(page, 'typing-one');
    await h.step('typing', { channel: 'fuelGeneral', who: 'nick' });
    await expect(typing.getByText('Maya and Nick are typing').first()).toBeVisible();
    await crop(page, 'typing-two');
  });

  test('the New divider sits above what you had not read, then leaves once you are at the bottom', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    await navigate(page, h.routes.place('gameNight'));
    await page.waitForTimeout(600);
    await h.setClock('2026-10-01T22:04:00-05:00');
    await h.step(say, { channel: 'fuelGeneral', who: 'vincent', text: 'ok who is actually coming' });
    await h.step(say, { channel: 'fuelGeneral', who: 'maya', text: 'me, five minutes' });
    await navigate(page, h.routes.channel('fuelGeneral'));
    const divider = page.getByTestId('new-divider');
    await expect(divider).toBeVisible();
    expect(await css(divider.locator('.ix-tl-new__label'), ['color', 'font-size', 'font-weight'])).toEqual({
      color: 'rgb(242, 243, 245)',
      'font-size': '12px',
      'font-weight': '600',
    });
    const d = await rect(divider);
    expect((await rect(bubbleOf(page, 'ok who is actually coming'))).y).toBeGreaterThan(d.y);
    expect((await rect(bubbleOf(page, 'yep, bringing the projector'))).y).toBeLessThan(d.y);
    await crop(page, 'new-divider');
    // Two seconds at the bottom: it fades, and the rows close over its line.
    await expect(divider).toHaveCount(0, { timeout: 4_000 });
    await page.waitForTimeout(1200);
    expect(await running(page)).toEqual([]);
  });

  test('jump to latest: a capsule above the message box once you are a screen up', async ({ page }) => {
    const h = await open(page);
    await h.step(chatter, { channel: 'fuelGeneral', count: 45 });
    await expect(page.getByText('who has the spare key for friday (40)')).toBeVisible();
    await toBottom(page);
    await page.waitForTimeout(400);
    const jump = page.locator('.ix-jump');
    await expect(jump).toHaveCount(0);
    // The reader scrolls up by hand (a wheel), so the timeline stops holding the bottom.
    const f = await rect(feed(page));
    await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -600);
    await page.waitForTimeout(600);
    await expect(jump).toBeVisible();
    await expect(jump).toHaveText(/Latest/);
    const j = await rect(jump);
    expect(Math.round(j.height)).toBe(34);
    const box = await rect(page.locator('textarea[data-composer-input]'));
    expect(j.y + j.height).toBeLessThan(box.y);
    await h.step(say, { channel: 'fuelGeneral', who: 'nick', text: 'anyone?' });
    await expect(jump).toHaveText(/1 new/);
    await crop(page, 'jump-to-latest');
    await jump.click();
    await expect(page.getByText('anyone?', { exact: true })).toBeVisible();
    await expect(jump).toHaveCount(0);
  });

  test('pictures are media bubbles, joined, fitted inside 360', async ({ page }) => {
    await open(page, (h) => h.routes.channel('gnScreenshots'));
    const media = page.locator('.ix-media');
    await expect(media).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const frame = await rect(media.nth(i).locator('.ix-media__frame'));
      expect(frame.width).toBeLessThanOrEqual(360);
      expect(frame.height).toBeLessThanOrEqual(360);
    }
    const first = media.first().locator('.ix-media__frame');
    expect(await css(first, ['border-top-left-radius', 'border-bottom-left-radius'])).toEqual({
      'border-top-left-radius': '19px',
      'border-bottom-left-radius': '7px',
    });
    await page.waitForTimeout(800);
    await crop(page, 'media');
  });

  test('your own message is edited in place: Esc cancels', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    const mine = row(page, 'that’s actually insane');
    await bubbleOf(page, 'that’s actually insane').hover();
    await mine.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const field = mine.getByRole('textbox', { name: 'Edit your message' });
    await expect(field).toBeFocused();
    await page.waitForTimeout(300);
    await crop(page, 'edit-in-place');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
  });

  test('compact density: tighter bubbles and a 24px face', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    await page.evaluate(() => document.documentElement.setAttribute('data-density', 'compact'));
    await page.waitForTimeout(400);
    expect(await css(bubbleOf(page, 'Nick you in?'), ['padding-top', 'padding-left', 'line-height'])).toEqual({
      'padding-top': '6px',
      'padding-left': '12px',
      'line-height': '20.25px',
    });
    await toBottom(page);
    await crop(page, 'compact');
  });
});
