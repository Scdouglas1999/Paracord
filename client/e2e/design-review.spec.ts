import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { guildDetailFixture, guildSummaryFixture } from '../src/test/guildContractFixtures';

/**
 * Design review screenshots — the visual half of a work package's verification
 * gate (docs/lantern-stage-spec.md §10: "no package is done without inspected
 * screenshots").
 *
 * Opt in with `PARACORD_E2E_DESIGN=1 npx playwright test`; it is gated out of
 * the default mocked smoke so CI stays fast. Output lands in
 * `output/design-reference/<WP>/` (gitignored) next to the approved reference
 * renders, so a shot can be held against the artboard it is meant to match.
 *
 * The API is mocked exactly like `smoke.spec.ts` — this never touches a server.
 */

const OUT_DIR = path.resolve(
  process.cwd(),
  '..',
  'output',
  'design-reference',
  process.env.PARACORD_E2E_DESIGN_WP ?? 'wp0',
);

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

const GUILD_ID = '1001';
const TEXT_CHANNEL_ID = '2001';
const DM_CHANNEL_ID = '2004';

test('capture the design-review screens', async ({ page }) => {
  // Twelve frames, each with a settle pause — well past the smoke's budget.
  test.setTimeout(180_000);
  await mkdir(OUT_DIR, { recursive: true });

  const nowIso = new Date().toISOString();
  const historyEpoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const user = {
    id: '42',
    username: 'sam.douglas',
    display_name: 'Sam Douglas',
    discriminator: 1,
    avatar_hash: null,
    banner_hash: null,
    bio: null,
    pronouns: null,
    email: 'sam@example.test',
    email_verified: true,
    has_public_key: false,
    public_key: null,
    linked_accounts: [],
    bot: false,
    system: false,
    flags: 0,
    created_at: nowIso,
  };
  const peer = { ...user, id: '43', username: 'mara.okafor', display_name: 'Mara Okafor' };

  const textChannel = {
    id: TEXT_CHANNEL_ID,
    guild_id: GUILD_ID,
    name: 'build-log',
    type: 0,
    channel_type: 0,
    position: 0,
    nsfw: false,
    parent_id: null,
    required_role_ids: [],
    created_at: nowIso,
  };
  const voiceChannel = { ...textChannel, id: '2002', name: 'Shop floor', type: 2, channel_type: 2, position: 1 };
  const dmChannel = {
    id: DM_CHANNEL_ID,
    type: 1,
    channel_type: 1,
    recipient: peer,
    recipients: [peer],
    position: 0,
    nsfw: false,
    created_at: nowIso,
  };

  const messages = [
    'The thermal soak finished — channel 7 held at 61° the whole run.',
    'Nice. I will pull the trace into the review doc.',
    'Driver v3 is on the bench if anyone wants to watch.',
  ].map((content, i) => ({
    id: String(3000 + i),
    channel_id: TEXT_CHANNEL_ID,
    author: i % 2 === 0 ? peer : user,
    content,
    created_at: nowIso,
    attachments: [],
    reactions: [],
  }));

  const dmMessages = messages.slice(0, 2).map((m, i) => ({
    ...m,
    id: String(3100 + i),
    channel_id: DM_CHANNEL_ID,
  }));

  // First-run chrome (the layout tour and the welcome-aboard onboarding sheet)
  // would otherwise cover the surfaces under review. Mark both as already seen —
  // these screens are meant to show the steady state.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('paracord:v2:layout-tour-shell', 'done');
      window.localStorage.setItem('paracord:v2:layout-tour-guild-home', 'done');
      window.localStorage.setItem('paracord:v2:onboarding-complete', '1');
      window.localStorage.setItem('paracord:v2:guild-welcomed:1001', '1');
    } catch {
      /* storage unavailable — the tour simply shows */
    }
  });

  await page.route('**/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const { pathname } = new URL(request.url());
    const json = (status: number, payload: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify(payload),
      });

    if (pathname === '/api/v1/auth/refresh' && method === 'POST')
      return json(200, { token: 'design-token', refresh_token: 'design-refresh', user });
    if (pathname === '/api/v1/users/@me' && method === 'GET') return json(200, user);
    if (pathname === '/api/v1/users/@me/settings' && method === 'GET')
      return json(200, {
        user_id: user.id,
        theme: 'dark',
        locale: 'en-US',
        message_display_compact: false,
        custom_css: null,
        status: 'online',
        custom_status: null,
        crypto_auth_enabled: false,
        notifications: {},
        keybinds: {},
      });
    if (pathname === '/api/v1/users/@me/notification-settings' && method === 'GET')
      return json(200, { spaces: [], channels: [] });
    if (pathname === '/api/v1/users/@me/guilds' && method === 'GET')
      return json(200, [
        guildSummaryFixture({
          id: GUILD_ID,
          name: 'Kestrel Robotics',
          server_url: 'https://design.paracord.local',
          owner_id: user.id,
          member_count: 24,
          created_at: nowIso,
        }),
      ]);
    if (pathname === `/api/v1/guilds/${GUILD_ID}` && method === 'GET')
      return json(
        200,
        guildDetailFixture({
          id: GUILD_ID,
          name: 'Kestrel Robotics',
          server_url: 'https://design.paracord.local',
          owner_id: user.id,
          member_count: 24,
          created_at: nowIso,
        }),
      );
    if (pathname === `/api/v1/guilds/${GUILD_ID}/channels` && method === 'GET')
      return json(200, [textChannel, voiceChannel]);
    if (pathname === `/api/v1/guilds/${GUILD_ID}/channels/visible` && method === 'GET')
      return json(200, { channel_ids: [TEXT_CHANNEL_ID, voiceChannel.id] });
    if (pathname === `/api/v1/channels/${TEXT_CHANNEL_ID}` && method === 'GET')
      return json(200, textChannel);
    if (pathname === `/api/v1/channels/${voiceChannel.id}` && method === 'GET')
      return json(200, voiceChannel);
    if (pathname === `/api/v1/channels/${TEXT_CHANNEL_ID}/messages` && method === 'GET')
      return json(200, messages);
    if (pathname === `/api/v1/channels/${DM_CHANNEL_ID}/messages` && method === 'GET')
      return json(200, dmMessages);
    if (pathname === '/api/v1/users/@me/dms' && method === 'GET') return json(200, [dmChannel]);
    if (pathname === `/api/v1/channels/${DM_CHANNEL_ID}` && method === 'GET') return json(200, dmChannel);
    if (pathname === `/api/v1/channels/${DM_CHANNEL_ID}/recipients` && method === 'GET')
      return json(200, [peer]);
    if (pathname.endsWith('/capabilities') && pathname.startsWith('/api/v1/channels/'))
      return json(200, {
        version: 1,
        channel_id: pathname.split('/')[4],
        user_id: user.id,
        encrypted: false,
        own_identity_enrolled: false,
        peers_ready: true,
        actions: Object.fromEntries(
          ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map(
            (action) => [action, { supported: true, allowed: true, reason: null }],
          ),
        ),
      });
    // The durable-delivery runtime will not surface a message until the
    // authoritative recovery feed has confirmed it, exactly as against a real
    // server — without this the timeline stays on skeletons.
    if (pathname.endsWith('/messages/recovery') && method === 'GET') {
      const channelId = pathname.split('/')[4];
      const after = new URL(request.url()).searchParams.get('after') ?? '0';
      const knownIds = (new URL(request.url()).searchParams.get('known_ids') ?? '')
        .split(',')
        .filter(Boolean);
      const pool = [...messages, ...dmMessages];
      return json(200, {
        database_history_epoch: historyEpoch,
        channel_id: channelId,
        after,
        through: after,
        floor: '0',
        next: after,
        complete: true,
        projection_head: after,
        changes: [],
        states: knownIds.map((id) => ({
          message_id: id,
          state: 'present',
          revision: after,
          message: { ...pool.find((m) => m.id === id), message_revision: after },
        })),
      });
    }
    if (pathname === '/api/v1/users/@me/read-states' && method === 'GET') return json(200, []);
    if (pathname === `/api/v1/guilds/${GUILD_ID}/onboarding/me` && method === 'GET')
      return json(200, {
        settings: {
          welcome_title: 'Kestrel Robotics',
          welcome_body: null,
          rules_text: null,
          role_prompt: null,
          role_options: [],
        },
        member_state: { accepted_rules: true, selected_role_ids: [], completed_at: nowIso },
      });
    if (pathname === '/api/v1/stream/ticket' && method === 'POST')
      return json(200, { ticket: 'design-stream-ticket' });
    if (method === 'GET') return json(200, []);
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/api/v2/rt/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ws_url: 'ws://127.0.0.1:0/gateway',
        session_id: 'design-session',
        token: 'design-rt-token',
      }),
    }),
  );
  await page.route('**/api/v2/rt/commands', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/v2/voice/**', (route) => route.fulfill({ status: 204, body: '' }));

  const shoot = async (name: string) => {
    // Let the message runtime finish its first reconciliation and the fonts
    // load, so a shot never captures skeletons or a fallback face. `networkidle`
    // is no use here: the app holds an open realtime stream for its whole life.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
  };

  const screens: Array<{ name: string; url: string; ready: () => Promise<unknown> }> = [
    {
      name: 'tokens',
      url: '/design-tokens',
      ready: () => expect(page.getByRole('heading', { name: 'Lantern Stage tokens' })).toBeVisible(),
    },
    {
      name: 'home',
      url: '/app',
      ready: () => expect(page.getByRole('main')).toBeVisible(),
    },
    {
      name: 'channel',
      url: `/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`,
      ready: () => expect(page.getByRole('main')).toBeVisible(),
    },
    {
      name: 'dm',
      url: `/app/dms/${DM_CHANNEL_ID}`,
      ready: () => expect(page.getByRole('main')).toBeVisible(),
    },
    {
      name: 'settings',
      url: '/app?settings=appearance',
      ready: () => expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible(),
    },
  ];

  for (const { name, url, ready } of screens) {
    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto(url);
      await ready();
      await shoot(`${name}-${label}`);
    }
  }

  // The tokens page scrolled to the theme comparison, where all four themes are
  // painted side by side — the single most useful frame for reviewing WP0.
  await page.setViewportSize(DESKTOP);
  await page.goto('/design-tokens');
  await page.locator('#themes').scrollIntoViewIfNeeded();
  await shoot('tokens-themes-1440x900');
  await page.locator('#primitives').scrollIntoViewIfNeeded();
  await shoot('tokens-primitives-1440x900');
});
