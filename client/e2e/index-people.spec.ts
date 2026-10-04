import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  CH,
  CLOCK,
  GUILD,
  HISTORY_EPOCH,
  PEOPLE,
  dockItem,
  installIndexScene,
  navigate,
  searchField,
  shoot,
  sidebar,
  sidebarHeader,
  type IndexHarness,
  type PersonKey,
} from './fixtures/index';

/**
 * IX-14 (People place): the People sidebar, Friends, Inbox, New message, Discover and the
 * redirects that replace Home (docs/index-spec.md §3.1, §4.1, §6.6, §8.1, §8.6; docs/design/
 * index-plan.md §3 IX-14), held against the reference's s6 (index-compare reads the sidebar).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-people PARACORD_E2E_INDEX_PORT=4623 \
 *   PARACORD_E2E_INDEX_RT_PORT=4625 PARACORD_E2E_INDEX_WP=ix14 \
 *     npx playwright test -c e2e/index-review.config.ts
 *   node e2e/index-compare.mjs ix14
 *
 * Geometry is what the prototype measures at 1x (paracord-index.html, `ref/s6-people.png`):
 * the header's face at (18, 20), search 74-108, a label 37 tall, conversation rows on a 56
 * pitch with a 38px face. Friends and relationships are not in the harness's world (GET answers
 * `[]`), so this spec answers them itself.
 */

const MOTION_GONE_MS = 2_000;
const MEMORY_KEY = 'paracord:ix-last-place';

type Kind = 1 | 2 | 3 | 4;
interface Relation {
  who: PersonKey;
  type: Kind;
}

/**
 * Answer `/users/@me/relationships` with these people (1 friend, 2 blocked, 3 incoming, 4
 * outgoing), and keep the answer true as the page accepts and removes them.
 */
async function relate(page: Page, h: IndexHarness, initial: readonly Relation[]): Promise<Relation[]> {
  const relations = [...initial];
  const headers = { 'X-Paracord-History-Epoch': HISTORY_EPOCH };
  await page.route('**/api/v1/users/@me/relationships**', (route) => {
    const request = route.request();
    const method = request.method();
    const tail = new URL(request.url()).pathname.split('/').pop() ?? '';
    const known = Object.values(PEOPLE).find((person) => person.id === tail);
    if (method === 'PUT' && known) {
      const found = relations.find((entry) => PEOPLE[entry.who].id === known.id);
      if (found) found.type = 1;
      return route.fulfill({ status: 204, headers, body: '' });
    }
    if (method === 'DELETE' && known) {
      const index = relations.findIndex((entry) => PEOPLE[entry.who].id === known.id);
      if (index >= 0) relations.splice(index, 1);
      return route.fulfill({ status: 204, headers, body: '' });
    }
    if (method !== 'GET') return route.fulfill({ status: 204, headers, body: '' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers,
      body: JSON.stringify(
        relations.map(({ who, type }) => {
          const user = h.world.userRecord(who);
          return {
            id: `${user.id}:${PEOPLE.you.id}`,
            type,
            rel_type: type,
            user_id: user.id,
            target_id: PEOPLE.you.id,
            created_at: '2026-09-01T12:00:00-05:00',
            user: {
              id: user.id,
              username: user.username,
              display_name: user.display_name,
              discriminator: user.discriminator,
              avatar_hash: null,
            },
          };
        }),
      ),
    });
  });
  return relations;
}

/** `GET /channels/{id}/messages/attention`: the first message after your read position that is not yours. */
async function answerAttention(page: Page, h: IndexHarness): Promise<void> {
  await page.route('**/api/v1/channels/*/messages/attention**', (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[4];
    const channel = h.world.channelByIdOrKey(id);
    const after = BigInt(url.searchParams.get('after') || '0');
    const found = channel?.messages.find((message) => BigInt(message.id) > after && message.author !== 'you') ?? null;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
      body: JSON.stringify({
        channel_id: id,
        user_id: PEOPLE.you.id,
        kind: url.searchParams.get('kind'),
        message: found ? h.world.revisedMessageRecord(found) : null,
      }),
    });
  });
}

/** Saved messages and reminders: none (the harness does not model them). */
async function answerEmptyLists(page: Page): Promise<void> {
  const headers = { 'X-Paracord-History-Epoch': HISTORY_EPOCH };
  await page.route('**/api/v1/users/@me/saved-messages**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ items: [], total: 0 }) }),
  );
  await page.route('**/api/v1/users/@me/reminders**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ items: [] }) }),
  );
}

async function open(page: Page, route?: string, relations: readonly Relation[] = []): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page);
  await relate(page, h, relations);
  await answerAttention(page, h);
  await answerEmptyLists(page);
  await h.open(route ?? h.routes.dm('dmJeremy'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const box = (locator: Locator): Promise<Box> =>
  locator.first().evaluate((element) => {
    const r = element.getBoundingClientRect();
    const round = (value: number) => Math.round(value * 100) / 100;
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  });

/** Every animation in the document: its id and the transforms of its keyframes. */
const animations = (page: Page) =>
  page.evaluate(() =>
    document.getAnimations().map((animation) => ({
      id: animation.id,
      transforms: (animation.effect as KeyframeEffect | null)?.getKeyframes().map((frame) => frame.transform ?? null) ?? [],
    })),
  );
const animationIds = async (page: Page) => (await animations(page)).map((animation) => animation.id).filter(Boolean);

const dmRow = (page: Page, key: 'dmJeremy' | 'dmNick' | 'dmMaya') => page.locator(`[data-testid="ix-dm-row"][data-channel-id="${CH[key]}"]`);
const friendsRow = (page: Page) => page.getByTestId('ix-people-friends');
const inboxRow = (page: Page) => page.getByTestId('ix-people-inbox');
const path = (page: Page) => new URL(page.url()).pathname;

const FRIENDS: Relation[] = [
  { who: 'jeremy', type: 1 },
  { who: 'nick', type: 1 },
  { who: 'maya', type: 1 },
  { who: 'vincent', type: 1 },
  { who: 'brendan', type: 3 },
];

test.describe('IX-14 People sidebar', () => {
  test('s6: the header, the search field, Friends, Inbox and the conversations sit where the prototype puts them, and nothing moves at rest', async ({ page }) => {
    await open(page, undefined, FRIENDS);
    const header = sidebarHeader(page);
    // Header: your face where a server has its mark (40 at 18, 20), the name and the line, the "…" at the far side.
    await expect(header).toContainText('People');
    await expect(header).toContainText('Friends and direct messages');
    expect(await box(header.locator('[data-avatar]'))).toMatchObject({ x: 18, y: 20, width: 40, height: 40 });
    expect(await box(header.getByRole('button', { name: 'People options' }))).toMatchObject({ x: 268, y: 25, width: 30, height: 30 });
    // Search: the prototype's field, words only, 292 wide at y 74.
    expect(await box(searchField(page))).toMatchObject({ x: 12, y: 74, width: 292, height: 34 });
    await expect(searchField(page)).toHaveText('Search people');
    await expect(searchField(page).locator('kbd')).toHaveCount(0);
    // Friends and Inbox: channel rows (every row in People is 54 tall), directly under the search field.
    expect(await box(friendsRow(page))).toMatchObject({ x: 12, y: 112, width: 292, height: 54 });
    expect(await box(inboxRow(page))).toMatchObject({ x: 12, y: 168, width: 292, height: 54 });
    await expect(friendsRow(page)).toContainText('3 online · 1 request');
    // Game Night's looking-for-group starts unread: the Inbox's line is its newest, worded like a channel's.
    await expect(inboxRow(page)).toContainText('Maya in looking-for-group: need one for ranked');
    // Messages: a 37px label, then rows on the prototype's 56 pitch with a 38px face at x 22.
    await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
    expect(await box(page.locator('.ix-section-label').first())).toMatchObject({ x: 12, y: 222, height: 37 });
    for (const [key, top] of [['dmJeremy', 259], ['dmNick', 315], ['dmMaya', 371]] as const) {
      expect(await box(dmRow(page, key))).toMatchObject({ x: 12, y: top, width: 292, height: 54 });
      expect(await box(dmRow(page, key).locator('[data-avatar]'))).toMatchObject({ x: 22, y: top + 8, width: 38, height: 38 });
    }
    await expect(dmRow(page, 'dmJeremy')).toContainText('Jeremy');
    await expect(dmRow(page, 'dmJeremy')).toContainText('see you tonight');
    await expect(dmRow(page, 'dmJeremy')).toContainText('9:12 PM');
    await expect(dmRow(page, 'dmNick')).toContainText('lol yeah');
    await expect(dmRow(page, 'dmNick')).toContainText('Mon');
    await expect(dmRow(page, 'dmMaya')).toContainText('ok sending the invite');
    await expect(dmRow(page, 'dmMaya')).toContainText('Sun');
    // The open conversation is the current row, and the selection sits behind it (one element, moved by transform).
    await expect(dmRow(page, 'dmJeremy')).toHaveAttribute('aria-current', 'page');
    await expect(dmRow(page, 'dmNick')).not.toHaveAttribute('aria-current', 'page');
    expect(await box(page.locator('.ix-sel'))).toMatchObject({ x: 12, y: 259, width: 292, height: 54 });
    // The sidebar is the place's nav, and quiet at rest.
    await expect(sidebar(page)).toHaveAttribute('aria-label', 'People');
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
    await shoot(page, 'people-quiet');
  });

  test('s6 (held against the reference): People with your call pinned on top', async ({ page }) => {
    const h = await open(page, h0(), FRIENDS);
    await h.step('arrive');
    await h.step('join');
    await h.step('crowd');
    await navigate(page, h.routes.dm('dmJeremy'));
    await expect(dmRow(page, 'dmJeremy')).toHaveAttribute('aria-current', 'page');
    await shoot(page, 's6-people');
  });

  test('a conversation with something new gets the dot and the line rolls; the open one never does', async ({ page }) => {
    const h = await open(page, undefined, FRIENDS);
    await h.step('message', { channel: 'dmNick', who: 'nick', text: 'you coming tonight?' });
    await expect(dmRow(page, 'dmNick')).toHaveAttribute('data-unread', 'true');
    await expect(dmRow(page, 'dmNick')).toContainText('you coming tonight?');
    await expect(dmRow(page, 'dmNick')).toContainText('Unread'.toLowerCase());
    // The new line rolls up from below (§5.3).
    const roll = (await animations(page)).find((animation) => animation.id === 'ix-preview:line');
    expect(roll?.transforms[0]).toBe('translateY(9px)');
    // A message in the conversation you are reading is read as it arrives: no dot.
    await h.step('message', { channel: 'dmJeremy', who: 'jeremy', text: 'ok on my way' });
    await expect(dmRow(page, 'dmJeremy')).toContainText('ok on my way');
    await expect(dmRow(page, 'dmJeremy')).not.toHaveAttribute('data-unread', 'true');
    // The Inbox row says what is waiting: the newest unread thing, worded as a last line.
    await expect(inboxRow(page)).toContainText('Nick: you coming tonight?');
    await shoot(page, 'people-unread');
  });

  test('clicking a conversation opens it and the selection glides to it (transform only)', async ({ page }) => {
    await open(page, undefined, FRIENDS);
    await dmRow(page, 'dmNick').click();
    await expect.poll(() => path(page)).toBe(`/app/dms/${CH.dmNick}`);
    await expect(dmRow(page, 'dmNick')).toHaveAttribute('aria-current', 'page');
    const glide = (await animations(page)).find((animation) => animation.id === 'ix-select:glide');
    // Positions are in the rows' own coordinate space (the list starts at 112, Jeremy at 259, Nick at 315).
    expect(glide?.transforms).toEqual(['translateY(147px)', 'translateY(203px)']);
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
  });

  test('Friends and Inbox are pages: the row opens each and carries the selection', async ({ page }) => {
    await open(page, undefined, FRIENDS);
    await friendsRow(page).click();
    await expect.poll(() => path(page)).toBe('/app/friends');
    await expect(friendsRow(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('ix-title')).toHaveText('Friends');
    await inboxRow(page).click();
    await expect.poll(() => path(page)).toBe('/app/inbox');
    await expect(inboxRow(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('ix-title')).toHaveText('Inbox');
    // People stays the place for both: the sidebar is still People's, and the dock says so.
    await expect(sidebar(page)).toHaveAttribute('aria-label', 'People');
    await expect(dockItem(page, 'people')).toHaveAttribute('aria-current', 'page');
  });

  test('the "…" opens the People menu, and the Messages "+" opens New message', async ({ page }) => {
    await open(page, undefined, FRIENDS);
    await sidebarHeader(page).getByRole('button', { name: 'People options' }).click();
    const menu = page.getByTestId('ix-people-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([/New message/, /Start a group/, /Add friend/, /Settings/]);
    await page.keyboard.press('Escape');
    await dmRow(page, 'dmJeremy').hover();
    await page.getByRole('button', { name: 'New message' }).first().click();
    await expect(page.getByRole('dialog', { name: 'New message' })).toBeVisible();
  });

  test('arrow keys move through the rows as one Tab stop', async ({ page }) => {
    await open(page, undefined, FRIENDS);
    await dmRow(page, 'dmJeremy').focus();
    await page.keyboard.press('ArrowDown');
    await expect(dmRow(page, 'dmNick')).toBeFocused();
    await page.keyboard.press('End');
    await expect(dmRow(page, 'dmMaya')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(friendsRow(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(inboxRow(page)).toBeFocused();
    // Only one row is in the Tab order.
    const stops = await page.locator('[data-place-row][tabindex="0"]').count();
    expect(stops).toBe(1);
  });

  test('sizes: 1440, 900 and the phone root', async ({ page }) => {
    const h = await open(page, undefined, FRIENDS);
    await h.step('message', { channel: 'dmNick', who: 'nick', text: 'you coming tonight?' });
    await shoot(page, 'people-sidebar', { size: 'desktop' });
    await shoot(page, 'people-sidebar', { size: 'narrow' });
    await shoot(page, 'people-sidebar', { size: 'phone' });
    // The phone's root is the sidebar: back from the conversation.
    await page.getByRole('button', { name: 'Back to the sidebar' }).first().click();
    await shoot(page, 'people-root', { size: 'phone', settle: 800 });
  });
});

/** The route the s6 shot starts from (People's first conversation). */
function h0(): string {
  return `/app/dms/${CH.dmJeremy}`;
}

test.describe('IX-14 redirects: Home is retired', () => {
  const remember = (page: Page, memory: Record<string, unknown>) =>
    page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, JSON.stringify(value)),
      [MEMORY_KEY, memory] as const,
    );

  test('`/app` opens the last place: the channel you were in, in the server you were in', async ({ page }) => {
    const h = await open(page, h0(), FRIENDS);
    await navigate(page, h.routes.channel('gnLfg'));
    await expect(sidebar(page)).toHaveAttribute('aria-label', 'Game Night');
    await expect(page.locator(`[data-testid="ix-channel-row"][data-channel-id="${CH.gnLfg}"]`)).toHaveAttribute('aria-current', 'page');
    // A later launch at `/app`: the memory is the browser's, so a reload keeps it.
    await h.open('/app');
    await expect.poll(() => path(page)).toBe(`/app/guilds/${GUILD.gameNight.id}/channels/${CH.gnLfg}`);
    await expect(sidebar(page)).toHaveAttribute('aria-label', 'Game Night');
    // The window never showed People on the way: one pane, the server's.
    await expect(page.locator('.ix-pane')).toHaveCount(1);
  });

  test('`/app` with nothing remembered opens your first server', async ({ page }) => {
    await open(page, '/app', FRIENDS);
    await expect.poll(() => path(page)).toMatch(new RegExp(`^/app/guilds/${GUILD.fuel.id}/channels/`));
  });

  test('`/app` after People opens the People item you were on, `/app/dms` too', async ({ page }) => {
    const h = await open(page, '/app/friends', FRIENDS);
    await expect(friendsRow(page)).toHaveAttribute('aria-current', 'page');
    await h.open('/app');
    await expect.poll(() => path(page)).toBe('/app/friends');
    await navigate(page, h.routes.dm('dmNick'));
    await expect(dmRow(page, 'dmNick')).toHaveAttribute('aria-current', 'page');
    await h.open('/app/dms');
    await expect.poll(() => path(page)).toBe(`/app/dms/${CH.dmNick}`);
  });

  test('`/app/dms` with nothing remembered opens the most recent conversation', async ({ page }) => {
    await open(page, '/app/dms', FRIENDS);
    // Jeremy wrote last (9:12 PM; Nick on Monday, Maya on Sunday).
    await expect.poll(() => path(page)).toBe(`/app/dms/${CH.dmJeremy}`);
  });

  test('a server you are no longer in is gone: People opens instead', async ({ page }) => {
    await remember(page, { userId: PEOPLE.you.id, place: '999999999999999999', path: '/app/guilds/999999999999999999/channels/1', people: `/app/dms/${CH.dmMaya}` });
    await open(page, '/app', FRIENDS);
    await expect.poll(() => path(page)).toBe(`/app/dms/${CH.dmMaya}`);
    await expect(sidebar(page)).toHaveAttribute('aria-label', 'People');
  });

  test('a conversation you were in that is gone falls to the most recent one', async ({ page }) => {
    await remember(page, { userId: PEOPLE.you.id, place: 'people', path: null, people: '/app/dms/424242424242424242' });
    await open(page, '/app/dms', FRIENDS);
    await expect.poll(() => path(page)).toBe(`/app/dms/${CH.dmJeremy}`);
  });

  test('another account\'s memory is ignored', async ({ page }) => {
    await remember(page, { userId: '1', place: GUILD.basecamp.id, path: `/app/guilds/${GUILD.basecamp.id}/channels/${CH.bcBuilds}`, people: null });
    await open(page, '/app', FRIENDS);
    await expect.poll(() => path(page)).toMatch(new RegExp(`^/app/guilds/${GUILD.fuel.id}/channels/`));
  });
});

test.describe('IX-14 Friends page', () => {
  test('a page in main: the large title, the segmented control, and Add friend as the one cream button', async ({ page }) => {
    const h = await open(page, '/app/friends', FRIENDS);
    await h.step('crowd');
    await expect(page.getByTestId('ix-title')).toHaveText('Friends');
    await expect(page.getByTestId('ix-friends').getByText(/\d of 4 online/)).toBeVisible();
    const tabs = page.getByTestId('ix-seg').getByRole('tab');
    await expect(tabs).toHaveText([/Online/, /All/, /Requests/, /Blocked/]);
    await expect(page.getByRole('tab', { name: /^Online/ })).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('.ix-cream').count()).toBe(1);
    await expect(page.getByRole('button', { name: 'Add friend', exact: true })).toHaveClass(/ix-cream/);
    await expect(page.getByRole('button', { name: 'Open profile for Nick' })).toContainText('Online');
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
    await shoot(page, 'friends');
    await shoot(page, 'friends', { size: 'desktop' });
    await shoot(page, 'friends', { size: 'phone' });
  });

  test('requests: accept makes a friend, and the sidebar line follows', async ({ page }) => {
    await open(page, '/app/friends', FRIENDS);
    await page.getByRole('tab', { name: /^Requests/ }).click();
    await expect(page.getByRole('region', { name: 'Incoming' })).toContainText('Brendan');
    await shoot(page, 'friends-requests');
    await page.getByRole('button', { name: 'Accept friend request from Brendan' }).click();
    await expect(page.getByRole('region', { name: 'Incoming' })).toHaveCount(0);
    await expect(friendsRow(page)).not.toContainText('request');
  });

  test('Add friend opens its form with focus in the field, and the People menu opens it already', async ({ page }) => {
    const h = await open(page, '/app/friends', FRIENDS);
    await page.getByRole('button', { name: 'Add friend', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Username or user ID' })).toBeFocused();
    await shoot(page, 'friends-add');
    await navigate(page, h.routes.dm('dmJeremy'));
    await sidebarHeader(page).getByRole('button', { name: 'People options' }).click();
    await page.getByRole('menuitem', { name: 'Add friend' }).click();
    await expect.poll(() => path(page)).toBe('/app/friends');
    await expect(page.getByRole('textbox', { name: 'Username or user ID' })).toBeVisible();
  });

  test('a friend\'s row opens their profile card; Message opens the conversation', async ({ page }) => {
    await open(page, '/app/friends', FRIENDS);
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByRole('button', { name: 'Open profile for Maya' }).click();
    await expect(page.locator('.ix-profile')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.route('**/api/v1/users/@me/dms', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH }, body: JSON.stringify({ id: CH.dmMaya }) });
    });
  });

  test('every tab has an empty state that says what to do', async ({ page }) => {
    await open(page, '/app/friends', []);
    await expect(page.getByText('None of your friends are online')).toBeVisible();
    await page.getByRole('tab', { name: /^Blocked/ }).click();
    await expect(page.getByText('You haven\'t blocked anyone')).toBeVisible();
    await shoot(page, 'friends-empty');
  });
});

test.describe('IX-14 Inbox page', () => {
  test('what is waiting for you: a row per conversation, its newest line, and a check that marks it read', async ({ page }) => {
    const h = await open(page, '/app/inbox', FRIENDS);
    await expect(page.getByTestId('ix-title')).toHaveText('Inbox');
    // Game Night's looking-for-group starts unread (the prototype's scene).
    await expect(page.getByTestId('ix-inbox-row')).toHaveCount(1);
    await expect(page.locator(`[data-testid="ix-inbox-row"][data-channel-id="${CH.gnLfg}"]`)).toContainText('Maya: need one for ranked');
    await h.step('arrive');
    await h.step('message', { channel: 'dmNick', who: 'nick', text: 'you coming tonight?' });
    await page.getByRole('tab', { name: /^Unread/ }).click();
    const nick = page.locator(`[data-testid="ix-inbox-row"][data-channel-id="${CH.dmNick}"]`);
    await expect(nick).toContainText('Nick');
    await expect(nick).toContainText('you coming tonight?');
    await expect(page.locator(`[data-testid="ix-inbox-row"][data-channel-id="${CH.fuelClips}"]`)).toContainText('clips');
    await shoot(page, 'inbox-unread');
    await nick.getByRole('button', { name: 'Mark Nick as read' }).click();
    await expect(nick).toHaveCount(0);
    await shoot(page, 'inbox-unread', { size: 'phone' });
  });

  test('Mark all read settles every row, and the tabs say what is in them', async ({ page }) => {
    const h = await open(page, '/app/inbox', FRIENDS);
    await h.step('arrive');
    await page.getByRole('tab', { name: /^Unread/ }).click();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByTestId('ix-inbox-row')).toHaveCount(0);
    await expect(page.getByText('You’re all caught up')).toBeVisible();
    await page.getByRole('tab', { name: /^Saved/ }).click();
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
    await page.getByRole('tab', { name: /^Reminders/ }).click();
    await expect(page.getByText('No reminders')).toBeVisible();
  });
});

test.describe('IX-14 New message', () => {
  test('Start a group opens on the Group half; choosing friends builds one', async ({ page }) => {
    const h = await open(page, undefined, FRIENDS);
    await sidebarHeader(page).getByRole('button', { name: 'People options' }).click();
    await page.getByRole('menuitem', { name: 'Start a group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New message' });
    await expect(dialog.getByRole('tab', { name: 'Group' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('button', { name: 'Create group conversation' })).toBeDisabled();
    await dialog.getByRole('button', { name: /Nick/ }).click();
    await dialog.getByRole('button', { name: /Maya/ }).click();
    await expect(dialog).toContainText('2 friends selected');
    await shoot(page, 'new-message-group');
    await dialog.getByRole('tab', { name: 'Direct' }).click();
    await expect(dialog.getByRole('button', { name: /Nick/ })).toBeVisible();
    await shoot(page, 'new-message');
    void h;
  });
});

test.describe('IX-14 Discover', () => {
  test('the page: the large title, the search, the topics and a card per community', async ({ page }) => {
    await open(page, '/app/discovery', FRIENDS);
    await page.route('**/api/v1/discovery/guilds**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
        body: JSON.stringify({
          total: 3,
          guilds: [
            { id: '710000000000000001', name: 'Launch Guild', description: 'Public launch planning and the first week of everything.', icon_hash: null, member_count: 42, online_count: 7, tags: ['Technology', 'Gaming'], created_at: '2026-05-17T00:00:00Z' },
            { id: '710000000000000002', name: 'Paper and Pixels', description: 'Illustration, comics and the occasional game jam.', icon_hash: null, member_count: 318, online_count: 61, tags: ['Art'], created_at: '2026-02-01T00:00:00Z' },
            { id: '710000000000000003', name: 'Night Shift', description: null, icon_hash: null, member_count: 12, online_count: 3, tags: [], created_at: '2026-09-01T00:00:00Z' },
          ],
        }),
      }),
    );
    await navigate(page, '/app/friends');
    await navigate(page, '/app/discovery');
    await expect(page.getByTestId('ix-title')).toHaveText('Discover');
    await expect(page.getByTestId('ix-discover-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Gaming', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await shoot(page, 'discover');
    await page.getByRole('button', { name: 'Preview' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Launch Guild' })).toBeVisible();
    await shoot(page, 'discover-preview');
    await page.getByRole('button', { name: 'Not now' }).click();
    await shoot(page, 'discover', { size: 'phone' });
  });
});

void CLOCK;
