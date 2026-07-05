import { expect, test } from '@playwright/test';

test('login -> guild -> message -> voice smoke flow', async ({ page }) => {
  const guildId = '1001';
  const textChannelId = '2001';
  const voiceChannelId = '2002';
  const nowIso = new Date().toISOString();
  const pageErrors: string[] = [];
  let serverTheme: 'dark' | 'light' | 'amoled' | 'high-contrast' = 'dark';
  let adminStatsRequests = 0;

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  const userPayload = {
    id: '42',
    username: 'smoke-user-with-a-very-long-unbroken-name-for-overflow-coverage',
    discriminator: '0001',
    avatar_hash: null,
    bot: false,
    system: false,
    flags: 0,
    created_at: nowIso,
  };

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

    const json = (status: number, payload: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });

    if (path === '/api/v1/auth/refresh' && method === 'POST') {
      return json(200, { token: 'smoke-token', refresh_token: 'smoke-refresh', user: userPayload });
    }
    if (path === '/api/v1/auth/login' && method === 'POST') {
      return json(200, { token: 'smoke-token', user: userPayload });
    }
    if (path === '/api/v1/users/@me' && method === 'GET') {
      return json(200, userPayload);
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
    if (path === '/api/v1/users/@me/guilds' && method === 'GET') {
      return json(200, [
        {
          id: guildId,
          name: 'QA Guild With A Very Long Name That Should Truncate Instead Of Breaking Layout',
          server_url: 'https://smoke.paracord.local',
          icon_hash: null,
          owner_id: userPayload.id,
          member_count: 4,
          features: [],
          created_at: nowIso,
        },
      ]);
    }
    if (path === `/api/v1/guilds/${guildId}/channels` && method === 'GET') {
      return json(200, [
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
      return json(200, {
        id: guildId,
        name: 'QA Guild With A Very Long Name That Should Truncate Instead Of Breaking Layout',
        server_url: 'https://smoke.paracord.local',
        icon_hash: null,
        owner_id: userPayload.id,
        member_count: 4,
        features: [],
        hub_settings: null,
        created_at: nowIso,
      });
    }
    if (path === `/api/v1/guilds/${guildId}/onboarding/me` && method === 'GET') {
      return json(200, {
        settings: {
          welcome_title: 'Welcome to QA Guild With A Very Long Name That Should Truncate Instead Of Breaking Layout',
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
      const payload = request.postDataJSON() as { content?: string };
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
  await page.route('**/api/v2/rt/events**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
      body: 'event: gateway\ndata: {\"op\":0,\"t\":\"READY\",\"d\":{}}\n\n',
    });
  });
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
    await expect(page.getByPlaceholder(/Message #qa-general-channel/)).toBeVisible();
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
    await expect(page.getByPlaceholder(/Message #qa-general-channel/)).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const lazyRoutes = [
    { path: '/app', text: /New message/i },
    { path: '/app/friends', text: /Friends/i },
    { path: '/app/dms', text: /Pick up a conversation/i },
    { path: '/app/discovery', text: /Discover Servers/i },
    { path: '/app/templates', text: /Template Gallery/i },
    { path: '/app/developers', text: /Developer Portal/i },
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

  const composer = page.getByPlaceholder(/Message #qa-general-channel/);
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

  const closeWelcome = page.getByRole('button', { name: /Close welcome screen/i });
  if (await closeWelcome.isVisible().catch(() => false)) {
    await closeWelcome.click();
  }

  await page.keyboard.press('Control+K');
  const commandPaletteInput = page.getByPlaceholder(/Jump to a channel, space, or setting/i);
  await expect(commandPaletteInput).toBeVisible();
  await expect(commandPaletteInput).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(commandPaletteInput).toBeHidden();

  await page.keyboard.press('Control+K');
  await expect(commandPaletteInput).toBeVisible();
  await commandPaletteInput.fill('Voice Lounge');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${voiceChannelId}`));

  // Guild Home = Rooms view — the presence-first map that replaces the old
  // channel column (layout-spec §1/§2). Voice/stage channels render as room
  // cards; text channels group below; the server-settings entry lives in the
  // guild-home header.
  await page.goto(`/app/guilds/${guildId}`);
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}$`));
  await expect(page.getByRole('heading', { name: /QA Guild/i })).toBeVisible();
  // Quiet guild → the section reserves "Live rooms" for occupied rooms and
  // reads "Rooms" while every voice room is empty (layout-spec §1.2).
  await expect(page.getByRole('region', { name: 'Rooms' })).toBeVisible();
  const textChannelsRegion = page.getByRole('region', { name: 'Text channels' });
  await expect(textChannelsRegion).toBeVisible();

  // Server settings now open from the guild-home header (MANAGE_GUILD-gated),
  // not the deleted channel-column dropdown.
  await page.getByRole('button', { name: 'Server settings' }).click();
  const serverSettingsDialog = page.getByRole('dialog', { name: 'Server settings' });
  await expect(serverSettingsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(serverSettingsDialog).toBeHidden();

  // Text-channel navigation + keyboard activation from the Rooms view.
  const textChannelButton = textChannelsRegion.getByRole('button', {
    name: /qa-general-channel/i,
  });
  await textChannelButton.focus();
  await expect(textChannelButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${guildId}/channels/${textChannelId}`));

  // The unified sidebar merges every connected server's guilds into "Spaces";
  // the guild is reachable there as a roving-tabindex option row.
  // The expanded sidebar is one roving listbox with grouped options; "Spaces" is
  // the "Joined servers" group inside it (single-listbox composite, not four).
  const spacesList = page.getByRole('group', { name: 'Joined servers' });
  await expect(spacesList.getByRole('option', { name: /QA Guild/i })).toBeVisible();

  await page.goto(`/app/guilds/${guildId}/channels/999999999`);
  await expect(page.getByRole('heading', { name: 'Channel not found' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
