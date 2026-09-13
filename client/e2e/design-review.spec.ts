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

const WP = process.env.PARACORD_E2E_DESIGN_WP ?? 'wp0';

const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', WP);

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

const GUILD_ID = '1001';
const TEXT_CHANNEL_ID = '2001';
const DM_CHANNEL_ID = '2004';

test('capture the design-review screens', async ({ page }) => {
  // Twelve frames for the base set, ~70 more for WP7 — each with a settle
  // pause, so well past the smoke's budget.
  test.setTimeout(WP === 'wp7' ? 2_400_000 : 180_000);
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
    // UserFlags.ADMIN — the admin panel and the Server settings section are
    // part of WP7's scope, so the fixture operator can actually open them.
    flags: 1,
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

  let signedOut = false;

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

    if (pathname === '/api/v1/auth/refresh' && method === 'POST') {
      // The entry screens (login, register, setup, connect, invite, legal) only
      // render for a signed-out visitor; `signedOut` flips the whole mock.
      if (signedOut) return json(401, { message: 'No session' });
      return json(200, { token: 'design-token', refresh_token: 'design-refresh', user });
    }
    if (pathname === '/api/v1/setup/status' && method === 'GET')
      return json(200, { setup_required: true, instance_name: 'Kestrel Robotics' });
    if (pathname === '/api/v1/setup/password-requirements' && method === 'GET')
      return json(200, {
        min_length: 12,
        max_length: 128,
        requires_uppercase: true,
        requires_lowercase: true,
        requires_digit: true,
        requires_symbol: false,
      });
    if (pathname === '/api/v1/instance' && method === 'GET')
      return json(200, { max_upload_size: 26214400, p2p_threshold: 8388608, setup_required: false, instance_name: 'Kestrel Robotics' });
    if (pathname === '/api/v1/invites/kestrel' && method === 'GET')
      return json(200, {
        code: 'kestrel',
        guild: { id: GUILD_ID, name: 'Kestrel Robotics', icon_hash: null, member_count: 24, description: null },
        channel: { id: TEXT_CHANNEL_ID, name: 'build-log' },
        inviter: peer,
        approximate_member_count: 24,
        approximate_presence_count: 9,
        expires_at: null,
        max_uses: 0,
        uses: 3,
      });
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

  /* ---------------------------------------------------------------------- */
  /* WP1 — the light vocabulary.                                             */
  /*                                                                        */
  /* The `Light components` section of /design-tokens renders every light    */
  /* component in every state from real models, so one frame per viewport is */
  /* the whole package. Opt in with                                          */
  /*   PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp1 npx playwright test  */
  /* ---------------------------------------------------------------------- */
  if (WP === 'wp1') {
    // The tokens page scrolls inside its own container, so a tall ELEMENT
    // screenshot comes back clipped to whatever the container had painted.
    // Shoot the viewport instead, once per anchored block.
    const blocks = [
      ['avatars', '#light-avatars'],
      ['windows', '#light-windows'],
      ['thumbnails', '#light-thumbnails'],
      ['herenow', '#light-herenow'],
    ] as const;

    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto('/design-tokens');
      await expect(page.getByRole('heading', { name: 'Light components' })).toBeVisible();

      for (const [name, selector] of blocks) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        // The shell can briefly swap back to its boot splash while the account
        // bootstrap settles; re-assert the section before every frame so a shot
        // can never catch the splash instead of the components.
        await expect(page.getByRole('heading', { name: 'Light components' })).toBeVisible();
        await shoot(`light-${name}-${label}`);
      }

      // The here-now people sheet is the only full list in the product (§6.5),
      // so it gets its own frame with the floating surface open.
      const strip = page.locator('#light-herenow').getByRole('button').first();
      await strip.scrollIntoViewIfNeeded();
      await strip.click();
      await expect(page.getByRole('dialog', { name: 'People here now' })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT_DIR, `light-people-sheet-${label}.png`) });
      await page.keyboard.press('Escape');
    }
    return;
  }

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

  /* ---------------------------------------------------------------------- */
  /* WP7 — settings, dialogs, auth and onboarding.                           */
  /*                                                                        */
  /* Every surface WP7 restyles, at both viewports, so each one can be held  */
  /* against the reference renders. Opt in with                              */
  /*   PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp7 npx playwright test  */
  /*                                                                        */
  /* A frame that cannot be reached is recorded and the run carries on, so   */
  /* one broken screen never costs you the other sixty; the list is asserted */
  /* empty at the end, so the gate still means something.                    */
  /* ---------------------------------------------------------------------- */
  if (WP !== 'wp7') return;

  const missed: string[] = [];

  // Settings sections are reached by clicking the index, not by reloading the
  // app for each one: one boot per viewport, and it exercises the real
  // interaction rather than nine cold starts.
  const captureSettingsSections = async (
    prefix: string,
    url: string,
    dialogName: string | null,
    sections: string[],
    viewport: { width: number; height: number },
    label: string,
  ) => {
    await page.setViewportSize(viewport);
    try {
      await page.goto(url);
      if (dialogName) {
        await expect(page.getByRole('dialog', { name: dialogName })).toBeVisible({ timeout: 15_000 });
      } else {
        await expect(page.getByRole('main')).toBeVisible({ timeout: 15_000 });
      }
    } catch {
      missed.push(`${prefix} (${label}): never opened`);
      return;
    }

    const scope = dialogName ? page.getByRole('dialog', { name: dialogName }) : page;
    const phone = viewport.width < 700;

    for (const section of sections) {
      const name = `${prefix}-${section.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${label}`;
      try {
        // On a phone the shell is an index/detail pair: step back to the index
        // before picking the next section.
        if (phone) {
          const back = scope.getByRole('button', { name: 'Back to the settings index' });
          if (await back.count()) await back.first().click({ timeout: 5_000 });
        }
        await scope.getByRole('button', { name: section, exact: true }).first().click({ timeout: 10_000 });
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), timeout: 20_000 });
      } catch {
        missed.push(name);
      }
    }
  };

  const USER_SECTIONS = [
    'My Account',
    'Appearance',
    'Voice & Video',
    'Notifications',
    'Activity Privacy',
    'Keybinds',
    'Identity',
    'Server',
    'About',
  ];

  for (const [label, viewport] of [
    ['1440x900', DESKTOP],
    ['390x844', PHONE],
  ] as const) {
    await captureSettingsSections(
      'settings-user',
      '/app?settings=account',
      'User settings',
      USER_SECTIONS,
      viewport,
      label,
    );
  }

  // --- space settings, admin, developer ----------------------------------
  const plainScreens: Array<{ name: string; url: string }> = [
    { name: 'settings-space', url: `/app/guilds/${GUILD_ID}/settings` },
    { name: 'settings-admin', url: '/app/admin' },
    { name: 'settings-developer', url: '/app/developers' },
    { name: 'lobby', url: `/app/guilds/${GUILD_ID}` },
  ];
  for (const { name, url } of plainScreens) {
    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      try {
        await page.goto(url);
        await expect(page.getByRole('main')).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(OUT_DIR, `${name}-${label}.png`), timeout: 20_000 });
      } catch {
        missed.push(`${name}-${label}`);
      }
    }
  }

  // --- dialogs -----------------------------------------------------------
  const dialogs: Array<{ name: string; url: string; open: () => Promise<unknown> }> = [
    {
      // The voice connection check, opened from *inside* the settings overlay —
      // the stacking case that has its own z-index regression test.
      name: 'dialog-voice-check',
      url: '/app?settings=voice',
      open: async () => {
        await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible({ timeout: 15_000 });
        const phoneRow = page.getByRole('button', { name: 'Voice & Video', exact: true });
        if (await phoneRow.count()) await phoneRow.first().click({ timeout: 5_000 }).catch(() => undefined);
        await page.getByRole('button', { name: /connection check/i }).first().click({ timeout: 10_000 });
      },
    },
    {
      name: 'dialog-invite',
      url: `/app/guilds/${GUILD_ID}`,
      open: async () => {
        await expect(page.getByRole('main')).toBeVisible({ timeout: 15_000 });
        await page.getByRole('button', { name: 'Invite people' }).first().click({ timeout: 10_000 });
      },
    },
    {
      // The dialog shell, the danger button and a field, in one frame.
      name: 'dialog-confirm',
      url: '/design-tokens',
      open: () => page.getByRole('button', { name: 'Open a dialog' }).click({ timeout: 10_000 }),
    },
  ];
  for (const { name, url, open } of dialogs) {
    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      try {
        await page.goto(url);
        await open();
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT_DIR, `${name}-${label}.png`), timeout: 20_000 });
      } catch {
        missed.push(`${name}-${label}`);
      }
    }
  }

  // --- auth and onboarding (signed out) ----------------------------------
  signedOut = true;
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* storage unavailable */
    }
  });

  const entryScreens: Array<[string, string]> = [
    ['auth-login', '/login'],
    ['auth-register', '/register'],
    ['auth-setup-server', '/setup-server'],
    ['auth-connect', '/connect'],
    ['auth-account-setup', '/setup'],
    ['auth-account-unlock', '/unlock'],
    ['auth-account-recover', '/recover'],
    ['auth-invite', '/invite/kestrel'],
    ['auth-terms', '/terms'],
    ['auth-privacy', '/privacy'],
  ];
  for (const [name, url] of entryScreens) {
    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      try {
        await page.goto(url);
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(OUT_DIR, `${name}-${label}.png`), timeout: 20_000 });
      } catch {
        missed.push(`${name}-${label}`);
      }
    }
  }

  expect(missed, `frames that could not be captured:\n${missed.join('\n')}`).toEqual([]);
});
