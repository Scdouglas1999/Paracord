import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { guildDetailFixture } from '../src/test/guildContractFixtures';
import { gradientPng } from './fixtures/index/png';
import {
  ATTACHMENTS,
  CH,
  CLOCK,
  GUILD,
  PEOPLE,
  installIndexScene,
  outDir,
  shoot,
  sidebar,
  userRecord,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-10 (Server pages and Server color): the Overview, Events, Sports, Daily word,
 * Game servers and a game as pages in main, the sports pin as a thin card, the
 * onboarding gate, the missing-channel states, and Server settings › Overview ›
 * Server color (docs/index-spec.md §8.1, §8.3, §6.8, §2.2).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-pages PARACORD_E2E_INDEX_PORT=4583 \
 *   PARACORD_E2E_INDEX_RT_PORT=4585 PARACORD_E2E_INDEX_WP=ix10 \
 *     npx playwright test -c e2e/index-review.config.ts
 */

const GN = GUILD.gameNight.id;
const FUEL = GUILD.fuel.id;

const user = (who: keyof typeof PEOPLE) => userRecord(PEOPLE[who]);
const iso = (time: string, day = '2026-10-01') => `${day}T${time}-05:00`;

/** What a busy server's Overview reads from the API (the harness answers none of it). */
async function mockOverview(page: Page, guild: string, extra: { events?: unknown[]; quiet?: boolean } = {}) {
  const base = new RegExp(`/api/v1/guilds/${guild}/`);
  await page.route(base, async (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.split(`/guilds/${guild}/`)[1] ?? '';
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    if (rest === 'feed' && extra.quiet) return json({ items: [], next_cursor: null });
    if (rest === 'feed') {
      return json({
        items: [
          {
            type: 'message',
            id: 'm:9001',
            key: '9001',
            at: iso('20:40:00'),
            channel_id: CH.gnScreenshots,
            channel_name: 'screenshots',
            channel_type: 0,
            reason: 'attachment',
            message: {
              id: '9001',
              channel_id: CH.gnScreenshots,
              author: user('nick'),
              content: 'last night’s clutch',
              attachments: ['photo1', 'photo2', 'photo3'].map((key) => {
                const a = ATTACHMENTS[key as 'photo1'];
                return { id: a.id, filename: a.filename, size: 100_000, content_type: a.content_type, url: `/api/v1/attachments/${a.id}`, width: a.width, height: a.height };
              }),
              reactions: [{ emoji: '🔥', count: 3, me: false }],
              pinned: false,
              created_at: iso('20:40:00'),
            },
          },
          {
            type: 'message',
            id: 'm:9002',
            key: '9002',
            at: iso('19:05:00'),
            channel_id: CH.gnLounge,
            channel_name: 'lounge',
            channel_type: 0,
            reason: 'pinned',
            message: {
              id: '9002',
              channel_id: CH.gnLounge,
              author: user('brendan'),
              content: 'Friday: ranked night, bring a squad of four. Drop pod at 9.',
              attachments: [],
              reactions: [],
              pinned: true,
              created_at: iso('19:05:00'),
            },
          },
          {
            type: 'members_joined',
            id: 'j:2026-10-01',
            key: 'j1',
            at: iso('15:00:00'),
            day: '2026-10-01',
            users: [user('maya')],
            total: 1,
          },
        ],
        next_cursor: null,
      });
    }
    if (rest.startsWith('attachments') && extra.quiet) return json({ items: [], next_before: null });
    if (rest.startsWith('attachments')) {
      return json({
        items: ['photo1', 'photo2', 'photo3', 'photo4', 'photo1', 'photo2'].map((key, index) => {
          const a = ATTACHMENTS[key as 'photo1'];
          return { id: `${a.id}-${index}`, filename: a.filename, size: 100_000, content_type: a.content_type, url: `/api/v1/attachments/${a.id}`, width: a.width, height: a.height, author: user('nick'), created_at: iso('20:00:00'), channel_id: CH.gnScreenshots };
        }),
        next_before: null,
      });
    }
    if (rest.startsWith('economy/leaderboard') && extra.quiet) return json({ window: 'weekly', entries: [] });
    if (rest.startsWith('economy/leaderboard')) {
      return json({
        window: 'weekly',
        entries: (['vincent', 'brendan', 'nick', 'maya'] as const).map((who, index) => ({ user: user(who), xp: 1840 - index * 410, level: 9 - index, rank: index + 1 })),
      });
    }
    if (rest === 'events') return json(extra.events ?? []);
    if (rest === 'sports') return json({ enabled: false });
    return route.fallback();
  });
}

/** The whole page in one frame: a tall window, for reading what scrolls (review only). */
async function shootTall(page: Page, name: string, height: number) {
  await page.setViewportSize({ width: 1280, height });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir(), `${name}.png`) });
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function openOverview(page: Page, h: IndexHarness, guild: string) {
  await h.open(`/app/guilds/${guild}`);
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByTestId('ix-overview')).toBeVisible();
}

/** The four review sizes (index-plan §3): 1280 is held against the reference, the rest are read. */
async function shootSizes(page: Page, name: string) {
  await shoot(page, name);
  await shoot(page, name, { size: 'desktop', settle: 400 });
  await shoot(page, name, { size: 'narrow', settle: 400 });
  await shoot(page, name, { size: 'phone', settle: 400 });
  await page.setViewportSize({ width: 1280, height: 800 });
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
  headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
});

/* ------------------------------------------------------------------ sports */

const team = (id: string, abbr: string, name: string, score: number | null) => ({
  id, abbr, name, short_name: name, logo: '', score, record: null, possession: false, winner: false, color: null, alt_color: null,
});
const cubs = () => ({
  id: '401700001', sport: 'baseball', league: 'MLB', league_path: 'baseball/mlb', name: 'Cubs at Brewers',
  start: iso('19:10'), state: 'in', detail: 'Top 7th', period: 7, clock: null, clock_seconds: null,
  home: team('mil', 'MIL', 'Brewers', 2), away: team('chc', 'CHC', 'Cubs', 3),
  last_play: 'Suzuki singles on a ground ball to left field.', last_play_type: null, last_play_score: null,
  down_distance: null, ball_on: null, possession_team_id: null, yards_to_endzone: null, red_zone: null,
  balls: 2, strikes: 1, outs: 1, on_first: true, on_second: false, on_third: false,
  home_win_pct: 0.4, broadcasts: [], heat: 60, tags: [], favorite: true,
});
const chiefs = () => ({
  ...cubs(), id: '401700002', sport: 'football', league: 'NFL', league_path: 'football/nfl', name: 'Chiefs at Bills',
  start: iso('20:20', '2026-10-04'), state: 'pre', detail: 'Sun 8:20 PM', last_play: null,
  home: team('buf', 'BUF', 'Bills', null), away: team('kc', 'KC', 'Chiefs', null), favorite: false, heat: 0, balls: null, strikes: null, outs: null, on_first: null,
});

async function mockSports(page: Page, guild: string, options: { pinnedChannel?: string } = {}) {
  const settings = {
    guild_id: guild, enabled: true, leagues: ['baseball/mlb', 'football/nfl'], favorite_teams: [], show_on_server_page: true,
    default_view: 'all', layout: 'cards', score_alerts: true, updated_at: CLOCK.start,
    channel_pins: options.pinnedChannel
      ? [{ channel_id: options.pinnedChannel, game: 'baseball/mlb/401700001', pinned_by: ME_ID, pinned_at: CLOCK.start }]
      : [],
  };
  await page.route(new RegExp(`/api/v1/guilds/${guild}/sports(/.*)?(\\?.*)?$`), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sports/board')) {
      return route.fulfill(json({
        fetched_at: CLOCK.start,
        leagues: [{ path: 'baseball/mlb', label: 'MLB', error: null }, { path: 'football/nfl', label: 'NFL', error: null }],
        games: [cubs(), chiefs()],
      }));
    }
    if (path.includes('/sports/games/')) {
      return route.fulfill(json({
        fetched_at: CLOCK.start, stale: false, game: cubs(), kind: 'other', win_probability: [], scoring_plays: [], line_score: null,
        leaders: [], probables: [], box: null, football: null, baseball: null,
      }));
    }
    if (path.endsWith('/sports')) return route.fulfill(json(settings));
    return route.fallback();
  });
}

const ME_ID = PEOPLE.you.id;

async function mockDailyWord(page: Page, guild: string) {
  await page.route(`**/api/v1/guilds/${guild}/daily-word`, (route) =>
    route.fulfill(json({ guild_id: guild, enabled: true, share_channel_id: null, show_on_front_page: true, updated_at: CLOCK.start })),
  );
  await page.route(`**/api/v1/guilds/${guild}/daily-word/board`, (route) =>
    route.fulfill(json({ guild_id: guild, puzzle: 412, played: 3, finished: 2, solved: 2, solvers: [user('nick'), user('maya')].map((u) => ({ ...u, nick: null })), visible: false, entries: [] })),
  );
  await page.route('**/api/v1/daily-word/today', (route) =>
    route.fulfill(json({
      puzzle: 412, date: '2026-10-01', next_puzzle_at: '2026-10-02T00:00:00Z', word_length: 5, max_guesses: 6,
      guesses: [{ word: 'crane', states: ['absent', 'present', 'absent', 'absent', 'correct'] }], finished: false, solved: false,
    })),
  );
  await page.route('**/api/v1/daily-word/stats', (route) =>
    route.fulfill(json({ puzzle: 412, played: 9, solved: 7, missed: 2, current_streak: 3, max_streak: 5, distribution: [0, 1, 2, 3, 1, 0] })),
  );
}

const gameServer = (id: string, name: string, kind: string, address: string, status: Record<string, unknown>) => ({
  id, guild_id: GN, kind, name, address, created_at: CLOCK.start, status, announce_channel_id: null,
});

async function mockGameServers(page: Page, guild: string, servers: unknown[], enabled = true) {
  await page.route(`**/api/v1/guilds/${guild}/game-servers`, (route) =>
    route.fulfill(json({ enabled, can_manage: true, limit: 10, servers })),
  );
}

test.describe('IX-10 server pages', () => {
  test('the Overview: the large title, the bar, the widgets in two columns, the latest posts', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await mockOverview(page, GN, {
      events: [
        {
          id: '700000000000000001', guild_id: GN, channel_id: CH.gnRoomLounge, creator_id: PEOPLE.brendan.id, name: 'Ranked night',
          description: null, scheduled_start: iso('21:00', '2026-10-02'), scheduled_end: null, status: 1, entity_type: 1, location: null,
          image_url: null, user_count: 4, user_rsvp: false, created_at: CLOCK.start,
        },
      ],
    });
    // Every widget has something to say: games, the word, and the game servers too.
    await mockSports(page, GN);
    await mockDailyWord(page, GN);
    await mockGameServers(page, GN, [
      gameServer('s1', 'Lantern SMP', 'minecraft_java', 'play.lantern.test:25565', { state: 'up', players_online: 5, players_max: 20, player_names: ['mira_builds', 'jonas', 'Vincent'], last_checked_at: CLOCK.start }),
      gameServer('s2', 'CS2 scrims', 'source', '203.0.113.10:27015', { state: 'down', error: 'No answer within 3 seconds.', last_checked_at: CLOCK.start }),
    ]);
    await page.route(new RegExp(`/api/v1/guilds/${GN}/banner`), (route) => route.fulfill({ status: 200, contentType: 'image/png', body: gradientPng(2) }));
    await openOverview(page, h, GN);
    await expect(page.getByTestId('ix-title')).toHaveText('Game Night');
    // An admin's description and an uploaded banner arrive as GUILD_UPDATE (the page merges the whole payload).
    await h.emit({
      op: 0,
      t: 'GUILD_UPDATE',
      d: {
        id: GN,
        banner_hash: `/api/v1/guilds/${GN}/banner?v=1`,
        description: 'A friendly corner for ranked nights, co-op runs and the occasional movie. Everyone gets a turn on the stream.',
      },
    });
    await expect(page.getByTestId('ix-banner')).toBeVisible();
    await expect(page.getByText('A friendly corner for ranked nights')).toBeVisible();
    // The page's entrance is one event: two seconds on, nothing in the page is running.
    await page.waitForTimeout(2000);
    expect(
      await page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => (animation.effect as KeyframeEffect | null)?.target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).closest('.ix-page'))
          .map((animation) => animation.id || (animation as CSSAnimation).animationName || animation.constructor.name),
      ),
    ).toEqual([]);
    await shootSizes(page, 'overview-game-night');
    await page.setViewportSize({ width: 1280, height: 800 });
    await shootTall(page, 'overview-game-night-tall', 1500);
  });

  test('the Overview of a quiet new server: nothing to show is nothing drawn', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await mockOverview(page, FUEL, { quiet: true });
    await openOverview(page, h, FUEL);
    await expect(page.getByTestId('ix-title')).toHaveText('Fuel');
    // No Live now block (the room card is the live surface), no cover.
    await expect(page.getByText('Live now')).toHaveCount(0);
    await expect(page.getByTestId('ix-banner')).toHaveCount(0);
    await expect(page.getByText('Nothing yet.')).toBeVisible();
    await shootSizes(page, 'overview-fuel-quiet');
  });

  test('Events: the calendar as a page, with the actions on each card', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    const event = (id: string, name: string, over: Record<string, unknown>) => ({
      id, guild_id: GN, channel_id: CH.gnRoomLounge, event_channel_id: null, creator_id: PEOPLE.brendan.id, name, description: null,
      scheduled_start: iso('21:00', '2026-10-02'), scheduled_end: null, recurrence_rule: null, reminder_minutes: null, status: 1,
      entity_type: 1, location: null, image_url: null, user_count: 4, user_rsvp: false, created_at: CLOCK.start, ...over,
    });
    await mockOverview(page, GN, {
      events: [
        event('700000000000000001', 'Ranked night', { description: 'Bring a squad of four. Drop pod at nine.', recurrence_rule: 'weekly', reminder_minutes: 30 }),
        event('700000000000000002', 'Lounge movie', { scheduled_start: iso('21:30'), status: 2, user_rsvp: true, user_count: 6, channel_id: CH.gnRoomLounge }),
        event('700000000000000003', 'Last week’s tournament', { scheduled_start: iso('20:00', '2026-09-24'), status: 3, user_count: 11 }),
      ],
    });
    await h.open(`/app/guilds/${GN}/events`);
    await expect(page.getByTestId('ix-events')).toBeVisible();
    await expect(page.getByTestId('ix-title')).toHaveText('Events');
    await expect(page.getByText('2 events still to come')).toBeVisible();
    // "I'm in" is the one cream button of a card you are not in yet; being in is a pressed, quiet state.
    const ranked = page.getByRole('article', { name: 'Event: Ranked night' });
    await expect(ranked.getByRole('button', { name: 'I’m in' })).toHaveClass(/ix-cream/);
    const movie = page.getByRole('article', { name: 'Event: Lounge movie' });
    await expect(movie.getByRole('button', { name: 'You’re in' })).toHaveAttribute('aria-pressed', 'true');
    await expect(movie).toContainText('Happening now');
    // The past event has no RSVP, and says what it was.
    const past = page.getByRole('article', { name: 'Event: Last week’s tournament' });
    await expect(past.getByRole('button', { name: /I’m in|You’re in/ })).toHaveCount(0);
    await expect(past).toContainText('Completed');
    await shootSizes(page, 'events');
  });

  test('Sports, a game, and the pinned game as a thin card', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await mockOverview(page, GN);
    await mockSports(page, GN, { pinnedChannel: CH.gnLounge });
    await h.open(`/app/guilds/${GN}/sports`);
    await expect(page.getByTestId('ix-sports')).toBeVisible();
    await expect(page.getByTestId('ix-title')).toHaveText('Sports');
    await expect(page.getByRole('link', { name: /Open Cubs at Brewers/ })).toBeVisible();
    await shootSizes(page, 'sports');

    // A game is a pushed page: the matchup is the title and the toolbar has the back chevron.
    await h.open(`/app/guilds/${GN}/sports/baseball/mlb/401700001`);
    await expect(page.getByTestId('ix-game')).toBeVisible();
    await expect(page.getByTestId('ix-title')).toHaveText('Cubs at Brewers');
    await expect(page.getByRole('button', { name: 'Back to Sports' })).toBeVisible();
    await shoot(page, 'sports-game');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/app/guilds/${GN}/sports$`));
  });

  test('the pinned game card is 52 tall and carries the score, the last play and Open', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await mockSports(page, GN, { pinnedChannel: CH.gnLounge });
    await h.open(`/app/guilds/${GN}/channels/${CH.gnLounge}`);
    const pin = page.getByTestId('ix-pin');
    await expect(pin).toBeVisible();
    const box = await pin.boundingBox();
    expect(box?.height).toBe(52);
    await expect(pin).toContainText('CHC');
    await expect(pin).toContainText('Suzuki singles');
    await expect(pin.getByRole('link', { name: 'Open' })).toHaveAttribute('href', new RegExp('/sports/baseball/mlb/401700001'));
    await shoot(page, 'pinned-game');
  });

  test('Daily word: the puzzle on a large-title page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await mockDailyWord(page, GN);
    await h.open(`/app/guilds/${GN}/daily-word`);
    await expect(page.getByTestId('ix-daily-word')).toBeVisible();
    await expect(page.getByTestId('ix-title')).toHaveText('Daily word');
    await expect(page.getByText(/No\. 412/)).toBeVisible();
    await shootSizes(page, 'daily-word');
  });

  test('Game servers: the popover as a page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    const now = CLOCK.start;
    await mockGameServers(page, GN, [
      gameServer('s1', 'Lantern SMP', 'minecraft_java', 'play.lantern.test:25565', { state: 'up', players_online: 5, players_max: 20, player_names: ['mira_builds', 'jonas', 'Vincent', 'brendan'], version: 'Paper 1.21.1', latency_ms: 12, last_checked_at: now }),
      gameServer('s2', 'CS2 scrims', 'source', '203.0.113.10:27015', { state: 'up', players_online: 4, players_max: 10, map: 'de_mirage', latency_ms: 31, last_checked_at: now }),
      gameServer('s3', 'Old Valheim box', 'tcp', 'valheim.lantern.test:2456', { state: 'down', error: 'No answer within 3 seconds.', last_seen_online: null, last_checked_at: now }),
    ]);
    await h.open(`/app/guilds/${GN}/game-servers`);
    await expect(page.getByTestId('ix-game-servers')).toBeVisible();
    await expect(page.getByTestId('ix-title')).toHaveText('Game servers');
    await expect(page.getByText('2 of 3 up')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', 'steam://connect/203.0.113.10:27015');
    await shootSizes(page, 'game-servers');
  });

  test('the onboarding gate is a page over the conversation, and Complete onboarding opens the server', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    let completed = false;
    const body = () => ({
      settings: {
        welcome_title: 'Welcome to Game Night',
        welcome_body: 'A few things before you jump in.',
        rules_text: '1. Be kind. Everyone here is a person.\n2. No spoilers in #lounge without a warning.\n3. Keep voice rooms friendly: mute when you are not talking.\n4. If something feels off, tell a moderator.',
        role_prompt: 'Pick what you play',
        progressive_channel_min_messages: 0,
        role_options: [
          { id: 'o1', role_id: 'r1', label: 'Shooters', description: 'Ranked nights and scrims.', position: 0 },
          { id: 'o2', role_id: 'r2', label: 'Co-op', description: 'Anything with a friends list.', position: 1 },
          { id: 'o3', role_id: 'r3', label: 'Strategy', description: null, position: 2 },
        ],
      },
      member_state: { accepted_rules: completed, selected_role_ids: [], completed_at: completed ? CLOCK.start : null },
    });
    await page.route(new RegExp(`/api/v1/guilds/${GN}/onboarding/me`), async (route) => {
      if (route.request().method() === 'PUT' || route.request().method() === 'PATCH') {
        completed = true;
        return route.fulfill(json(body()));
      }
      return route.fulfill(json(body()));
    });
    await h.open(`/app/guilds/${GN}/channels/${CH.gnLounge}`);
    const gate = page.getByTestId('ix-gate');
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('heading', { level: 1 })).toHaveText('Welcome to Game Night');
    // It covers the conversation, which is out of the Tab order while it is up.
    await expect(page.locator('.ix-main__content > :not(.ix-gate)').first()).toHaveJSProperty('inert', true);
    // The rules are required: no Later, and Complete is off until they are accepted.
    await expect(gate.getByRole('button', { name: 'Later' })).toHaveCount(0);
    await expect(gate.getByRole('button', { name: 'Complete onboarding' })).toBeDisabled();
    await shoot(page, 'onboarding-gate');
    await gate.getByLabel('I have read and agree to follow these rules.').check();
    await gate.getByLabel(/Shooters/).check();
    await expect(gate.getByRole('button', { name: 'Complete onboarding' })).toBeEnabled();
    await expect(gate.getByText('1 role selected')).toBeVisible();
    await shoot(page, 'onboarding-gate-ready');
    await shootSizes(page, 'onboarding-gate-ready');
    await gate.getByRole('button', { name: 'Complete onboarding' }).click();
    await expect(gate).toHaveCount(0);
    await expect(page.locator('.ix-main__content > *').first()).toHaveJSProperty('inert', false);
  });

  test('a server you cannot open, and the Overview skeleton while a server answers', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    // Somebody else's server: the API says no, in its own word. The page does not.
    await page.route('**/api/v1/guilds/399999999999999999/**', (route) =>
      route.fulfill(json({ error: 'forbidden', message: 'forbidden' }, 403)),
    );
    await h.open('/app/guilds/399999999999999999');
    const notYours = page.getByRole('region', { name: 'Server not found' });
    await expect(notYours.getByRole('heading', { level: 1 })).toHaveText('This server isn’t yours to open');
    await expect(page.getByText(/forbidden/i)).toHaveCount(0);
    await expect(notYours.getByRole('button')).toHaveCount(1);
    await expect(notYours.getByRole('button', { name: 'Back to your servers' })).toHaveClass(/ix-cream/);
    await shoot(page, 'server-not-yours');

    // A server that is slow to answer: the Overview's static skeleton, one polite status.
    await page.route('**/api/v1/guilds/388888888888888888/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return route.fulfill(json([]));
    });
    await h.open('/app/guilds/388888888888888888');
    const opening = page.getByRole('status', { name: 'Opening the server' });
    await expect(opening).toHaveAttribute('aria-busy', 'true');
    await expect(opening.locator('button, a, input')).toHaveCount(0);
    await shoot(page, 'overview-loading', { settle: 0 });
  });

  /**
   * The conversation's skeleton (`GuildLoadingScreen`) shows only while a server's channel list is
   * still empty, which the scene's READY never leaves it. Render it with the app's own React in the
   * routed page's area (the module URLs carry the dev server's dependency hash, read from a module
   * that imports React), the way IX-4's shell spec renders a `LargeTitlePage`.
   */
  test('the conversation skeleton is static and in the conversation’s geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await h.open(`/app/guilds/${FUEL}/channels/${CH.fuelGeneral}`);
    await expect(sidebar(page)).toBeVisible();
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/ix/page/LargeTitlePage.tsx')).text();
      const reactUrl = /["'](\/node_modules\/\.vite\/deps\/react\.js\?v=[^"']+)["']/.exec(source)?.[1];
      if (!reactUrl) throw new Error("could not find the app's React module URL");
      const version = reactUrl.split('?')[1];
      const reactModule = (await import(/* @vite-ignore */ reactUrl)) as any;
      const clientModule = (await import(/* @vite-ignore */ `/node_modules/.vite/deps/react-dom_client.js?${version}`)) as any;
      const React = reactModule.default ?? reactModule;
      const client = clientModule.default ?? clientModule;
      const { GuildLoadingScreen } = (await import(/* @vite-ignore */ '/src/pages/guild/GuildStateScreens.tsx')) as any;
      const host = document.createElement('div');
      host.id = 'ix10-skeleton-probe';
      host.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;z-index:2;background:var(--ix-main)';
      document.querySelector('.ix-main__content')?.appendChild(host);
      client.createRoot(host).render(React.createElement(GuildLoadingScreen));
    });
    const skeleton = page.getByTestId('ix-loading');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('aria-busy', 'true');
    // Static: nothing in it animates.
    expect(await skeleton.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    await shoot(page, 'channel-loading', { settle: 300 });
  });

  test('missing-channel and missing-server states: the empty-state layout with one cream action', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await h.open(`/app/guilds/${FUEL}/channels/999999999999999999`);
    const gone = page.getByTestId('ix-empty');
    await expect(gone.getByRole('heading', { level: 1 })).toHaveText('This channel is gone');
    await expect(gone.getByRole('button')).toHaveCount(1);
    await expect(gone.getByRole('button', { name: 'Go to general' })).toHaveClass(/ix-cream/);
    await shootSizes(page, 'channel-gone');
    await gone.getByRole('button', { name: 'Go to general' }).click();
    await expect(page).toHaveURL(new RegExp(`/channels/${CH.fuelGeneral}$`));
  });

  test('Server color: eleven swatches and Match icon, automatic until picked', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    const patches: Array<Record<string, unknown>> = [];
    await page.route(new RegExp(`/api/v1/guilds/${FUEL}$`), async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      // The server's reply is the guild with the change applied (`GuildDetail`).
      const current = guildDetailFixture({ ...h.world.guildSummary(GUILD.fuel), server_url: 'https://index.paracord.local' });
      return route.fulfill(json({ ...current, ...body }));
    });
    await h.open(`/app/guilds/${FUEL}/settings`);
    const field = page.getByRole('region', { name: 'Server color' });
    await expect(field).toBeVisible();
    await expect(field.getByRole('group', { name: 'Server color swatches' }).getByRole('button')).toHaveCount(11);
    await expect(field.getByTestId('server-color-now')).toContainText('Automatic');
    // Fuel's automatic color is its id's: rose, 350.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ix-tint="main"]')].map((l) => l.dataset.hue))).toEqual(['350']);
    await shoot(page, 'server-color-automatic');

    await field.getByRole('button', { name: 'Teal' }).click();
    await expect(field.getByRole('button', { name: 'Teal' })).toHaveAttribute('aria-pressed', 'true');
    expect(patches).toEqual([{ hue: 176 }]);
    // The window follows the server's echo: Fuel is teal now (the tint crossfades, then one layer is left).
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ix-tint="main"]')].map((l) => l.dataset.hue)), { timeout: 5000 }).toEqual(['176']);
    await shoot(page, 'server-color-teal');

    await field.getByRole('button', { name: 'Automatic' }).click();
    await expect(field.getByTestId('server-color-now')).toContainText('Automatic');
    expect(patches.at(-1)).toEqual({ hue: null });
  });

  test('Match icon reads the icon’s own color in the browser and saves that number', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    // A real picture: the harness's generated PNG for variant 3 is drawn entirely in hue 215.
    const icon = `data:image/png;base64,${gradientPng(3).toString('base64')}`;
    const expected = (3 * 67 + 14) % 360;
    const patches: Array<Record<string, unknown>> = [];
    await page.route(new RegExp(`/api/v1/guilds/${FUEL}$`), async (route) => {
      const detail = guildDetailFixture({ ...h.world.guildSummary(GUILD.fuel), server_url: 'https://index.paracord.local' });
      if (route.request().method() === 'GET') return route.fulfill(json({ ...detail, icon_hash: icon }));
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        patches.push(body);
        return route.fulfill(json({ ...detail, icon_hash: icon, ...body }));
      }
      return route.fallback();
    });
    await h.open(`/app/guilds/${FUEL}/settings`);
    const field = page.getByRole('region', { name: 'Server color' });
    const match = field.getByRole('button', { name: 'Match icon' });
    await expect(match).toBeEnabled();
    await match.click();
    await expect.poll(() => patches.length).toBe(1);
    const hue = patches[0].hue as number;
    expect(Math.abs(hue - expected)).toBeLessThanOrEqual(6);
    // It is not on the palette's eleven: it shows as a selected custom swatch, and the window follows.
    await expect(field.getByRole('img', { name: 'Matched to the icon, selected' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ix-tint="main"]')].map((l) => l.dataset.hue)), { timeout: 5000 }).toEqual([String(hue)]);
    await shoot(page, 'server-color-matched');
  });

  test('Events in Server settings keeps its own heading and the same cards', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const h = await installIndexScene(page);
    await mockOverview(page, GN, {
      events: [
        {
          id: '700000000000000001', guild_id: GN, channel_id: CH.gnRoomLounge, event_channel_id: null, creator_id: PEOPLE.brendan.id, name: 'Ranked night',
          description: 'Bring a squad of four.', scheduled_start: iso('21:00', '2026-10-02'), scheduled_end: null, status: 1, entity_type: 1,
          location: null, image_url: null, user_count: 4, user_rsvp: false, created_at: CLOCK.start,
        },
      ],
    });
    await h.open(`/app/guilds/${GN}/settings?section=events`);
    await expect(page.getByRole('heading', { level: 2, name: 'Events' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Event: Ranked night' })).toBeVisible();
    await shoot(page, 'settings-events');
  });
});
