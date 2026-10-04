import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  CH,
  GUILD,
  PEOPLE,
  installIndexScene,
  shoot,
  sidebar,
  toolbar,
  type IndexHarness,
} from './fixtures/index';
import { HISTORY_EPOCH } from './fixtures/index/world';

/**
 * IX-9 (Sheets, menus, quick switcher): the sheet frame in main, the people,
 * channel, search and reminders sheets, the server, channel, People and account
 * menus, the quick switcher, the Help dialog and the profile card
 * (docs/index-spec.md §4.2, §6.1-6.5, §6.9; docs/design/index-plan.md §3 IX-9).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-sheets PARACORD_E2E_INDEX_PORT=4573 \
 *   PARACORD_E2E_INDEX_RT_PORT=4575 PARACORD_E2E_INDEX_WP=ix9 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * The menus are opened the way their callers will (IX-5's header, IX-6's dock,
 * IX-14's People header, IX-15's title): through the opener functions in
 * `components/ix/menus`, imported into the page from the dev server. The shots
 * land in output/design-reference/index-build/ix9/ (1280x800 unless the name
 * says otherwise) and are read, not diffed: the prototype has no sheet or menu.
 */

const SETTLE_MS = 600;
const MENUS = '/src/components/ix/menus/index.ts';
const SHEETS = '/src/components/glass/sheets/index.ts';

/** An uncaught error in the page fails the test that caused it. */
const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

async function open(page: Page, route?: string, viewport = { width: 1280, height: 800 }): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && process.env.PARACORD_E2E_INDEX_LOG) console.log('console.error:', message.text());
  });
  await page.setViewportSize(viewport);
  const h = await installIndexScene(page);
  await answerExtras(page, h);
  await h.open(route ?? h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
    body: JSON.stringify(body),
  });

/** Answer what the sheets ask that the scene does not: roles, pins, a message search, a profile, reminders. */
async function answerExtras(page: Page, h: IndexHarness): Promise<void> {
  const role = (guildId: string, id: string, name: string, hoist: boolean, position: number, permissions: string) => ({
    id,
    guild_id: guildId,
    name,
    color: 0,
    hoist,
    position,
    permissions,
    mentionable: false,
    created_at: '2026-08-14T19:00:00-05:00',
  });
  for (const guild of [GUILD.fuel, GUILD.gameNight, GUILD.basecamp]) {
    await page.route(`**/api/v1/guilds/${guild.id}/roles`, (route) =>
      json(route, [
        role(guild.id, guild.id, '@everyone', false, 0, '1'),
        role(guild.id, `${guild.id}-mods`, 'Moderators', true, 2, '32'),
      ]),
    );
  }
  // Game Night: Ari (offline) is a moderator, so the role gets its own section.
  await page.route(`**/api/v1/guilds/${GUILD.gameNight.id}/members`, (route) =>
    json(
      route,
      h.world.memberRecords('gameNight').map((member: { user: { username: string }; roles: string[] }) =>
        member.user.username === 'ari' ? { ...member, roles: [`${GUILD.gameNight.id}-mods`] } : member,
      ),
    ),
  );
  await page.route(`**/api/v1/channels/${CH.gnLounge}/pins`, (route) =>
    json(
      route,
      h.world.messagesIn('gnLounge').slice(0, 2).map((message: never) => ({ ...h.world.messageRecord(message), pinned: true })),
    ),
  );
  await page.route(`**/api/v1/guilds/${GUILD.gameNight.id}/messages/search**`, (route) => {
    const messages = h.world.messagesIn('gnLounge').slice(0, 3);
    return json(route, {
      total: messages.length,
      messages: messages.map((message: never) => ({
        message: h.world.messageRecord(message),
        channel_id: CH.gnLounge,
        channel_name: 'lounge',
      })),
    });
  });
  // The leaderboard page (the channel sheet's): a ranking and your own progress.
  await page.route(`**/api/v1/guilds/${GUILD.gameNight.id}/economy/leaderboard**`, (route) =>
    json(route, {
      guild_id: GUILD.gameNight.id,
      limit: 8,
      window: 'all_time',
      entries: (['vincent', 'brendan', 'nick', 'maya'] as const).map((who, index) => ({
        rank: index + 1,
        user: { id: PEOPLE[who].id, username: PEOPLE[who].username, display_name: PEOPLE[who].display_name, discriminator: 1 },
        xp: 1800 - index * 410,
        level: 8 - index,
        streak_days: 12 - index * 3,
        last_xp_at: '2026-10-01T20:00:00-05:00',
      })),
    }),
  );
  await page.route(`**/api/v1/guilds/${GUILD.gameNight.id}/economy/me`, (route) =>
    json(route, {
      guild_id: GUILD.gameNight.id,
      user_id: PEOPLE.you.id,
      xp: 420,
      level: 3,
      rank: 5,
      progress: { current_level_floor: 300, next_level_at: 600, xp_into_level: 120, xp_required_this_level: 300 },
      streak: { days: 3, longest_days: 5 },
      achievements: [],
    }),
  );
  // Two reminders: one due (it fired), one upcoming.
  await page.route('**/api/v1/users/@me/reminders', (route) => {
    const [first, second] = h.world.messagesIn('gnLounge');
    const channel = { id: CH.gnLounge, guild_id: GUILD.gameNight.id, name: 'lounge' };
    return json(route, {
      items: [
        {
          id: '7001',
          remind_at: '2026-10-01T21:30:00-05:00',
          created_at: '2026-10-01T20:00:00-05:00',
          fired_at: '2026-10-01T21:30:00-05:00',
          channel,
          message: h.world.messageRecord(first as never),
          preview: null,
        },
        {
          id: '7002',
          remind_at: '2026-10-02T09:00:00-05:00',
          created_at: '2026-10-01T20:10:00-05:00',
          fired_at: null,
          channel,
          message: h.world.messageRecord(second as never),
          preview: null,
        },
      ],
    });
  });
}

type Anchor = { x: number; y: number } | { selector: string; align?: 'start' | 'end'; fallback: { x: number; y: number } };

/** Open a menu the way its caller will: the opener function from `components/ix/menus`, in the page. */
const openers = {
  async server(page: Page, guildId: string): Promise<void> {
    await page.evaluate(async ([url, id]) => {
      const m = await import(/* @vite-ignore */ url);
      const guild = window.__ixProbe!.guilds.getState().guilds.find((g) => (g as { id: string }).id === id) as {
        id: string;
        name: string;
        scope: unknown;
      };
      // IX-5's header: the "..." button at its right edge.
      const element = document.querySelector<HTMLElement>('[data-testid="ix-sidebar-header"] [aria-haspopup="menu"]');
      m.openServerMenu(
        { guildId: guild.id, scope: guild.scope, name: guild.name },
        element ? { element, align: 'end' } : { x: 280, y: 60 },
      );
    }, [MENUS, guildId] as const);
  },
  async channelMenu(page: Page, at: { x: number; y: number }, guild: string, channel: string): Promise<void> {
    await page.evaluate(async ([url, point, g, c]) => {
      const m = await import(/* @vite-ignore */ url);
      m.openChannelMenu(
        { subject: { kind: 'channel', guildId: g, channelId: c, channelName: 'lounge' }, summary: { allowed: true, reason: null } },
        point,
      );
    }, [MENUS, at, guild, channel] as const);
  },
  async peopleMenu(page: Page, at: { x: number; y: number }): Promise<void> {
    await page.evaluate(async ([url, point]) => {
      const m = await import(/* @vite-ignore */ url);
      m.openPeopleMenu(point);
    }, [MENUS, at] as const);
  },
  async profile(page: Page, id: string, at: { x: number; y: number }): Promise<void> {
    await page.evaluate(async ([url, userId, point]) => {
      const m = await import(/* @vite-ignore */ url);
      m.openProfileCard(
        {
          id: userId,
          username: 'vincent',
          display_name: 'Vincent',
          discriminator: 1,
          bot: false,
          system: false,
          flags: 0,
          created_at: '2026-01-01T00:00:00-05:00',
          bio: 'Streams on Thursdays. Always bring the good guns.',
          pronouns: 'he/him',
        },
        point,
      );
    }, [MENUS, id, at] as const);
  },
  async channelSheet(page: Page, pageName: string): Promise<void> {
    await page.evaluate(async ([url, name]) => {
      const m = await import(/* @vite-ignore */ url);
      m.openChannelSheet(name);
    }, [SHEETS, pageName] as const);
  },
};
void (null as unknown as Anchor);

const search = (page: Page) => toolbar(page).getByRole('button', { name: 'Search messages' });
const members = (page: Page) => toolbar(page).getByRole('button', { name: 'Members' });
const me = (page: Page) => toolbar(page).getByRole('button', { name: 'Your account' });
const sheet = (page: Page) => page.locator('.ix-sheet');
const menu = (page: Page, name?: string | RegExp) => (name ? page.getByRole('menu', { name }) : page.locator('.ix-menu'));
const switcher = (page: Page) => page.getByTestId('ix-switcher');

const rectOf = (locator: Locator) =>
  locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });

test.describe('sheets', () => {
  test('the people sheet: here now, then by role, with the room line', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await members(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(sheet(page).getByRole('region', { name: 'Moderators' })).toBeVisible();
    await expect(sheet(page).getByRole('region', { name: 'Here now' })).toBeVisible();
    await expect(sheet(page).getByText('In Lounge').first()).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-people');
    // The frame: inset 10 inside main, 400 wide, radius 24, opaque enough to read on.
    const box = await rectOf(sheet(page));
    expect(box.width).toBe(400);
    expect(Math.round(box.y)).toBe(10);
    expect(Math.round(1280 - box.right)).toBe(10);
    expect(await sheet(page).evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe('24px');
    // Escape closes it and focus returns to the control that opened it.
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(members(page)).toBeFocused();
  });

  test('the people sheet at 1440x900 and on a phone', async ({ page }) => {
    const h = await open(page, undefined, { width: 1440, height: 900 });
    await h.open(h.routes.channel('gnLounge'));
    await members(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-people', { size: 'desktop' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: `${process.cwd()}/../output/design-reference/index-build/ix9/sheet-people@390x844.png` });
    // On a phone the sheet is the whole screen.
    const box = await rectOf(sheet(page));
    expect(box.width).toBe(390);
  });

  test('at 900x700 main is under 760px, so the sheet takes main\'s full inset', async ({ page }) => {
    const h = await open(page, undefined, { width: 900, height: 700 });
    await h.open(h.routes.channel('gnLounge'));
    await members(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-people', { size: 'narrow' });
    const box = await rectOf(sheet(page));
    // The sidebar is 280 at this width: the sheet spans main (280 + 10 to 900 - 10).
    expect(Math.round(box.x)).toBe(290);
    expect(Math.round(900 - box.right)).toBe(10);
  });

  test('the channel sheet: a segmented control moves between its pages', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await openers.channelSheet(page, 'pins');
    await expect(sheet(page)).toBeVisible();
    const tabs = sheet(page).getByRole('tablist', { name: 'Channel pages' });
    await expect(tabs.getByRole('tab', { name: 'Pins' })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-channel-pins');
    await tabs.getByRole('tab', { name: 'Notifications' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-channel-notifications');
    // Arrow keys move through the segments and select as they go.
    await tabs.getByRole('tab', { name: 'Notifications' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.getByRole('tab', { name: 'Leaderboard' })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-channel-leaderboard');
    await tabs.getByRole('tab', { name: 'Threads' }).click();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-channel-threads');
  });

  test('the message search sheet is 480 wide and carries words from the switcher', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await search(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-search-empty');
    expect((await rectOf(sheet(page))).width).toBe(480);
    await page.getByRole('combobox', { name: 'Search messages' }).fill('guns');
    await expect(sheet(page).getByText(/results?/).first()).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-search-results');
  });

  test('reminders is a sheet from the account menu', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await me(page).click();
    await menu(page, 'Account').getByRole('menuitem', { name: 'Reminders' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Reminders' })).toBeVisible();
    await expect(menu(page, 'Account')).toHaveCount(0);
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'sheet-reminders');
  });
});

test.describe('menus', () => {
  test('the account menu hangs from the toolbar avatar', async ({ page }) => {
    await open(page);
    await me(page).click();
    const account = menu(page, 'Account');
    await expect(account).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'menu-account');
    const avatar = await rectOf(me(page));
    const box = await rectOf(account);
    // The menu's right edge lines up with the avatar's and it sits just under it.
    expect(Math.abs(box.right - avatar.right)).toBeLessThanOrEqual(2);
    expect(box.y).toBeGreaterThan(avatar.bottom);
    expect(box.y - avatar.bottom).toBeLessThan(12);
    expect(box.width).toBe(280);
    await page.keyboard.press('Escape');
    await expect(account).toHaveCount(0);
    await expect(me(page)).toBeFocused();
  });

  test('the server menu: every row for an owner, the notification levels expand in place', async ({ page }) => {
    await open(page);
    await openers.server(page, GUILD.fuel.id);
    const server = menu(page, 'Fuel menu');
    await expect(server).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'menu-server');
    for (const name of ['Overview', 'Events', 'Mark as read', 'Mute server', 'Copy link']) {
      await expect(server.getByRole('menuitem', { name })).toBeVisible();
    }
    await server.getByRole('menuitem', { name: /^Notifications/ }).click();
    await expect(server.getByRole('menuitemradio', { name: 'All messages' })).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'menu-server-notifications');
    // Escape closes it, and only it.
    await page.keyboard.press('Escape');
    await expect(server).toHaveCount(0);
  });

  test('the server menu opens the Create channel dialog', async ({ page }) => {
    await open(page);
    await openers.server(page, GUILD.fuel.id);
    await menu(page, 'Fuel menu').getByRole('menuitem', { name: 'Create channel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create channel' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'dialog-create-channel');
  });

  test('the channel menu: pages, Edit channel and Copy link', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await openers.channelMenu(page, { x: 440, y: 130 }, GUILD.gameNight.id, CH.gnLounge);
    const channel = menu(page, 'Channel actions');
    await expect(channel).toBeVisible();
    for (const name of ['Catch up summary', 'Pinned messages', 'Threads', 'Media', 'Leaderboard', 'Notifications', 'Copy link']) {
      await expect(channel.getByRole('menuitem', { name })).toBeVisible();
    }
    await expect(channel.getByRole('menuitem', { name: 'Follows' })).toHaveCount(0);
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'menu-channel');
    await channel.getByRole('menuitem', { name: 'Pinned messages' }).click();
    await expect(sheet(page).getByRole('tab', { name: 'Pins' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the People menu', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.dm('dmJeremy'));
    await openers.peopleMenu(page, { x: 290, y: 60 });
    const people = menu(page, 'People menu');
    await expect(people).toBeVisible();
    await expect(people.getByRole('menuitem', { name: 'New message' })).toBeVisible();
    await expect(people.getByRole('menuitem', { name: 'Start a group' })).toBeVisible();
    await expect(people.getByRole('menuitem', { name: 'Add friend' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'menu-people');
  });

  test('Help is a dialog, from the account menu and Ctrl /', async ({ page }) => {
    await open(page);
    await me(page).click();
    await menu(page, 'Account').getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'dialog-help');
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
    await page.keyboard.press('Control+/');
    await expect(help).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(help).toHaveCount(0);
  });

  test('the profile card', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await openers.profile(page, PEOPLE.vincent.id, { x: 600, y: 140 });
    const card = page.getByRole('dialog', { name: /Vincent, profile/ });
    await expect(card).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'card-profile');
    await expect(card.getByRole('button', { name: 'Message' })).toBeVisible();
    await card.getByRole('button', { name: 'More actions' }).click();
    await expect(menu(page, /actions/).getByRole('menuitem', { name: 'Block' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'card-profile-menu');
  });
});

test.describe('Reduced transparency and High contrast', () => {
  test('menus, sheets and the switcher go opaque, and the hairlines and inks harden', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await page.evaluate(() => {
      document.documentElement.dataset.reducedTransparency = 'true';
      document.documentElement.dataset.theme = 'glass-contrast';
    });
    await members(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    const alpha = (selector: string) =>
      page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor);
    // Opaque: rgb(...), not rgba(..., .98).
    expect(await alpha('.ix-sheet')).toMatch(/^rgb\(/);
    await shoot(page, 'sheet-people-contrast');
    await page.keyboard.press('Escape');
    await me(page).click();
    await expect(menu(page, 'Account')).toBeVisible();
    expect(await alpha('.ix-menu')).toMatch(/^rgb\(/);
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'menu-account-contrast');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await expect(switcher(page)).toBeVisible();
    expect(await alpha('.ix-switcher')).toMatch(/^rgb\(/);
  });
});

test.describe('the quick switcher', () => {
  test('is scoped to the server first, and its last row searches messages', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await page.keyboard.press('Control+k');
    await expect(switcher(page)).toBeVisible();
    await expect(switcher(page).getByRole('combobox')).toBeFocused();
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'switcher-empty');
    // Channels, then rooms, then the other servers, then direct messages; the search row last.
    const groups = await switcher(page).getByRole('group').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    expect(groups).toEqual(['Channels', 'Voice channels', 'Servers', 'Direct messages']);
    const rows = switcher(page).getByRole('option');
    await expect(rows.last()).toContainText('Search messages in Game Night');
    // The panel sits over the sidebar's search field and is 420 wide.
    const box = await rectOf(switcher(page));
    expect(box.width).toBe(420);
    expect(box.x).toBeLessThan(40);
    await switcher(page).getByRole('combobox').fill('guns');
    await expect(rows.last()).toContainText('for “guns”');
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'switcher-typed');
    // Enter on the last row opens the search sheet with the words carried over.
    await page.keyboard.press('End');
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search messages' })).toHaveValue(/guns/);
  });

  test('finds people and channels in other servers by typing, and commands after places', async ({ page }) => {
    const h = await open(page, undefined);
    await h.open(h.routes.channel('gnLounge'));
    await page.keyboard.press('Control+k');
    await switcher(page).getByRole('combobox').fill('n');
    await page.waitForTimeout(SETTLE_MS);
    await shoot(page, 'switcher-people');
    const groups = await switcher(page).getByRole('group').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    const order = ['Channels', 'Voice channels', 'People', 'Servers', 'Direct messages', 'In other servers', 'Commands'];
    expect(groups).toEqual(order.filter((label) => groups.includes(label)));
    await page.keyboard.press('Escape');
    await expect(switcher(page)).toHaveCount(0);
  });

  test('is a full-screen page on a phone', async ({ page }) => {
    const h = await open(page, undefined, { width: 390, height: 844 });
    await h.open(h.routes.channel('gnLounge'));
    await page.keyboard.press('Control+k');
    await expect(switcher(page)).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    const box = await rectOf(switcher(page));
    expect(box.width).toBe(390);
    expect(box.height).toBe(844);
    await shoot(page, 'switcher-phone', { size: 'phone' });
  });
});
