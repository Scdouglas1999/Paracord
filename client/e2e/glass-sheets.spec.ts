import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { CAST, CH, GAME_NIGHT_ID, userRecord, type CastKey } from './fixtures/glass/scene';

/**
 * WP-G18 (sheets and menus): every sheet and menu on the Glass reference scene,
 * at 1440x900 and 390x844, mocked like glass-review.spec.ts (no server). Each
 * test drives the app the way a person does (the header buttons, the channel
 * menu, the account menu) and also asserts what a screenshot cannot: Escape
 * closes, focus goes in and comes back, Tab stays inside.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g18 npx playwright test -c e2e/glass-sheets.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/<surface>-{desktop,phone}.png
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g18';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;
type Size = keyof typeof SIZES;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const THREAD_ID = '2901';
const ARCHIVED_THREAD_ID = '2902';

const at = (time: string) => `2026-10-01T${time}:00-05:00`;

function message(id: string, channel: string, who: CastKey, content: string, when: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    channel_id: channel,
    author: userRecord(CAST[who]),
    content,
    created_at: when,
    timestamp: when,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
    ...extra,
  };
}

const PINS = [
  message('9001', CH.general, 'brendan', 'Haz 5 runs from 9. Bring snacks and a spare controller if you have one.', at('20:41'), { pinned: true }),
  message('9002', CH.general, 'vincent', 'House rules: no spoilers for the story missions until Sunday, keep the Lounge clear when someone is streaming.', at('19:02'), { pinned: true }),
  message('9003', CH.general, 'jeremy', '', at('18:20'), {
    pinned: true,
    attachments: [{ id: '8001', filename: 'route-notes.pdf', size: 84_000, content_type: 'application/pdf', url: '/attachments/8001' }],
  }),
];

const HITS = [
  {
    channel_id: CH.general,
    channel_name: 'General',
    message: message('9101', CH.general, 'jeremy', '@Sean is movie night still on? I can bring the projector if we do it Friday.', at('20:58')),
  },
  {
    channel_id: CH.general,
    channel_name: 'General',
    message: message('9102', CH.general, 'luke', 'Movie night picks are in the thread, vote before Thursday.', at('20:12')),
  },
  {
    channel_id: CH.lfg,
    channel_name: 'LFG',
    message: message('9103', CH.lfg, 'nick', 'Anyone up for a movie night themed run? Same crew as last week.', '2026-09-29T22:05:00-05:00'),
  },
];

const thread = (id: string, name: string, archived: boolean, count: number, created: string) => ({
  id,
  guild_id: GAME_NIGHT_ID,
  name,
  type: 6,
  channel_type: 6,
  position: 0,
  nsfw: false,
  parent_id: CH.general,
  owner_id: CAST.jeremy.id,
  required_role_ids: [],
  last_message_id: null,
  message_count: count,
  thread_metadata: { archived, auto_archive_duration: 1440, locked: false },
  created_at: created,
});

const THREADS = [
  thread(THREAD_ID, 'Movie night picks', false, 14, at('19:30')),
  thread('2903', 'Patch 1.4 feedback', false, 9, '2026-09-30T16:00:00-05:00'),
  thread(ARCHIVED_THREAD_ID, 'Haz 4 recap', true, 31, '2026-09-24T21:00:00-05:00'),
];

const gallery = (id: string, name: string, who: CastKey, kind: 'image' | 'file', type: string, size: number) => ({
  id,
  message_id: `m${id}`,
  channel_id: CH.general,
  filename: name,
  content_type: type,
  size,
  url: `/attachments/${id}`,
  width: kind === 'image' ? 1280 : null,
  height: kind === 'image' ? 720 : null,
  kind,
  created_at: at('20:00'),
  author: { id: CAST[who].id, username: CAST[who].username, display_name: CAST[who].display_name, avatar_hash: null },
});

const MEDIA = [
  gallery('7001', 'mission-41-07.png', 'nick', 'image', 'image/png', 412_000),
  gallery('7002', 'ridge.png', 'luke', 'image', 'image/png', 388_000),
  gallery('7003', 'route-notes.pdf', 'jeremy', 'file', 'application/pdf', 84_000),
];

async function shoot(page: Page, name: string, size: Size) {
  const view = page.viewportSize();
  if (view) await page.mouse.move(view.width - 3, view.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-${size}.png`), fullPage: false });
}

/**
 * Call into one of the app's own stores by module URL: the same instance the
 * running page holds, because the dev server serves each module at one URL.
 */
async function callStore(page: Page, module: string, hook: string, method: string, ...args: unknown[]) {
  await page.evaluate(
    async ({ module, hook, method, args }) => {
      const mod = (await import(/* @vite-ignore */ module)) as Record<string, any>;
      void mod[hook].getState()[method](...args);
    },
    { module, hook, method, args },
  );
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

/** The mocked scene plus what only sheets read: pins, threads, the gallery, search, reminders, standings. */
async function open(page: Page, size: Size, route = general) {
  test.setTimeout(90_000);
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page);

  // A few people with something to say: an activity, a custom status, someone away.
  await page.addInitScript(
    (frames) => {
      const w = window as unknown as { __pcStream?: { once: unknown[] } };
      w.__pcStream?.once.push(...frames);
    },
    [
      { op: 0, t: 'PRESENCE_UPDATE', d: { user_id: CAST.vincent.id, guild_id: GAME_NIGHT_ID, status: 'online', activities: [{ name: 'Deep Cave', type: 0, details: null }] } },
      { op: 0, t: 'PRESENCE_UPDATE', d: { user_id: CAST.jeremy.id, guild_id: GAME_NIGHT_ID, status: 'idle', activities: [], custom_status: 'Back in ten' } },
      { op: 0, t: 'PRESENCE_UPDATE', d: { user_id: CAST.luke.id, guild_id: GAME_NIGHT_ID, status: 'dnd', activities: [{ name: 'Spotify', type: 2, details: 'Windowlicker', state: 'Aphex Twin' }] } },
    ],
  );

  const json = (route: import('@playwright/test').Route, payload: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // The messaging runtime checks the history epoch on every message response.
      headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      body: JSON.stringify(payload),
    });

  await page.route(`**/api/v1/channels/${CH.general}/pins`, (route) => json(route, PINS));
  await page.route(`**/api/v1/channels/${CH.general}/threads`, (route) => json(route, THREADS.filter((t) => !t.thread_metadata.archived)));
  await page.route(`**/api/v1/channels/${CH.general}/threads/archived`, (route) => json(route, THREADS.filter((t) => t.thread_metadata.archived)));
  await page.route(`**/api/v1/channels/${THREAD_ID}`, (route) => json(route, THREADS[0]));
  const threadMessages = [
    message('9203', THREAD_ID, 'sean', 'Friday works for me. I will bring the projector.', at('19:52')),
    message('9202', THREAD_ID, 'luke', 'Vote is 4 to 2 for the space one.', at('19:44')),
    message('9201', THREAD_ID, 'jeremy', 'Movie night picks. Reply with one, we vote Thursday.', at('19:30')),
  ];
  await page.route(`**/api/v1/channels/${THREAD_ID}/messages**`, (route) => json(route, threadMessages));
  // The durable-delivery runtime surfaces a message once the recovery feed confirms it.
  await page.route(`**/api/v1/channels/${THREAD_ID}/messages/recovery**`, (route) => {
    const after = new URL(route.request().url()).searchParams.get('after') ?? '0';
    const known = (new URL(route.request().url()).searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
    return json(route, {
      database_history_epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel_id: THREAD_ID,
      after,
      through: after,
      floor: '0',
      next: after,
      complete: true,
      projection_head: after,
      changes: [],
      states: known.map((id) => ({
        message_id: id,
        state: 'present',
        revision: after,
        message: { ...threadMessages.find((m) => m.id === id), message_revision: after },
      })),
    });
  });
  await page.route(`**/api/v1/channels/${THREAD_ID}/capabilities`, (route) =>
    json(route, {
      version: 1,
      channel_id: THREAD_ID,
      user_id: CAST.sean.id,
      encrypted: false,
      own_identity_enrolled: false,
      peers_ready: true,
      actions: Object.fromEntries(
        ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => [
          action,
          { supported: true, allowed: true, reason: null },
        ]),
      ),
    }),
  );
  await page.route(`**/api/v1/channels/${CH.general}/attachments**`, (route) =>
    json(route, { items: MEDIA.filter((m) => new URL(route.request().url()).searchParams.get('kind')?.includes(m.kind) ?? true), next_before: null }),
  );
  // The gallery's tiles are real pictures: serve the scene's own.
  const here = path.dirname(new URL(import.meta.url).pathname);
  for (const [id, file] of [['7001', 'mission-41-07.png'], ['7002', 'photo-ridge.png']] as const) {
    await page.route(`**/attachments/${id}**`, async (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(path.join(here, 'fixtures', 'glass', file)) }),
    );
  }
  await page.route(`**/api/v1/channels/${CH.general}/links**`, (route) => json(route, { items: [], next_before: null }));
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/messages/search**`, (route) =>
    json(route, { total: HITS.length, messages: HITS }),
  );
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/economy/leaderboard**`, (route) =>
    json(route, {
      guild_id: GAME_NIGHT_ID,
      limit: 8,
      entries: [
        { rank: 1, user: userRecord(CAST.vincent), xp: 4820, level: 12, streak_days: 21, last_xp_at: at('21:00') },
        { rank: 2, user: userRecord(CAST.brendan), xp: 3990, level: 10, streak_days: 9, last_xp_at: at('21:00') },
        { rank: 3, user: userRecord(CAST.sean), xp: 2410, level: 8, streak_days: 5, last_xp_at: at('21:00') },
        { rank: 4, user: userRecord(CAST.jeremy), xp: 1560, level: 6, streak_days: 2, last_xp_at: at('21:00') },
      ],
    }),
  );
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/economy/me`, (route) =>
    json(route, {
      guild_id: GAME_NIGHT_ID,
      user_id: CAST.sean.id,
      xp: 2410,
      level: 8,
      rank: 3,
      progress: { current_level_floor: 2200, next_level_at: 2800, xp_into_level: 210, xp_required_this_level: 600 },
      streak: { days: 5, longest_days: 12 },
      achievements: [{ key: 'first_message', awarded_at: at('12:00') }, { key: 'night_owl', awarded_at: at('12:00') }],
    }),
  );
  await page.route('**/api/v1/users/@me/reminders', (route) =>
    json(route, {
      items: [
        {
          id: 'r1',
          remind_at: at('20:30'),
          created_at: at('18:00'),
          fired_at: at('20:30'),
          channel: { id: CH.general, name: 'General', guild_id: GAME_NIGHT_ID },
          message: message('9301', CH.general, 'brendan', 'Haz 5 runs from 9. Bring snacks.', at('17:58')),
          preview: 'Haz 5 runs from 9. Bring snacks.',
        },
        {
          id: 'r2',
          remind_at: '2026-10-02T09:00:00-05:00',
          created_at: at('18:10'),
          fired_at: null,
          channel: { id: CH.general, name: 'General', guild_id: GAME_NIGHT_ID },
          message: message('9302', CH.general, 'jeremy', 'Movie night is Friday, projector is on me.', at('17:59')),
          preview: 'Movie night is Friday, projector is on me.',
        },
      ],
    }),
  );
  await page.route(`**/api/v1/channels/${CH.general}/summary**`, (route) =>
    json(route, {
      summary: 'Tonight is Haz 5 at 9:30 in the Lounge. Jeremy is bringing the projector for Friday movie night, and Nick posted a 41:07 finish.',
      provider: 'local',
      model: 'summary-1',
      message_count: 31,
    }),
  );

  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForTimeout(500);
}

const dialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });

for (const size of ['desktop', 'phone'] as const) {
  test(`search sheet at ${size}`, async ({ page }) => {
    await open(page, size);
    const trigger = page.getByRole('button', { name: 'Search messages' });
    await trigger.click();
    const sheet = dialog(page, 'Search messages');
    await expect(sheet).toBeVisible();
    // Focus is in the field, not on the trigger under the sheet.
    await expect(page.getByRole('combobox', { name: 'Search messages' })).toBeFocused();
    await shoot(page, 'search-empty', size);

    await page.getByRole('combobox', { name: 'Search messages' }).fill('movie');
    await expect(sheet.getByText('3 results')).toBeVisible();
    await shoot(page, 'search-results', size);

    await page.getByRole('combobox', { name: 'Search messages' }).fill('from:');
    await expect(page.getByRole('listbox', { name: 'Filter suggestions' })).toBeVisible();
    await shoot(page, 'search-filters', size);

    // Escape closes it and hands focus back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test(`people sheet at ${size}`, async ({ page }) => {
    await open(page, size);
    const trigger = page.getByRole('button', { name: 'Members' });
    await trigger.click();
    const sheet = dialog(page, 'Members');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Vincent')).toBeVisible();
    await expect(sheet.getByText('Windowlicker — Aphex Twin')).toBeVisible();
    await expect(sheet.getByText('Back in ten')).toBeVisible();
    await expect(sheet.getByText('In Lounge').first()).toBeVisible();
    await shoot(page, 'people', size);

    // Tab never leaves the sheet.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test(`channel menu pages at ${size}`, async ({ page }) => {
    await open(page, size);
    const title = page.getByRole('button', { name: 'General', exact: true }).first();
    await title.click();
    await expect(page.getByRole('menu', { name: 'Channel actions' })).toBeVisible();
    await shoot(page, 'channel-menu', size);

    await page.getByRole('menuitem', { name: 'Pinned messages' }).click();
    const sheet = dialog(page, 'Pinned messages');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Haz 5 runs from 9.')).toBeVisible();
    await shoot(page, 'pins', size);

    // The tabs move between pages without going back to the menu.
    await sheet.getByRole('tab', { name: 'Media' }).click();
    await expect(dialog(page, 'Media')).toBeVisible();
    await expect(dialog(page, 'Media').getByRole('button', { name: /mission-41-07\.png, from Nick/ })).toBeVisible();
    await page.waitForTimeout(400);
    await shoot(page, 'media', size);

    await dialog(page, 'Media').getByRole('tab', { name: 'Leaderboard' }).click();
    await expect(dialog(page, 'Server leaderboard').getByText('Your progress')).toBeVisible();
    await shoot(page, 'leaderboard', size);

    await dialog(page, 'Server leaderboard').getByRole('tab', { name: 'Notifications' }).click();
    await expect(dialog(page, 'Notifications')).toBeVisible();
    await expect(page.getByRole('radio', { name: /Follow the server/ })).toHaveAttribute('aria-checked', 'true');
    await shoot(page, 'notifications', size);

    // Escape puts it away, and focus goes back to the title that opened the menu.
    await page.keyboard.press('Escape');
    await expect(dialog(page, 'Notifications')).toBeHidden();
    await expect(page.getByRole('button', { name: 'General', exact: true }).first()).toBeFocused();
  });

  test(`threads are pushed conversations at ${size}`, async ({ page }) => {
    await open(page, size);
    await page.getByRole('button', { name: 'General', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Threads' }).click();
    const list = dialog(page, 'Threads');
    await expect(list.getByRole('button', { name: /Movie night picks/ })).toBeVisible();
    await expect(list.getByText('Archived')).toBeVisible();
    await shoot(page, 'threads', size);

    await list.getByRole('button', { name: /Movie night picks/ }).click();
    const pushed = dialog(page, 'Thread: Movie night picks');
    await expect(pushed).toBeVisible();
    await page.waitForTimeout(1200);
    await shoot(page, 'thread-pushed', size);
    await expect(pushed.getByText('Vote is 4 to 2 for the space one.')).toBeVisible();

    // Back pops to the list; Escape then puts the sheet away.
    await pushed.getByRole('button', { name: 'Back to threads' }).click();
    await expect(dialog(page, 'Threads')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page, 'Threads')).toBeHidden();
  });

  test(`dialogs the channel menu opens are sheets at ${size}`, async ({ page }) => {
    await open(page, size);
    await page.getByRole('button', { name: 'General', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Catch up summary' }).click();
    const summary = dialog(page, 'Catch up summary');
    await expect(summary.getByText('Jeremy is bringing the projector')).toBeVisible();
    await shoot(page, 'summary', size);
    await page.keyboard.press('Escape');
    await expect(summary).toBeHidden();

    await page.getByRole('button', { name: 'General', exact: true }).first().click();
    await page.getByRole('menuitem', { name: /^Inbox/ }).click();
    await expect(dialog(page, 'Inbox')).toBeVisible();
    await shoot(page, 'inbox', size);
    await page.keyboard.press('Escape');
    await expect(dialog(page, 'Inbox')).toBeHidden();

    await page.getByRole('button', { name: 'General', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    await expect(dialog(page, 'Keyboard shortcuts')).toBeVisible();
    await shoot(page, 'shortcuts', size);
  });
}

test('the account menu opens under your face', async ({ page }) => {
  await open(page, 'desktop');
  const face = page.getByRole('button', { name: /^Your profile/ });
  await face.click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Online' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Developer portal' })).toBeVisible();
  // The menu is a near-solid popover: opaque enough that the timeline behind it does not read through.
  const fill = await menu.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(fill).toMatch(/rgba\(6, 6, 7, 0\.97\)|rgb\(6, 6, 7\)/);
  await shoot(page, 'account-menu', 'desktop');

  // Arrow keys walk the rows; Escape puts it away and focus returns to the face.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(face).toBeFocused();

  await face.click();
  await menu.getByRole('menuitem', { name: 'Reminders' }).click();
  const reminders = dialog(page, 'Reminders');
  await expect(reminders.getByRole('heading', { name: 'Due' })).toBeVisible();
  await expect(reminders.getByRole('button', { name: 'Snooze 1 h' })).toBeVisible();
  await shoot(page, 'reminders', 'desktop');
  await page.keyboard.press('Escape');
  await expect(reminders).toBeHidden();
});

test('a sheet covers exactly the conversation pane, in every window', async ({ page }) => {
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 768]] as const) {
    await page.setViewportSize({ width, height });
    await installGlassScene(page);
    await page.goto(general);
    await expect(page.getByRole('main')).toBeVisible();
    await page.getByRole('button', { name: 'Search messages' }).click();
    const sheet = dialog(page, 'Search messages');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(400);
    const [pane, cover] = await Promise.all([
      page.getByRole('main').boundingBox(),
      sheet.boundingBox(),
    ]);
    expect(cover).not.toBeNull();
    expect(Math.abs((cover?.x ?? 0) - (pane?.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((cover?.width ?? 0) - (pane?.width ?? 0))).toBeLessThan(1);
    expect(Math.abs((cover?.height ?? 0) - (pane?.height ?? 0))).toBeLessThan(1);
    await shoot(page, `search-${width}x${height}`, 'desktop');
    await page.keyboard.press('Escape');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('a sheet fits the conversation beside a stream, in the 420px pane', async ({ page }) => {
  await open(page, 'desktop');
  await callStore(page, '/src/stores/glassStore.ts', 'useGlassStore', 'openStage', {
    guildId: GAME_NIGHT_ID,
    channelId: CH.lounge,
    streamerId: CAST.vincent.id,
  });
  // Side by side: the frame says so, whatever the stage draws inside itself.
  await expect(page.locator('.glass-frame[data-stage="side"]')).toBeVisible();
  // The move into side by side (WP-G15) plays on transforms: measure once it settled.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.getAnimations().filter((a) => a.id.startsWith('glass-morph:') && a.playState === 'running').length
            + document.querySelectorAll('.glass-morph > *').length,
        ),
      { timeout: 5_000 },
    )
    .toBe(0);
  await page.getByRole('button', { name: 'Members' }).click();
  const sheet = dialog(page, 'Members');
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(400);
  const [pane, cover] = await Promise.all([page.getByRole('main').boundingBox(), sheet.boundingBox()]);
  expect(Math.round(pane?.width ?? 0)).toBe(420);
  expect(Math.abs((cover?.x ?? 0) - (pane?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((cover?.width ?? 0) - (pane?.width ?? 0))).toBeLessThan(1);
  await shoot(page, 'people-beside-stage', 'desktop');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: 'Search messages' }).click();
  await page.getByRole('combobox', { name: 'Search messages' }).fill('movie');
  await expect(dialog(page, 'Search messages').getByText('3 results')).toBeVisible();
  await shoot(page, 'search-beside-stage', 'desktop');
});

test('a direct message has its own people sheet', async ({ page }) => {
  await open(page, 'desktop', `/app/dms/${CH.dmBrendan}`);
  await page.getByRole('button', { name: 'People in this message' }).click();
  const sheet = dialog(page, 'People in this message');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Brendan')).toBeVisible();
  await shoot(page, 'people-dm', 'desktop');
});
