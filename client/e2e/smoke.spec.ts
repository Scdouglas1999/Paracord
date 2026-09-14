import { expect, test } from '@playwright/test';
import { guildDetailFixture, guildSummaryFixture } from '../src/test/guildContractFixtures';
import { isGuildDetail, isGuildSummaryList } from '../src/api/generated/validators';

/**
 * The fixture building is deliberately long: the Buildings column has to
 * truncate it without breaking the layout. Every locator that names it uses
 * this constant, so an assertion matches the *whole* accessible name rather
 * than a prefix that silently stops matching.
 */
const GUILD_NAME =
  'QA Guild With A Very Long Name That Should Truncate Instead Of Breaking Layout';

/** `name:` accepts a RegExp; a literal fixture string has to be escaped for it. */
const literal = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('login -> guild -> message -> voice smoke flow', async ({ page }, testInfo) => {
  const guildId = '1001';
  const textChannelId = '2001';
  const voiceChannelId = '2002';
  const nowIso = new Date().toISOString();
  const historyEpoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const served = new Map<string, Record<string, unknown>>();
  const pageErrors: string[] = [];
  let serverTheme: 'dark' | 'light' | 'amoled' | 'high-contrast' = 'dark';
  let adminStatsRequests = 0;
  let compositionRevoked = false;
  let headerAttention: 'read' | 'unread' | 'mentions' = 'read';
  const attentionChannel = { id: '2003', guild_id: guildId, name: 'updates', type: 0, channel_type: 0, position: 2, nsfw: false, created_at: nowIso, last_message_id: '4000' };

  // This spec never signs in through the form: it opens /app directly and lets
  // the mocked POST /auth/refresh hand it a session, the way a returning
  // browser with a refresh cookie does. Since `685a6bf` the client no longer
  // makes that request on a cold load unless this origin has held a session
  // before — an anonymous visitor used to spend a 401 and a console error on
  // every page view — so the browser has to carry the same marker a real
  // returning browser would (`src/lib/authToken.ts`, `noteSessionEstablished`).
  // Without it the app is correctly anonymous and the whole flow lands on
  // /login.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('paracord:auth:session-seen', '1');
    } catch {
      // A browser refusing storage keeps the old ask-and-see behaviour anyway.
    }
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  if (process.env.PARACORD_E2E_DEBUG) page.on('console', message => console.log(`[browser:${message.type()}]`, message.text()));

  // The mocked account must match the real `CurrentUser` projection: the client
  // verifies it against the generated contract before it will use the account
  // at all, so a short fixture leaves the app with no verified server account.
  const userPayload = {
    id: '42',
    username: 'smoke-user-with-a-very-long-unbroken-name-for-overflow-coverage',
    display_name: null,
    discriminator: 1,
    avatar_hash: null,
    banner_hash: null,
    bio: null,
    pronouns: null,
    email: 'smoke-user@example.test',
    email_verified: true,
    has_public_key: false,
    public_key: null,
    linked_accounts: [],
    bot: false,
    system: false,
    flags: 0,
    created_at: nowIso,
  };

  let showHomeFixtures = false;
  const homeSpaces = ['Design', 'Support'].map((name, index) => guildSummaryFixture({ id: String(1100 + index), name, owner_id: userPayload.id, member_count: 8, created_at: nowIso }));
  const homeChannels = homeSpaces.map((space, index) => ({ ...attentionChannel, id: String(2100 + index), guild_id: space.id, name: index ? 'questions' : 'feedback', last_message_id: String(4100 + index) }));
  let showDmFixtures = false;
  const dmPeer = { ...userPayload, id: '43', username: 'Ada with a long name for header coverage' };
  const dmFixtures = [
    { id: '2004', type: 1, channel_type: 1, recipient: dmPeer, recipients: [dmPeer], position: 0, nsfw: false, created_at: nowIso },
    { id: '2005', type: 3, channel_type: 3, name: 'Design discussion with a long group title', recipients: [userPayload, dmPeer], position: 0, nsfw: false, created_at: nowIso },
  ];
  let messageCounter = 1;
  const messages: Array<Record<string, unknown>> = [];

  await page.route('**/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    });
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    const json = (status: number, payload: unknown) => {
      if (status === 200 && method === 'GET') {
        if (path === '/api/v1/users/@me/guilds') expect(isGuildSummaryList(payload)).toBe(true);
        if (/^\/api\/v1\/guilds\/[^/]+$/.test(path)) expect(isGuildDetail(payload)).toBe(true);
      }
      // The authoritative recovery feed must be able to answer for every message
      // this fixture has ever shown, exactly as the real server does.
      if (/\/messages$/.test(path)) for (const value of Array.isArray(payload) ? payload : [payload]) {
        const message = value as { id?: unknown; channel_id?: unknown; author?: unknown };
        if (message && typeof message.id === 'string' && typeof message.channel_id === 'string' && message.author) served.set(message.id, message as Record<string, unknown>);
      }
      return route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify(payload),
      });
    };

    if (path === '/api/v1/stream/ticket' && method === 'POST') {
      return json(200, { ticket: 'smoke-stream-ticket' });
    }
    if (path.endsWith('/messages/recovery') && method === 'GET') {
      const channelId = path.split('/')[4];
      const after = url.searchParams.get('after') ?? '0';
      const knownIds = (url.searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
      const missing = knownIds.filter(id => !served.has(id));
      if (missing.length) return json(500, { message: `The smoke fixture has no authoritative state for ${missing.join(',')}` });
      return json(200, {
        database_history_epoch: historyEpoch, channel_id: channelId, after, through: after, floor: '0', next: after, complete: true, projection_head: after,
        changes: [],
        states: knownIds.map(id => ({ message_id: id, state: 'present', revision: after, message: { ...served.get(id), message_revision: after } })),
      });
    }
    if (path.endsWith('/messages/attention') && method === 'GET') {
      const id = path.split('/')[4];
      const extra = homeChannels.find(channel => channel.id === id);
      const message = extra
        ? { id: extra.last_message_id, channel_id: id, author: dmPeer, content: `Could you review ${extra.name}?`, attachments: [], reactions: [] }
        : { id: '4000', channel_id: id, author: userPayload, content: 'An update waiting for you.', attachments: [], reactions: [] };
      return json(200, { channel_id: id, user_id: userPayload.id, kind: url.searchParams.get('kind'), message });
    }
    if (showHomeFixtures && method === 'GET') {
      const visible = homeChannels.find(item => path === `/api/v1/guilds/${item.guild_id}/channels/visible`);
      if (visible) return json(200, { channel_ids: [visible.id] });
      const channel = homeChannels.find(item => path === `/api/v1/guilds/${item.guild_id}/channels` || path === `/api/v1/channels/${item.id}/messages`);
      if (channel) return json(200, path.endsWith('/messages') ? [{ id: channel.last_message_id, channel_id: channel.id, author: dmPeer, content: `Could you review ${channel.name}?`, created_at: nowIso, attachments: [], reactions: [] }] : [channel]);
    }
    if (path === '/api/v1/auth/refresh' && method === 'POST') {
      return json(200, { token: 'smoke-token', refresh_token: 'smoke-refresh', user: userPayload });
    }
    if (path === '/api/v1/auth/login' && method === 'POST') {
      return json(200, { token: 'smoke-token', user: userPayload });
    }
    if (path === '/api/v1/users/@me' && method === 'GET') {
      return json(200, userPayload);
    }
    if (path.endsWith('/capabilities') && path.startsWith('/api/v1/channels/') && method === 'GET') {
      return json(200, { version: 1, channel_id: path.split('/')[4], user_id: userPayload.id, encrypted: false, own_identity_enrolled: false, peers_ready: true,
        actions: Object.fromEntries(['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map(action => [action, { supported: true, allowed: !(compositionRevoked && ['send', 'poll', 'attach', 'schedule'].includes(action)), reason: compositionRevoked && ['send', 'poll', 'attach', 'schedule'].includes(action) ? 'Your role no longer allows posting in this channel.' : null }])) });
    }
    if (path === '/api/v1/users/@me/dms' && method === 'GET') return json(200, showDmFixtures ? dmFixtures : []);
    if (showDmFixtures && method === 'GET') {
      const dm = dmFixtures.find(item => path === `/api/v1/channels/${item.id}` || path === `/api/v1/channels/${item.id}/recipients`);
      if (dm) return json(200, path.endsWith('/recipients') ? dm.recipients : dm);
    }
    if (path === '/api/v1/users/@me/read-states' && method === 'GET') {
      return json(200, [{ channel_id: attentionChannel.id, last_message_id: headerAttention === 'read' ? '4000' : '3999', mention_count: headerAttention === 'mentions' ? 3 : 0 }]);
    }
    if (path === `/api/v1/channels/${attentionChannel.id}/messages` && method === 'GET') {
      return json(200, [{ id: '4000', channel_id: attentionChannel.id, author: userPayload, content: 'An update waiting for you.', created_at: nowIso, attachments: [], reactions: [] }]);
    }
    if (path === '/api/v1/users/@me/settings' && method === 'GET') {
      return json(200, {
        user_id: userPayload.id,
        theme: serverTheme,
        locale: 'en-US',
        message_display_compact: false,
        custom_css: null,
        status: 'online',
        custom_status: null,
        crypto_auth_enabled: false,
        notifications: {},
        keybinds: {},
      });
    }
    if (path === '/api/v1/users/@me/notification-settings' && method === 'GET') {
      return json(200, { spaces: [], channels: [] });
    }
    if (path === '/api/v1/users/@me/guilds' && method === 'GET') {
      return json(200, [
        guildSummaryFixture({
          id: guildId,
          name: GUILD_NAME,
          server_url: 'https://smoke.paracord.local',
          owner_id: userPayload.id,
          member_count: 4,
          created_at: nowIso,
        }),
        ...(showHomeFixtures ? homeSpaces : []),
      ]);
    }
    if (path === `/api/v1/guilds/${guildId}/channels/visible` && method === 'GET') {
      return json(200, { channel_ids: [textChannelId, voiceChannelId, attentionChannel.id] });
    }
    if ((path === `/api/v1/channels/${textChannelId}` || path === `/api/v1/channels/${voiceChannelId}`) && method === 'GET') {
      const isVoice = path.endsWith(`/${voiceChannelId}`);
      return json(200, {
        id: isVoice ? voiceChannelId : textChannelId,
        guild_id: guildId,
        name: isVoice ? 'Voice Lounge' : 'qa-general-channel-with-a-very-long-name-for-overflow-coverage',
        type: isVoice ? 2 : 0,
        channel_type: isVoice ? 2 : 0,
        position: isVoice ? 1 : 0,
        nsfw: false,
        parent_id: null,
        required_role_ids: [],
        created_at: nowIso,
      });
    }
    if (path === `/api/v1/guilds/${guildId}/channels` && method === 'GET') {
      return json(200, [
        attentionChannel,
        {
          id: textChannelId,
          guild_id: guildId,
          name: 'qa-general-channel-with-a-very-long-name-for-overflow-coverage',
          type: 0,
          channel_type: 0,
          position: 0,
          nsfw: false,
          parent_id: null,
          required_role_ids: [],
          created_at: nowIso,
        },
        {
          id: voiceChannelId,
          guild_id: guildId,
          name: 'Voice Lounge',
          type: 2,
          channel_type: 2,
          position: 1,
          nsfw: false,
          parent_id: null,
          required_role_ids: [],
          created_at: nowIso,
        },
      ]);
    }
    if (path === `/api/v1/guilds/${guildId}` && method === 'GET') {
      return json(200, guildDetailFixture({
        id: guildId,
        name: GUILD_NAME,
        server_url: 'https://smoke.paracord.local',
        owner_id: userPayload.id,
        member_count: 4,
        created_at: nowIso,
      }));
    }
    if (path === `/api/v1/guilds/${guildId}/onboarding/me` && method === 'GET') {
      return json(200, {
        settings: {
          welcome_title: `Welcome to ${GUILD_NAME}`,
          welcome_body: 'Quick start onboarding',
          rules_text: null,
          role_prompt: null,
          role_options: [],
        },
        member_state: {
          accepted_rules: true,
          selected_role_ids: [],
          completed_at: nowIso,
        },
      });
    }
    if (path === `/api/v1/guilds/${guildId}/onboarding/me` && method === 'PATCH') {
      const payload = request.postDataJSON() as {
        accepted_rules?: boolean;
        selected_role_ids?: string[];
        completed?: boolean;
      };
      return json(200, {
        accepted_rules: Boolean(payload?.accepted_rules),
        selected_role_ids: payload?.selected_role_ids ?? [],
        completed_at: payload?.completed ? nowIso : null,
      });
    }
    if (path === `/api/v1/channels/${textChannelId}/messages` && method === 'GET') {
      return json(200, messages);
    }
    if (path === `/api/v1/channels/${textChannelId}/messages` && method === 'POST') {
      const payload = request.postDataJSON() as { content?: string; nonce?: string };
      const message = {
        id: `${3000 + messageCounter++}`,
        channel_id: textChannelId,
        author: {
          id: userPayload.id,
          username: userPayload.username,
          discriminator: userPayload.discriminator,
          avatar_hash: null,
        },
        content: payload?.content ?? '',
        nonce: payload.nonce,
        pinned: false,
        type: 0,
        message_type: 0,
        timestamp: nowIso,
        created_at: nowIso,
        edited_timestamp: null,
        edited_at: null,
        reference_id: null,
        attachments: [],
        reactions: [],
      };
      messages.push(message);
      return json(201, message);
    }
    if (path === `/api/v1/channels/${textChannelId}/typing` && method === 'POST') {
      return route.fulfill({ status: 204 });
    }
    if (path === `/api/v1/channels/${textChannelId}/read` && method === 'PUT') {
      return json(200, { channel_id: textChannelId, last_message_id: messages.at(-1)?.id ?? null, mention_count: 0 });
    }
    if (path === `/api/v1/channels/${voiceChannelId}/messages` && method === 'GET') {
      return json(200, []);
    }
    if (path === `/api/v1/guilds/${guildId}/members` && method === 'GET') {
      return json(200, []);
    }
    if (path === `/api/v1/guilds/${guildId}/economy/leaderboard` && method === 'GET') {
      return json(200, {
        guild_id: guildId,
        entries: [],
        limit: 8,
      });
    }
    if (path === `/api/v1/guilds/${guildId}/economy/me` && method === 'GET') {
      return json(200, {
        guild_id: guildId,
        user_id: userPayload.id,
        xp: 0,
        level: 0,
        rank: null,
        last_xp_at: nowIso,
        progress: {
          current_level_floor: 0,
          next_level_at: 100,
          xp_into_level: 0,
          xp_required_this_level: 100,
        },
        streak: {
          days: 0,
          longest_days: 0,
          last_active_date: nowIso.slice(0, 10),
        },
        achievements: [],
      });
    }
    if (path === `/api/v1/guilds/${guildId}/economy/level-roles` && method === 'GET') {
      return json(200, {
        guild_id: guildId,
        mappings: [],
      });
    }
    if (path === '/api/v1/discovery/guilds' && method === 'GET') {
      return json(200, {
        guilds: [],
        total: 0,
      });
    }
    if (path === '/api/v1/templates' && method === 'GET') {
      return json(200, []);
    }
    if (path === '/api/v1/bots/applications' && method === 'GET') {
      return json(200, []);
    }
    if (path === '/api/v1/admin/stats' && method === 'GET') {
      adminStatsRequests += 1;
      return json(403, { error: 'admin required' });
    }

    if (method === 'GET') {
      return json(200, []);
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/api/v2/rt/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ws_url: 'ws://127.0.0.1:0/gateway',
        session_id: 'smoke-session',
        token: 'smoke-rt-token',
      }),
    });
  });
  // The realtime stream is served by e2e/realtime-stub.mjs through the dev
  // proxy so READY arrives on one connection that stays open.
  await page.route('**/api/v2/rt/commands', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/v2/voice/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/join')) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Voice unavailable in smoke harness',
        }),
      });
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });

  await page.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${textChannelId}`));

  const responsiveWidths = [320, 375, 414, 768];
  for (const width of responsiveWidths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByPlaceholder(/Say something (in qa-general-channel|to the)/)).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
  }

  const desktopViewports = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];
  for (const viewport of desktopViewports) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByPlaceholder(/Say something (in qa-general-channel|to the)/)).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const lazyRoutes = [
    { path: '/app', text: /Your servers/i },
    { path: '/app/friends', text: /Friends/i },
    { path: '/app/dms', text: /Pick up a conversation/i },
    { path: '/app/discovery', text: /Discover servers/i },
    { path: '/app/templates', text: /Template Gallery/i },
    { path: '/app/developers', text: /Developer portal/i },
  ];
  for (const lazyRoute of lazyRoutes) {
    await page.goto(lazyRoute.path);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText(lazyRoute.text).first()).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
  }

  await page.goto('/app/admin');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(adminStatsRequests).toBe(0);

  await page.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${textChannelId}`));

  const themes = ['dark', 'light', 'amoled', 'high-contrast'] as const;
  for (const theme of themes) {
    serverTheme = theme;
    await page.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(
      async () => page.evaluate(() => document.documentElement.getAttribute('data-theme')),
    ).toBe(theme);
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
  }

  // Inspect the refined header in the default visual theme after validating all
  // theme variants above.
  serverTheme = 'dark';
  await page.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');


  await expect(page.getByRole('button', { name: /Switch channel, current:/ })).toBeVisible();

  const closeWelcome = page.getByRole('button', { name: /Close welcome screen/i });
  if (await closeWelcome.isVisible().catch(() => false)) {
    await closeWelcome.click();
  }
  await page.getByRole('button', { name: 'Skip tour' }).click();

  const conversationHeader = page.locator('.chat-header');
  for (const width of [320, 390, 767, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(conversationHeader.getByRole('button', { name: 'Search messages' })).toBeVisible();
    // lantern-stage-spec §6.5: no docked member list anywhere — the people who
    // are here now are the header's lit strip, and its sheet is the only full
    // list. §7.4 puts search, pins and threads in the header; below the small
    // breakpoint pins and threads fold into the overflow menu (layout-spec §7.8).
    await expect(conversationHeader.getByRole('button', { name: 'Member List' })).toHaveCount(0);
    // Search, pins, threads and the overflow menu. Pins and threads are in the
    // DOM at every width and hidden below the small breakpoint, where the
    // overflow menu carries them (layout-spec §7.8).
    await expect(conversationHeader.locator('.chat-header-actions button')).toHaveCount(4);
    await expect(conversationHeader.getByRole('button', { name: 'Threads' })).toBeVisible({ visible: width >= 640 });
    const moreActions = conversationHeader.getByRole('button', { name: 'More channel actions' });
    await moreActions.focus();
    await page.keyboard.press('ArrowDown');
    const actionMenu = page.getByRole('menu', { name: 'Channel actions' });
    await expect(actionMenu).toBeFocused();
    await expect(actionMenu.getByRole('menuitem', { name: 'Server leaderboard' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(moreActions).toBeFocused();
    await moreActions.click();
    await actionMenu.getByRole('menuitem', { name: 'Pinned messages' }).click();
    const pinsPanel = page.getByRole('complementary', { name: 'Pinned messages' });
    await expect(pinsPanel).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close pinned messages panel' })).toBeInViewport();
    if (width >= 768) {
      const activePanel = conversationHeader.getByRole('button', { name: 'Close Pinned messages', exact: true });
      await expect(activePanel).toBeInViewport();
      await expect(activePanel).toHaveAttribute('aria-expanded', 'true');
      if (width === 1280) await page.screenshot({ path: testInfo.outputPath('header-active-panel-desktop.png'), fullPage: true });
      await activePanel.click();
    } else {
      await page.getByRole('button', { name: 'Close pinned messages panel' }).click();
    }
    await expect(pinsPanel).toBeHidden();
    await expect(moreActions).toBeFocused();
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (width === 390) {
      await moreActions.click();
      await page.screenshot({ path: testInfo.outputPath('header-menu-mobile.png'), fullPage: true });
      await page.keyboard.press('Escape');
    }
  }

  await page.setViewportSize({ width: 390, height: 800 });
  for (const attention of ['unread', 'mentions', 'read'] as const) {
    headerAttention = attention;
    const more = conversationHeader.getByRole('button', { name: 'More channel actions' });
    await more.click();
    await page.getByRole('menuitem', { name: /^Inbox/ }).click();
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close inbox', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeHidden();
    await expect(more).toHaveAccessibleDescription(attention === 'mentions' ? '3 mentions in 1 unread conversation' : attention === 'unread' ? '1 unread conversation' : 'No unread conversations');
    if (attention === 'read') await expect(more.locator('[data-attention-kind]')).toHaveCount(0);
    else {
      await expect(more.locator(`[data-attention-kind="${attention}"]`)).toBeVisible();
      if (attention === 'mentions') await expect(more).toContainText('@3');
      await page.screenshot({ path: testInfo.outputPath(`header-${attention}-mobile.png`), fullPage: true });
    }
  }

  showDmFixtures = true;
  for (const dm of dmFixtures) {
    await page.goto(`/app/dms/${dm.id}`);
    const dmHeader = page.locator('.chat-header');
    await expect(dmHeader.getByRole('button', { name: 'Back to messages' })).toBeVisible();
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(dmHeader.getByRole('button', { name: 'Search messages' })).toBeInViewport();
      await expect(dmHeader.getByRole('button', { name: 'Start direct message voice call' })).toBeInViewport();
      // A group DM is a room too (§7.6): its people live in the header's strip
      // and its sheet, never in a docked list.
      await expect(dmHeader.getByRole('button', { name: 'Member List' })).toHaveCount(0);
      if (dm.type === 3 && width < 480) {
        await expect(dmHeader.locator('.chat-header-mobile-dm-title')).toBeInViewport();
      }
      await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      if (width === 390) await page.screenshot({ path: testInfo.outputPath(`header-dm-${dm.type}-mobile.png`), fullPage: true });
    }
    if (dm.type === 3) {
      await page.setViewportSize({ width: 1280, height: 800 });
      // The strip's sheet is the only full list of people in the product.
      await dmHeader.getByRole('button', { name: /reading/ }).click();
      await expect(page.getByRole('dialog', { name: 'People here now' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
  }
  showDmFixtures = false;
  await page.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);

  const composer = page.getByPlaceholder(/Say something (in qa-general-channel|to the)/);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(composer).toBeVisible();
    await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
    await composer.fill('A draft that remains intact while opening message tools.');
    const more = page.getByRole('button', { name: 'More message tools' });
    if (await more.isVisible()) {
      await more.click();
      await expect(page.getByRole('menu', { name: 'Message tools' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(more).toBeFocused();
    } else {
      await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
    }
    await expect(composer).toHaveValue('A draft that remains intact while opening message tools.');
    await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('composer-390.png'), fullPage: true });
  }
  // A reduced visual viewport represents the room available above an open
  // on-screen keyboard. Long drafts must stay bounded and leave send visible.
  await page.setViewportSize({ width: 390, height: 420 });
  await composer.fill('A multiline draft\n'.repeat(30));
  await expect.poll(async () => (await composer.boundingBox())?.height ?? 0).toBeLessThanOrEqual(190);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await composer.fill('e2e smoke message');
  await composer.press('Enter');
  const history = page.getByLabel('Message history');
  await expect(history.getByText('e2e smoke message')).toBeVisible();
  await composer.fill('SuperLongUnbrokenMessageContentForOverflowCoverage'.repeat(4));
  await composer.press('Enter');
  await expect(history.getByText(/SuperLongUnbrokenMessageContentForOverflowCoverage/)).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Permission discovery updates an already-mounted composer without erasing
  // the draft or allowing Enter/picker actions to bypass the decision.
  await composer.fill('Keep this draft after my role changes.');
  const countBeforeRevocation = messages.length;
  compositionRevoked = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
  await expect(page.getByRole('status').filter({ hasText: 'Your role no longer allows posting in this channel.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await composer.press('Enter');
  await expect(composer).toHaveValue('Keep this draft after my role changes.');
  expect(messages.length).toBe(countBeforeRevocation);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: 'More message tools' }).click();
  await expect(page.getByRole('menuitem', { name: /Create a poll/ })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /Attach files/ })).toBeDisabled();
  const permissionMenu = page.getByRole('menu', { name: 'Message tools' });
  await expect.poll(async () => permissionMenu.evaluate(menu => menu.getBoundingClientRect().bottom <= window.innerHeight - 7)).toBe(true);
  await expect(page.getByRole('menuitem', { name: /^Emoji/ })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('composer-permission-390.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 420 });
  await expect.poll(async () => permissionMenu.evaluate(menu => menu.getBoundingClientRect().bottom <= window.innerHeight - 7)).toBe(true);
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: /^Emoji/ })).toBeInViewport();
  await expect(permissionMenu).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.keyboard.press('Escape');
  compositionRevoked = false;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep this draft after my role changes.');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Ctrl+K inside the draft inserts a Markdown link; leave the editor before
  // exercising the global jump shortcut.
  await composer.press('Tab');
  await expect(composer).not.toBeFocused();
  await page.keyboard.press('Control+K');
  const commandPaletteInput = page.getByPlaceholder(/Jump to a channel, server, or setting/i);
  await expect(commandPaletteInput).toBeVisible();
  await expect(commandPaletteInput).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(commandPaletteInput).toBeHidden();

  await page.keyboard.press('Control+K');
  await expect(commandPaletteInput).toBeVisible();
  await commandPaletteInput.fill('Voice Lounge');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${voiceChannelId}`));

  // Guild Home = the Lobby, the building seen from the street
  // (lantern-stage-spec §7.3). Voice/stage channels render as room cards in the
  // "Rooms" grid; text rooms are rows below; the space-settings entry lives in
  // the Lobby header.
  await page.goto(`/app/guilds/${guildId}`);
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}$`));
  await expect(page.getByRole('heading', { name: /QA Guild/i })).toBeVisible();
  // `exact` because "Text rooms" is the landmark right below it.
  await expect(page.getByRole('region', { name: 'Voice channels', exact: true })).toBeVisible();
  const textChannelsRegion = page.getByRole('region', { name: 'Text channels' });
  await expect(textChannelsRegion).toBeVisible();

  // Building settings now open from the guild-home header (MANAGE_GUILD-gated),
  // not the deleted channel-column dropdown.
  await page.getByRole('button', { name: 'Server settings' }).click();
  const serverSettingsDialog = page.getByRole('dialog', { name: 'Server settings' });
  await expect(serverSettingsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(serverSettingsDialog).toBeHidden();

  // Text-room navigation + keyboard activation from the Lobby. The row and its
  // "…" (the room menu's phone door) both name the room; the row is `.first()`.
  const textChannelButton = textChannelsRegion
    .getByRole('button', { name: /qa-general-channel/i })
    .first();
  await textChannelButton.focus();
  await expect(textChannelButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${textChannelId}`));

  // The Buildings column merges every connected server's guilds into buildings
  // (lantern-stage-spec §7.1). The expanded column is one roving listbox whose
  // grouped options are the buildings and their rooms; a building's window-map
  // plate is its front door and opens the Lobby.
  const buildingsColumn = page.getByRole('listbox', { name: 'Servers and channels' });
  const building = buildingsColumn.getByRole('group', { name: literal(GUILD_NAME) });
  // The lobby option is labelled "<building> lobby — <caption>", so the name to
  // match is the building's full name, not a prefix of it.
  await expect(
    building.getByRole('option', { name: literal(`${GUILD_NAME} lobby`) }),
  ).toBeVisible();

  await page.goto(`/app/guilds/${guildId}/channels/999999999`);
  await expect(page.getByRole('heading', { name: 'Channel not found' })).toBeVisible();
  // Home must prioritize unread work over presence-based quiet copy (§7.5:
  // Needs-you is the right column, and it never calls an unknown state quiet).
  headerAttention = 'mentions';
  showHomeFixtures = true;
  await page.goto('/app');
  const home = page.getByRole('main');
  await expect(home.getByText('Your servers')).toBeVisible();
  const attention = home.getByRole('region', { name: 'Needs you' });
  // The attention preview's author is the reader, so the row keeps the count.
  await expect(attention.getByText('3 mentions for you', { exact: true })).toBeVisible();
  await expect(attention.getByText(/An update waiting for you/)).toBeVisible();
  await expect(attention.getByText(/^Design · /)).toBeVisible();
  await expect(attention.getByText(/^Support · /)).toBeVisible();
  await expect(home.getByText(/is quiet|No data|Nothing is waiting on you/)).toHaveCount(0);
  const openAttention = attention.getByRole('button', { name: `Open ${attentionChannel.name}` });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(openAttention).toBeVisible();
    if (width === 320 || width === 1280) await page.screenshot({ path: testInfo.outputPath(`home-needs-you-${width}.png`), fullPage: true });
  }
  await openAttention.click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${attentionChannel.id}`));
  expect(pageErrors).toEqual([]);
});
