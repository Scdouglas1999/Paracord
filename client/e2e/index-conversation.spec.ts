import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CH,
  GUILD,
  ME,
  actionCard,
  clickActionCard,
  composer,
  composerInput,
  installIndexScene,
  outDir,
  scrollConversation,
  shoot,
  title,
  toolbar,
  welcome,
  type IndexHarness,
} from './fixtures/index';
import { HISTORY_EPOCH } from './fixtures/index/world';

/**
 * IX-15 (Conversation chrome): docs/index-spec.md §4.11, §4.13, §5.6, §5.12, §5.14,
 * §6.8; docs/design/index-plan.md §3 IX-15.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-conversation PARACORD_E2E_INDEX_PORT=4633 \
 *   PARACORD_E2E_INDEX_RT_PORT=4635 PARACORD_E2E_INDEX_WP=ix15 \
 *     npx playwright test -c e2e/index-review.config.ts
 *   node e2e/index-compare.mjs ix15
 *
 * Shoots s0-quiet, s0-plan-a-night, s5-busy and s5-busy-title-folded at 1280x800
 * (held against ref/ with index-compare), the welcome and the busy channel at the other
 * sizes, and crops of the moments under `<WP>/conversation/`; holds the welcome, the
 * draft, the title fold, the DM call button, the drop target and the feed's FLIP to the
 * spec's numbers.
 */

const SHOTS = () => path.join(outDir(), 'conversation');

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
    body: JSON.stringify(body),
  });

async function open(page: Page, route?: (h: IndexHarness) => string, options: { video?: boolean } = {}): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page, { video: options.video ?? false });
  await h.open(route ? route(h) : h.routes.channel('fuelGeneral'));
  await expect(composer(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return h;
}

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('no box');
  return rect;
};

/** Every Index conversation animation still running. */
const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => typeof animation.id === 'string' && animation.id.startsWith('ix-conversation') && animation.playState === 'running')
      .map((animation) => animation.id),
  );

async function crop(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  await mkdir(SHOTS(), { recursive: true });
  await page.mouse.move(1270, 790);
  await page.screenshot({ path: path.join(SHOTS(), `${name}.png`), clip: clip ?? { x: 316, y: 0, width: 964, height: 800 } });
}

async function busy(page: Page, h: IndexHarness) {
  await h.step('arrive');
  await h.step('crowd');
  await h.step('busy', { pace: 0 });
  await expect(page.getByText('yep, bringing the projector', { exact: true })).toBeVisible();
  await page.waitForTimeout(800);
  await scrollConversation(page, 'bottom');
}

test.describe('the reference states', () => {
  test('quiet, Plan a night, busy and folded', async ({ page }) => {
    const h = await open(page);
    await expect(welcome(page)).toBeVisible();
    await shoot(page, 's0-quiet');
    for (const size of ['desktop', 'narrow', 'phone'] as const) await shoot(page, 's0-quiet', { size });
    await page.setViewportSize({ width: 1280, height: 800 });
    await clickActionCard(page, 'plan');
    await expect(page.getByTestId('ix-draft-event')).toBeVisible();
    await shoot(page, 's0-plan-a-night');
    await h.reload();
    await busy(page, h);
    await shoot(page, 's5-busy');
    for (const size of ['desktop', 'narrow', 'phone'] as const) await shoot(page, 's5-busy', { size });
    await page.setViewportSize({ width: 1280, height: 800 });
    await scrollConversation(page, 120);
    await shoot(page, 's5-busy-title-folded');
  });
});

test.describe('the welcome (§4.13)', () => {
  test('a new server: the prototype’s metrics', async ({ page }) => {
    await open(page);
    await expect(welcome(page)).toBeVisible();
    await page.waitForTimeout(700);
    // The large title and its line (§3.1: x = 316 + 48).
    expect((await box(title(page))).x).toBe(364);
    await expect(page.locator('.ix-large-title__sub')).toHaveText('Fuel’s main channel');
    // The mark is 76, the title 24/600, the line 15; three cards of 196 with 12 between.
    const mark = await box(welcome(page).locator('.ix-sq'));
    expect([mark.width, mark.height]).toEqual([76, 76]);
    expect(await welcome(page).locator('.ix-sq').evaluate((el) => getComputedStyle(el).borderRadius)).toBe('22px');
    await expect(welcome(page).getByRole('heading', { name: 'Fuel is ready' })).toBeVisible();
    await expect(welcome(page).getByText('Three good ways to start it.')).toBeVisible();
    const h2 = await welcome(page).getByRole('heading').evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.fontSize, style.fontWeight, style.letterSpacing];
    });
    expect(h2[0]).toBe('24px');
    expect(h2[1]).toBe('600');
    const cards = [await box(actionCard(page, 'invite')), await box(actionCard(page, 'plan')), await box(actionCard(page, 'hello'))];
    for (const card of cards) expect(card.width).toBe(196);
    expect(cards[1].x - (cards[0].x + 196)).toBe(12);
    expect(cards[2].x - (cards[1].x + 196)).toBe(12);
    // Centered in main (316..1280).
    expect(Math.abs(cards[0].x + (cards[2].x + 196 - cards[0].x) / 2 - 798)).toBeLessThan(2);
    // The reference's position: the mark's top is 241, the cards end at 561 (to a pixel).
    expect(Math.abs(mark.y - 241)).toBeLessThanOrEqual(2);
    expect(Math.abs(cards[0].y + cards[0].height - 561)).toBeLessThanOrEqual(2);
    // A card is the tile in the place's hue, a 15/700 title, a 13 line.
    const first = actionCard(page, 'invite');
    expect(await first.locator('.ix-way__gl').evaluate((el) => [el.getBoundingClientRect().width, getComputedStyle(el).borderRadius])).toEqual([38, '12px']);
    expect(await first.locator('.ix-way__a').evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(['15px', '700']);
    expect(await first.evaluate((el) => [getComputedStyle(el).borderRadius, getComputedStyle(el).paddingTop])).toEqual(['18px', '16px']);
    // Nothing runs at rest.
    expect(await running(page)).toEqual([]);
  });

  test('the cards lift 3px under the pointer', async ({ page }) => {
    await open(page);
    const card = actionCard(page, 'hello');
    const before = await box(card);
    await card.hover();
    await page.waitForTimeout(700);
    const after = await box(card);
    expect(Math.round(before.y - after.y)).toBe(3);
  });

  test('under 640px of column the cards stack', async ({ page }) => {
    await open(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    const cards = [await box(actionCard(page, 'invite')), await box(actionCard(page, 'plan'))];
    expect(cards[1].y).toBeGreaterThan(cards[0].y + cards[0].height - 1);
    expect(cards[1].x).toBe(cards[0].x);
    await crop(page, 'welcome-narrow@900x700', { x: 280, y: 0, width: 620, height: 700 });
  });

  test('Say hello fills the box with a greeting, selects it and focuses it, and sends nothing', async ({ page }) => {
    const sent: string[] = [];
    await open(page);
    await page.route('**/api/v1/channels/*/messages', (route) => {
      if (route.request().method() === 'POST') sent.push(route.request().postData() ?? '');
      return route.fallback();
    });
    await clickActionCard(page, 'hello');
    const input = composerInput(page);
    await expect(input).toHaveValue('Hello! Fuel is open, come hang out.');
    await expect(input).toBeFocused();
    const selected = await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.value.length]);
    expect(selected).toEqual([0, 35, 35]);
    await page.waitForTimeout(900);
    expect(sent).toEqual([]);
    await crop(page, 'say-hello');
    // Typing replaces the selected greeting: it is a suggestion, not a message.
    await page.keyboard.type('hey all');
    await expect(input).toHaveValue('hey all');
  });

  test('Bring your people copies a link that never ends, says so for two seconds, then the dialog', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const made: string[] = [];
    await open(page);
    await page.route(`**/api/v1/channels/${CH.fuelGeneral}/invites`, (route) => {
      made.push(route.request().postData() ?? '');
      return json(route, { code: 'fuelfuel', channel_id: CH.fuelGeneral, guild_id: GUILD.fuel.id, created_at: '2026-10-01T00:00:00Z', inviter_id: ME.id, max_age: 0, max_uses: 0, uses: 0 }, 201);
    });
    await page.route(`**/api/v1/guilds/${GUILD.fuel.id}/invites`, (route) => json(route, { error: 'forbidden' }, 403));
    await page.route('**/api/v1/instance/share-address', (route) => json(route, { url: 'https://paracord.example', reach: 'internet' }));
    const card = actionCard(page, 'invite');
    await card.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://paracord.example/invite/fuelfuel');
    expect(JSON.parse(made[0])).toEqual({ max_age: 0, max_uses: 0 });
    // The title crossfades to "Link copied" (90ms, opacity), the card keeps its size.
    await expect(card.locator('.ix-way__title--swap')).toHaveAttribute('data-copied', 'true');
    await page.waitForTimeout(350);
    expect(await card.locator('.ix-way__b').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await card.locator('.ix-way__a').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await crop(page, 'link-copied');
    await page.waitForTimeout(2400);
    await expect(card.locator('.ix-way__title--swap')).not.toHaveAttribute('data-copied', 'true');
    // A second press opens the invite dialog (its own options make their own invite, 7 days by default);
    // the card made no second one.
    expect(made).toHaveLength(1);
    await card.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await crop(page, 'invite-dialog', { x: 0, y: 0, width: 1280, height: 800 });
    expect(made.slice(1).every((body) => JSON.parse(body).max_age === 604800)).toBe(true);
  });

  test('Plan a night: the card grows into a draft, Post it makes the event and posts it', async ({ page }) => {
    const h = await open(page);
    const created: Array<Record<string, unknown>> = [];
    const posted: string[] = [];
    let event: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/guilds/${GUILD.fuel.id}/events**`, (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}');
        created.push(body);
        event = {
          id: '7771',
          guild_id: GUILD.fuel.id,
          channel_id: body.channel_id ?? null,
          creator_id: ME.id,
          name: body.name,
          description: null,
          scheduled_start: body.scheduled_start,
          scheduled_end: null,
          status: 1,
          entity_type: body.entity_type,
          location: null,
          image_url: null,
          user_count: 0,
          user_rsvp: false,
          created_at: '2026-10-01T21:38:00Z',
        };
        return json(route, event, 201);
      }
      if (/\/events\/7771$/.test(request.url())) return json(route, event);
      return json(route, event ? [event] : []);
    });
    await page.route(`**/api/v1/channels/${CH.fuelGeneral}/messages`, (route) => {
      if (route.request().method() === 'POST') posted.push(route.request().postData() ?? '');
      return route.fallback();
    });
    const from = await box(actionCard(page, 'plan'));
    await clickActionCard(page, 'plan');
    // The morph: the draft grows out of the card (295ms), the welcome fades out (135ms); transform and opacity only.
    await page.waitForTimeout(120);
    const playing = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => (animation.id || '').startsWith('ix-conversation'))
        .map((animation) => {
          const effect = animation.effect as KeyframeEffect;
          return {
            id: animation.id,
            duration: effect.getComputedTiming().duration,
            properties: [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key)).sort(),
          };
        }),
    );
    const grow = playing.find((animation) => animation.id === 'ix-conversation:draft');
    expect(grow?.duration).toBe(295);
    expect(grow?.properties).toEqual(['opacity', 'transform', 'transformOrigin']);
    expect(playing.find((animation) => animation.id === 'ix-conversation:welcome-out')?.duration).toBe(135);
    await crop(page, 'plan-morph-120ms');
    await page.waitForTimeout(1500);
    expect(await running(page)).toEqual([]);
    await expect(welcome(page)).toHaveCount(0);
    // The draft: 400 wide, radius 20, on the right of the column, on the box.
    const draft = page.getByTestId('ix-draft-event').locator('.ix-event');
    const card = await box(draft);
    expect(card.width).toBe(400);
    expect(Math.round(card.x + card.width)).toBe(1232);
    expect(await draft.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('20px');
    expect(Math.abs(card.y + card.height - (730 - 16))).toBeLessThanOrEqual(2);
    await expect(draft).toContainText('Game night');
    await expect(draft).toContainText(/Friday at 9:00\sPM · in General/);
    expect(from.width).toBeGreaterThan(0);
    // Nothing exists until Post it.
    expect(created).toEqual([]);
    expect(posted).toEqual([]);
    await crop(page, 'plan-draft');
    await page.getByRole('button', { name: 'Post it' }).click();
    await expect.poll(() => posted.length).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Game night', entity_type: 1, channel_id: CH.fuelRoomGeneral, reminder_minutes: 30 });
    expect(new Date(String(created[0].scheduled_start)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Chicago' })).toBe('Friday');
    expect(JSON.parse(posted[0]).content).toBe('<event:7771>');
    // The message lands: the empty state ends, the event is a card in the feed, and the sidebar says what it is.
    await expect(page.getByTestId('ix-draft-event')).toHaveCount(0);
    await expect(page.locator('.glass-timeline').getByText('Game night')).toBeVisible();
    // The real server tells every member's client the event exists (GUILD_SCHEDULED_EVENT_CREATE); the stub has no
    // such frame, so say it the way the gateway handler does. The sidebar then reads the post as the event.
    await page.evaluate((guildId) => window.dispatchEvent(new CustomEvent('paracord:scheduled-events-changed', { detail: { guild_id: guildId } })), GUILD.fuel.id);
    await expect(page.getByTestId('ix-sidebar').getByText(/Game night/)).toBeVisible();
    await crop(page, 'plan-posted');
    void h;
  });

  test('Plan a night › Edit opens the event form first, with the draft in it', async ({ page }) => {
    await open(page);
    await clickActionCard(page, 'plan');
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder('Movie Night')).toHaveValue('Game night');
    // Friday 9 PM local, in the form's wall-clock value.
    const start = await dialog.locator('input[type="datetime-local"]').first().inputValue();
    expect(start).toMatch(/T21:00$/);
    await crop(page, 'plan-edit', { x: 0, y: 0, width: 1280, height: 800 });
  });
});

test.describe('the title and the toolbar (§4.9, §4.11, §5.14)', () => {
  test('the large title folds into the toolbar as the conversation scrolls', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    await scrollConversation(page, 0);
    await page.waitForTimeout(400);
    await expect(title(page)).toBeVisible();
    const bar = toolbar(page);
    await expect(bar).toHaveAttribute('data-folded', 'false');
    const folded = bar.locator('.ix-toolbar__title');
    // Not folded: the toolbar's title is out of the reading order and the Tab order.
    await expect(folded).toHaveAttribute('aria-hidden', 'true');
    expect(await folded.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    // Half way: scale 1 - .1t and opacity 1 - .9t from the left edge.
    await scrollConversation(page, 30);
    await page.waitForTimeout(150);
    const mid = await title(page).locator('xpath=ancestor::header').evaluate((el) => [(el as HTMLElement).style.transform, (el as HTMLElement).style.opacity]);
    expect(mid[0]).toBe('scale(0.95)');
    expect(mid[1]).toBe('0.55');
    await expect(bar).toHaveAttribute('data-folded', 'false');
    // Past 40px: the folded title and the toolbar's fill.
    await scrollConversation(page, 60);
    await page.waitForTimeout(600);
    await expect(bar).toHaveAttribute('data-folded', 'true');
    await expect(folded).toHaveText('general');
    expect(await folded.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(16, 17, 19, 0.92)');
    expect(await bar.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');
    await crop(page, 'folded-toolbar', { x: 316, y: 0, width: 964, height: 160 });
    // And back.
    await scrollConversation(page, 0);
    await page.waitForTimeout(600);
    await expect(bar).toHaveAttribute('data-folded', 'false');
  });

  test('the title, large or folded, opens the channel menu', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    await scrollConversation(page, 0);
    await title(page).getByRole('button', { name: 'general' }).click();
    await expect(page.getByTestId('ix-channel-menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Pinned messages/ })).toBeVisible();
    await crop(page, 'channel-menu', { x: 316, y: 0, width: 600, height: 460 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ix-channel-menu')).toHaveCount(0);
    await scrollConversation(page, 120);
    await page.waitForTimeout(500);
    await toolbar(page).locator('.ix-toolbar__title').click();
    await expect(page.getByTestId('ix-channel-menu')).toBeVisible();
  });

  test('a topic is the line under the title', async ({ page }) => {
    await open(page, (h) => h.routes.channel('fuelClips'));
    await expect(title(page)).toHaveText('clips');
    await expect(page.locator('.ix-large-title__sub')).toHaveText('Share your best moments');
    await expect(welcome(page).getByRole('heading', { name: 'clips is ready' })).toBeVisible();
    await expect(welcome(page).getByText('Share your best moments')).toBeVisible();
    // Not the server's first channel: the cards that fit (Say hello, Plan a night), no invite.
    await expect(actionCard(page, 'invite')).toHaveCount(0);
    await expect(actionCard(page, 'hello')).toBeVisible();
    await expect(actionCard(page, 'plan')).toBeVisible();
    await crop(page, 'welcome-channel');
  });
});

test.describe('a direct message (§4.9, §4.11, §7.5)', () => {
  test('is titled by the person, with a call button left of search that starts the call and then opens it', async ({ page }) => {
    await open(page, (h) => h.routes.dm('dmJeremy'));
    await expect(title(page)).toHaveText('Jeremy');
    await expect(page.locator('.ix-large-title__sub')).toHaveText('Direct message');
    const bar = toolbar(page);
    const call = bar.getByTestId('ix-dm-call');
    const search = bar.getByRole('button', { name: 'Search messages' });
    expect((await box(call)).x).toBeLessThan((await box(search)).x);
    expect(await box(call)).toMatchObject({ width: 34, height: 34 });
    await expect(call).toHaveAccessibleName('Start a call');
    await expect(call).not.toHaveAttribute('data-active');
    await call.click();
    await expect(call).toHaveAttribute('data-active', 'true');
    await expect(call).toHaveAccessibleName('Open the call');
    expect(await call.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 194, 126)');
    await crop(page, 'dm-call-active', { x: 316, y: 0, width: 964, height: 160 });
    await call.click();
    await expect(page.getByTestId('ix-call')).toBeVisible();
  });

  test('its title is the person’s profile card; a right click on it is the channel menu', async ({ page }) => {
    await open(page, (h) => h.routes.dm('dmJeremy'));
    await title(page).getByRole('button', { name: 'Jeremy' }).click();
    await expect(page.getByRole('dialog', { name: /Jeremy/ }).or(page.getByTestId('ix-profile'))).toBeVisible();
    await page.keyboard.press('Escape');
    await title(page).click({ button: 'right' });
    await expect(page.getByTestId('ix-channel-menu')).toBeVisible();
  });
});

test.describe('the drop target (§4.12)', () => {
  /** Dispatch a file drag on an element, the way the browser does. */
  const drag = (page: Page, selector: string, type: 'dragenter' | 'dragover' | 'dragleave' | 'drop') =>
    page.evaluate(
      ([target, kind]) => {
        const el = document.querySelector(target)!;
        const data = new DataTransfer();
        data.items.add(new File(['x'], 'sketch.png', { type: 'image/png' }));
        el.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data }));
      },
      [selector, type] as const,
    );

  test('dragging files over main dims it with a dashed outline, and a drop queues them in the box', async ({ page }) => {
    await open(page);
    await expect(welcome(page)).toBeVisible();
    await drag(page, '.ix-conv-empty', 'dragenter');
    const target = page.getByTestId('ix-drop-target');
    await expect(target).toBeVisible();
    await expect(target).toContainText('Drop to share in general');
    const main = await box(page.getByRole('main'));
    const outer = await box(target);
    expect(outer).toMatchObject({ x: main.x, y: main.y, width: main.width, height: main.height });
    const dashed = target.locator('.ix-drop__box');
    const inner = await box(dashed);
    expect(inner.x - outer.x).toBe(10);
    expect(inner.y - outer.y).toBe(10);
    expect(await dashed.evaluate((el) => [getComputedStyle(el).borderTopStyle, getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderTopLeftRadius])).toEqual(['dashed', '2px', '24px']);
    expect(await target.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(14, 15, 17, 0.9)');
    await page.waitForTimeout(300);
    await crop(page, 'drop-target');
    await drag(page, '.ix-conv-empty', 'drop');
    await expect(target).toHaveCount(0);
    await expect(composer(page).getByRole('button', { name: 'Remove sketch.png' })).toBeVisible();
  });

  test('steps aside over the box, and a leave puts it away', async ({ page }) => {
    await open(page);
    await expect(welcome(page)).toBeVisible();
    await drag(page, '.ix-conv-empty', 'dragenter');
    await expect(page.getByTestId('ix-drop-target')).toBeVisible();
    await drag(page, '[data-testid="ix-composer"]', 'dragover');
    await expect(page.getByTestId('ix-drop-target')).toHaveCount(0);
    await drag(page, '.ix-conv-empty', 'dragover');
    await expect(page.getByTestId('ix-drop-target')).toBeVisible();
    await drag(page, '.ix-conv-empty', 'dragleave');
    await expect(page.getByTestId('ix-drop-target')).toHaveCount(0);
  });
});

test.describe('the feed follows the message box (§5.12)', () => {
  test('opening the box moves the feed 225ms on the spring; closing, 160ms; transform only; nothing runs after', async ({ page }) => {
    const h = await open(page);
    await busy(page, h);
    const bottom = page.getByText('yep, bringing the projector', { exact: true });
    const before = await box(bottom);
    await composerInput(page).click();
    await page.waitForTimeout(60);
    const grow = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.id === 'ix-conversation:feed')
        .map((animation) => {
          const effect = animation.effect as KeyframeEffect;
          const timing = effect.getComputedTiming();
          return {
            duration: timing.duration,
            easing: timing.easing,
            composite: effect.composite,
            keyframes: effect.getKeyframes().map((frame) => frame.transform),
            properties: [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key)),
          };
        }),
    );
    expect(grow.length).toBeGreaterThan(0);
    expect(grow[0].duration).toBe(225);
    expect(grow[0].composite).toBe('add');
    expect(grow[0].easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(grow[0].properties).toEqual(['transform']);
    expect(grow[0].keyframes[1]).toBe('translateY(0px)');
    // The message above the box ends up 46px higher: it makes room, it is never covered.
    await page.waitForTimeout(900);
    const opened = await box(bottom);
    expect(Math.round(before.y - opened.y)).toBe(46);
    expect(opened.y + opened.height).toBeLessThan((await box(composer(page))).y);
    expect(await running(page)).toEqual([]);
    await crop(page, 'feed-follows-open');
    // Closing: 160ms.
    await page.getByRole('main').click({ position: { x: 40, y: 300 } });
    await page.keyboard.press('Escape');
    await composerInput(page).evaluate((el) => (el as HTMLElement).blur());
    await page.waitForTimeout(40);
    const shrink = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.id === 'ix-conversation:feed')
        .map((animation) => (animation.effect as KeyframeEffect).getComputedTiming().duration),
    );
    if (shrink.length > 0) expect(shrink[0]).toBe(160);
    await page.waitForTimeout(900);
    expect(await running(page)).toEqual([]);
    const closed = await box(bottom);
    expect(Math.abs(closed.y - before.y)).toBeLessThanOrEqual(1);
  });

  test('a welcome centered in the empty area moves half as far as the box grows', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(700);
    const mark = welcome(page).locator('.ix-sq');
    const before = await box(mark);
    await composerInput(page).click();
    await page.waitForTimeout(900);
    const after = await box(mark);
    expect(Math.round(before.y - after.y)).toBe(23);
  });
});

test.describe('notices (§6.8)', () => {
  test('the banner strip: 36px in the card’s color across the top of main, with its words and one action', async ({ page }) => {
    await open(page);
    await page.evaluate(async () => {
      const ui = await import('/src/stores/uiStore.ts');
      ui.useUIStore.setState({ serverRestarting: true });
    });
    const strip = page.getByTestId('ix-banner-restart');
    await expect(strip).toBeVisible();
    await page.waitForTimeout(700);
    const rect = await box(strip);
    // Over main only (§6.8, the frame's banner host since IX-18): the sidebar keeps the window's top.
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([316, 0, 964, 36]);
    expect((await box(page.getByTestId('ix-sidebar'))).y).toBe(0);
    expect(await strip.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(['rgb(42, 43, 47)', '13px', '600']);
    // Main is pushed down by exactly the strip: the toolbar is under it, never covered.
    expect((await box(toolbar(page))).y).toBe(36);
    await expect(strip).toHaveText('The instance is restarting. You’ll reconnect automatically.');
    await crop(page, 'banner-restart', { x: 0, y: 0, width: 1280, height: 160 });
    await page.evaluate(async () => {
      const ui = await import('/src/stores/uiStore.ts');
      ui.useUIStore.setState({ serverRestarting: false });
    });
    await expect(strip).toHaveCount(0);
    await page.waitForTimeout(300);
    expect((await box(toolbar(page))).y).toBe(0);
  });
});
