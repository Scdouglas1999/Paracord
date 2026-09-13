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
  let setupRequired = false;

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
    // The admin panel's overview reads a whole report; the catch-all `[]` below
    // is truthy, so without this the panel renders against an array and throws.
    // The invite modal validates the create response against the GuildInvite
    // contract; the catch-all `[]` below fails it and the frame would only ever
    // show the error banner.
    if (/^\/api\/v1\/channels\/\d+\/invites$/.test(pathname) && method === 'POST')
      return json(200, {
        channel_id: TEXT_CHANNEL_ID,
        code: 'kestrel',
        created_at: nowIso,
        guild_id: GUILD_ID,
        inviter_id: user.id,
        max_age: 604800,
        max_uses: 0,
        uses: 0,
      });
    if (pathname === '/api/v1/admin/health' && method === 'GET')
      return json(200, {
        version: '2.0.0',
        uptime_seconds: 271_845,
        database: { engine: 'sqlite', size_bytes: 48_234_496 },
        storage: { uploads_bytes: 1_204_887_552, media_bytes: 318_767_104 },
        backups: {
          auto_enabled: true,
          interval_seconds: 86_400,
          count: 7,
          latest_at: nowIso,
          latest_age_hours: 3,
          total_bytes: 402_653_184,
        },
        network: {
          bind_address: '0.0.0.0:8090',
          public_url: 'https://design.paracord.local',
          tls_enabled: true,
          tls_self_signed: false,
          registration_open: true,
          federation_enabled: true,
        },
        media: { native_enabled: true, native_port: 8443, livekit_available: false },
        counts: { users: 61, guilds: 1, messages: 18_402, channels: 12, online_users: 24 },
        checks: [
          {
            id: 'backup-age',
            severity: 'info',
            title: 'Backups are current',
            detail: 'The newest archive is 3 hours old and seven are kept.',
          },
          {
            id: 'registration-open',
            severity: 'warning',
            title: 'Anyone can create an account',
            detail: 'Registration is open. Close it in Settings if this server is for a fixed group.',
          },
        ],
      });
    if (pathname === '/api/v1/admin/stats' && method === 'GET')
      return json(200, { total_users: 61, total_guilds: 1, total_messages: 18_402, total_channels: 12 });
    if (pathname === '/api/v1/setup/status' && method === 'GET')
      return json(200, { setup_required: setupRequired, instance_name: 'Kestrel Robotics' });
    if (pathname === '/api/v1/setup/password-requirements' && method === 'GET')
      // Match what the page advertises, so the rules-disagree banner (a real
      // warning, not a design state) does not sit on top of the frame.
      return json(200, {
        min_length: 10,
        max_length: 128,
        length_unit: 'utf8_bytes',
        requires_uppercase: true,
        requires_lowercase: true,
        requires_digit: true,
        requires_symbol: true,
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

  /* ---------------------------------------------------------------------- */
  /* WP2 — the Buildings column.                                             */
  /*                                                                        */
  /* Two halves: the column in isolation on /design-tokens, where the states */
  /* the contract names are driven by real models (a Lobby open, a text room */
  /* open, you in a call, and no buildings at all), and the column in situ   */
  /* in the app, where it has to live beside a real main pane.               */
  /*   PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp2 npx playwright test  */
  /* ---------------------------------------------------------------------- */
  if (WP === 'wp2') {
    const columns = [
      ['lobby', '#column-lobby'],
      ['room', '#column-room'],
      ['call', '#column-call'],
      ['empty', '#column-empty'],
    ] as const;

    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto('/design-tokens');
      await expect(page.getByRole('heading', { name: 'Buildings column' })).toBeVisible();

      for (const [name, selector] of columns) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        // The shell can briefly swap back to its boot splash while the account
        // bootstrap settles; re-assert the section before every frame.
        await expect(page.getByRole('heading', { name: 'Buildings column' })).toBeVisible();
        await shoot(`column-${name}-${label}`);
      }

      // In situ: the Lobby, then a text room. On a phone the column is an
      // overlay (layout-spec §6), so open it where the header offers the
      // control — a closed overlay is the honest phone default for the Lobby.
      for (const [name, url] of [
        ['app-lobby', `/app/guilds/${GUILD_ID}`],
        ['app-room', `/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`],
      ] as const) {
        await page.goto(url);
        await expect(page.getByRole('main')).toBeVisible();
        if (viewport === DESKTOP) {
          // The same selectors the mocked smoke uses for the column, asserted
          // here too so a rename cannot pass unnoticed while the smoke is red
          // for an unrelated package.
          const column = page.getByRole('listbox', { name: 'Buildings and rooms' });
          await expect(
            column.getByRole('group', { name: /Kestrel Robotics/i })
              .getByRole('option', { name: /Kestrel Robotics lobby/i }),
          ).toBeVisible();
        }
        if (viewport === PHONE) {
          const expand = page.getByRole('button', { name: 'Expand sidebar' });
          if (await expand.count()) await expand.first().click();
        }
        await shoot(`${name}-${label}`);
      }
    }
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* WP4 — the Lobby (§7.3).                                                 */
  /*                                                                        */
  /* A building is only worth looking at when its lights say something, so   */
  /* this captures the Lobby twice: a LIT building (a live room with a       */
  /* screen share, people reading a text room, an event on the calendar and  */
  /* images in the strip) and the same building ALL DARK. Opt in with        */
  /*   PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp4 npx playwright test  */
  /*                                                                        */
  /* Light comes from the gateway, and the mocked realtime stream never      */
  /* connects — so the stream is replaced in the page with a stub that       */
  /* replays one READY (carrying the guild's voice states and presences) and */
  /* keeps a typing signal alive. Nothing in the app changes: the stub is a  */
  /* `window.EventSource`, exactly what `connectionManager` asks the         */
  /* platform for.                                                          */
  /* ---------------------------------------------------------------------- */
  if (WP === 'wp4') {
    const lobbyVoice = { ...voiceChannel, id: '2002', name: 'Shop floor', position: 0 };
    const lobbyLounge = { ...voiceChannel, id: '2003', name: 'Lounge', position: 1 };
    const lobbyText = [
      textChannel,
      { ...textChannel, id: '2005', name: 'general', position: 3 },
      { ...textChannel, id: '2006', name: 'firmware', position: 4 },
    ];
    const lobbyChannels = [lobbyVoice, lobbyLounge, ...lobbyText];

    const cast = [
      { id: '43', username: 'mara.okafor', display_name: 'Mara Okafor' },
      { id: '44', username: 'priya.raman', display_name: 'Priya Raman' },
      { id: '45', username: 'ren.ito', display_name: 'Ren Ito' },
      { id: '46', username: 'tomas.lindqvist', display_name: 'Tomas Lindqvist' },
      { id: '47', username: 'aisha.karim', display_name: 'Aisha Karim' },
      { id: '48', username: 'jonah.bell', display_name: 'Jonah Bell' },
    ];
    const lobbyMembers = [user, ...cast].map((who) => ({
      user: { ...user, ...who, avatar_hash: null },
      nick: null,
      roles: [],
      joined_at: nowIso,
      deaf: false,
      mute: false,
    }));

    const voiceStateFor = (who: { id: string; username: string; display_name: string }, sharing: boolean) => ({
      user_id: who.id,
      channel_id: lobbyVoice.id,
      guild_id: GUILD_ID,
      session_id: `session-${who.id}`,
      username: who.username,
      display_name: who.display_name,
      avatar_hash: null,
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_stream: sharing,
      self_video: false,
      suppress: false,
    });

    // One image in the timeline, so the "Recently in the shop" strip has
    // something honest to show once the reader has opened the room.
    const photo = {
      id: '9001',
      filename: 'thermal-soak.png',
      size: 512,
      url: '/attachments/9001',
      content_type: 'image/png',
    };
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );

    await page.route(`**/api/v1/guilds/${GUILD_ID}/channels`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify(lobbyChannels),
      }),
    );
    await page.route(`**/api/v1/guilds/${GUILD_ID}/channels/visible`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify({ channel_ids: lobbyChannels.map((c) => c.id) }),
      }),
    );
    await page.route(`**/api/v1/guilds/${GUILD_ID}/members`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify(lobbyMembers),
      }),
    );
    await page.route('**/api/v1/attachments/9001', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: pixel }),
    );
    const lobbyMessages = messages.map((m, i) =>
      i === 0 ? { ...m, attachments: [photo] } : m,
    );
    await page.route(`**/api/v1/channels/${TEXT_CHANNEL_ID}/messages`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify(lobbyMessages),
      }),
    );
    // The durable runtime only surfaces a message the recovery feed confirms, so
    // the attachment has to survive that round trip too — otherwise the strip is
    // empty for the same reason it would be against a real server.
    await page.route(`**/api/v1/channels/${TEXT_CHANNEL_ID}/messages/recovery*`, (route) => {
      const requested = new URL(route.request().url());
      const after = requested.searchParams.get('after') ?? '0';
      const knownIds = (requested.searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify({
          database_history_epoch: historyEpoch,
          channel_id: TEXT_CHANNEL_ID,
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
            message: { ...lobbyMessages.find((m) => m.id === id), message_revision: after },
          })),
        }),
      });
    });

    let calendar: unknown[] = [];
    await page.route(`**/api/v1/guilds/${GUILD_ID}/events`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': historyEpoch },
        body: JSON.stringify(calendar),
      }),
    );

    /**
     * Replace the realtime stream with one that actually delivers frames.
     * `connectionManager` opens a `window.EventSource`; this is one, and it
     * replays whatever `window.__pcStream` holds at navigation time.
     */
    await page.addInitScript(() => {
      const globalWindow = window as unknown as {
        __pcStream?: { once: unknown[]; repeat: unknown[] };
        EventSource: unknown;
      };
      class DesignEventSource {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
        readyState = 1;
        withCredentials = true;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        private timer: ReturnType<typeof setInterval> | null = null;
        constructor(readonly url: string) {
          setTimeout(() => {
            if (this.readyState !== 1) return;
            this.onopen?.(new Event('open'));
            const stream = globalWindow.__pcStream ?? { once: [], repeat: [] };
            for (const frame of stream.once) this.emit(frame);
            const beat = () => {
              for (const frame of (globalWindow.__pcStream?.repeat ?? [])) this.emit(frame);
            };
            beat();
            this.timer = setInterval(beat, 3_000);
          }, 120);
        }
        private emit(frame: unknown) {
          if (this.readyState !== 1) return;
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
        }
        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() { return true; }
        close() {
          this.readyState = 2;
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
        }
      }
      globalWindow.EventSource = DesignEventSource;
    });

    const setStream = async (once: unknown[], repeat: unknown[]) => {
      await page.addInitScript(
        (stream) => {
          (window as unknown as { __pcStream: unknown }).__pcStream = stream;
        },
        { once, repeat },
      );
    };

    const readyFrame = (
      voiceStates: unknown[],
      presences: Array<{ user_id: string; status: string }>,
    ) => ({
      op: 0,
      s: 1,
      t: 'READY',
      d: {
        session_id: 'design-session',
        database_history_epoch: historyEpoch,
        user: { id: user.id, username: user.username, display_name: user.display_name },
        guilds: [
          {
            id: GUILD_ID,
            name: 'Kestrel Robotics',
            owner_id: user.id,
            icon_hash: null,
            member_count: 61,
            created_at: nowIso,
            channels: lobbyChannels,
            voice_states: voiceStates,
            presences: presences.map((p) => ({ ...p, activities: [] })),
          },
        ],
      },
    });

    const typingFrame = (channelId: string, userId: string) => ({
      op: 0,
      t: 'TYPING_START',
      d: { channel_id: channelId, user_id: userId, guild_id: GUILD_ID },
    });

    /**
     * The media strip and a text room's preview show what THIS client has
     * loaded, so a lobby reached by a fresh page load has neither — which is
     * true of the running app too. `viaRoom` walks the honest path instead:
     * open the text room, then return to the lobby the way the app does, with
     * a client-side navigation rather than a reload that would empty the store.
     */
    const shootLobby = async (name: string, viaRoom: boolean) => {
      for (const [label, viewport] of [
        ['1440x900', DESKTOP],
        ['390x844', PHONE],
      ] as const) {
        await page.setViewportSize(viewport);
        if (viaRoom) {
          await page.goto(`/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`);
          await page.waitForTimeout(1_500);
          await page.evaluate((url) => {
            window.history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }, `/app/guilds/${GUILD_ID}`);
        } else {
          await page.goto(`/app/guilds/${GUILD_ID}`);
        }
        await expect(page.getByRole('region', { name: 'Rooms', exact: true })).toBeVisible();
        await shoot(`lobby-${name}-${label}`);
      }
    };

    // --- the lit building --------------------------------------------------
    calendar = [
      {
        id: '7001',
        guild_id: GUILD_ID,
        channel_id: lobbyVoice.id,
        creator_id: cast[1].id,
        name: 'Thermal test — driver v3',
        description: null,
        scheduled_start: new Date(Date.now() + 90 * 60_000).toISOString(),
        scheduled_end: null,
        status: 1,
        entity_type: 1,
        location: null,
        image_url: null,
        user_count: 6,
        user_rsvp: false,
        created_at: nowIso,
      },
    ];
    await setStream(
      [
        readyFrame(
          [voiceStateFor(cast[0], true), voiceStateFor(cast[1], false), voiceStateFor(cast[2], false)],
          [
            ...cast.slice(0, 5).map((who) => ({ user_id: who.id, status: 'online' })),
            { user_id: cast[5].id, status: 'idle' },
          ],
        ),
      ],
      [typingFrame(TEXT_CHANNEL_ID, cast[3].id), typingFrame(TEXT_CHANNEL_ID, cast[4].id)],
    );

    await shootLobby('lit', true);

    // --- the same building, all dark --------------------------------------
    calendar = [];
    await setStream(
      [readyFrame([], cast.map((who) => ({ user_id: who.id, status: 'offline' })))],
      [],
    );
    await shootLobby('dark', false);
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* WP6 — Home (§7.5).                                                       */
  /*                                                                        */
  /* Two scenarios, because Home's whole job is to look different when the   */
  /* lights are on: a **lit evening** (a room talking, people reading, an    */
  /* event tonight, work waiting) and an **all-quiet morning** (the same two */
  /* buildings, nobody in). Opt in with                                      */
  /*   PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp6 npx playwright test  */
  /*                                                                        */
  /* The light comes from the gateway, not from REST, so the realtime stream */
  /* is served here as a finite SSE body carrying READY plus the presence,   */
  /* voice and typing frames the scenario needs. It is the same wire format  */
  /* `e2e/realtime-stub.mjs` serves; only the contents differ.               */
  /* ---------------------------------------------------------------------- */
  if (WP === 'wp6') {
    const SALT_ID = '1002';
    const KESTREL_TEXT = ['2001', '2005', '2006', '2007', '2008'];
    const KESTREL_VOICE = ['2002', '2009', '2010'];
    const SALT_TEXT = ['2101', '2103'];
    const SALT_VOICE = ['2102'];

    const person = (id: number, username: string, display: string) => ({
      ...user,
      id: String(id),
      username,
      display_name: display,
      email: `${username}@example.test`,
    });
    const CAST = [
      person(101, 'mara.okafor', 'Mara Okafor'),
      person(102, 'priya.raman', 'Priya Raman'),
      person(103, 'ren.ishikawa', 'Ren Ishikawa'),
      person(104, 'tomas.lindqvist', 'Tomas Lindqvist'),
      person(105, 'aisha.kone', 'Aisha Kone'),
      person(106, 'jonas.berg', 'Jonas Berg'),
      person(107, 'devon.park', 'Devon Park'),
    ];
    // Enough members for the counts in the reference render to be real.
    const extras = Array.from({ length: 17 }, (_, i) =>
      person(200 + i, `member.${i}`, `Member ${i + 1}`),
    );
    const member = (u: typeof user) => ({
      user: u,
      user_id: u.id,
      roles: [],
      joined_at: nowIso,
      deaf: false,
      mute: false,
    });
    const KESTREL_MEMBERS = [...CAST, ...extras].map(member);
    const SALT_MEMBERS = CAST.slice(2, 7).map(member);

    const channel = (
      id: string,
      guild_id: string,
      name: string,
      type: number,
      position: number,
    ) => ({ ...textChannel, id, guild_id, name, type, channel_type: type, position });

    const kestrelChannels = [
      channel('2002', GUILD_ID, 'Shop floor', 2, 0),
      channel('2009', GUILD_ID, 'Paint booth', 2, 1),
      channel('2010', GUILD_ID, 'Quiet room', 2, 2),
      channel('2001', GUILD_ID, 'build-log', 0, 3),
      channel('2005', GUILD_ID, 'general', 0, 4),
      channel('2006', GUILD_ID, 'parts-orders', 0, 5),
      channel('2007', GUILD_ID, 'shop-safety', 0, 6),
      channel('2008', GUILD_ID, 'off-topic', 0, 7),
    ];
    const saltChannels = [
      channel('2102', SALT_ID, 'Clubhouse', 2, 0),
      channel('2101', SALT_ID, 'regatta-2026', 0, 1),
      channel('2103', SALT_ID, 'crew-list', 0, 2),
    ];

    const eventToday = {
      id: '5001',
      guild_id: GUILD_ID,
      channel_id: '2002',
      creator_id: user.id,
      name: 'Thermal test — driver v3',
      description: null,
      scheduled_start: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      scheduled_end: null,
      status: 1,
      entity_type: 1,
      location: null,
      image_url: null,
      user_count: 6,
      user_rsvp: false,
      created_at: nowIso,
    };

    type Scenario = 'lit' | 'quiet';
    let scenario: Scenario = 'lit';

    const frame = (t: string, d: unknown) =>
      `event: gateway\ndata: ${JSON.stringify({ op: 0, t, d })}\n\n`;

    const realtimeBody = () => {
      // A long retry so a finished body does not become a reconnect storm.
      let body = 'retry: 600000\n\n';
      body += frame('READY', {
        session_id: 'design-session',
        database_history_epoch: historyEpoch,
        user: { id: user.id },
        guilds: [],
      });
      const lit = scenario === 'lit';
      for (const [index, who] of [...CAST, ...extras].entries()) {
        const status = lit
          ? who.id === '107'
            ? 'idle'
            : 'online'
          : index === 0
            ? 'idle'
            : 'offline';
        body += frame('PRESENCE_UPDATE', { user_id: who.id, status, activities: [] });
      }
      if (lit) {
        const inRoom = [
          { who: CAST[0], self_stream: true },
          { who: CAST[1], self_stream: false },
          { who: CAST[2], self_stream: false },
        ];
        for (const { who, self_stream } of inRoom) {
          body += frame('VOICE_STATE_UPDATE', {
            user_id: who.id,
            channel_id: '2002',
            guild_id: GUILD_ID,
            session_id: `s-${who.id}`,
            deaf: false,
            mute: false,
            self_deaf: false,
            self_mute: false,
            self_stream,
            self_video: false,
            suppress: false,
            username: who.username,
            display_name: who.display_name,
            avatar_hash: null,
          });
        }
        for (const [channelId, ids] of [
          ['2001', ['104', '105']],
          ['2005', ['106']],
          ['2101', ['103']],
        ] as const) {
          for (const id of ids) {
            body += frame('TYPING_START', { channel_id: channelId, user_id: id });
          }
        }
      }
      return body;
    };

    if (!process.env.PARACORD_WP6_NO_RT)
    await page.route('**/api/v2/rt/events**', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: realtimeBody(),
      }),
    );

    // Scenario-specific REST, added last so it wins over the base handler.
    await page.route('**/api/v1/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (payload: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'X-Paracord-History-Epoch': historyEpoch },
          body: JSON.stringify(payload),
        });

      if (pathname === '/api/v1/users/@me/guilds') {
        return json([
          guildSummaryFixture({
            id: GUILD_ID,
            name: 'Kestrel Robotics',
            server_url: 'https://design.paracord.local',
            owner_id: user.id,
            member_count: 61,
            created_at: nowIso,
          }),
          guildSummaryFixture({
            id: SALT_ID,
            name: 'Saltmarsh Sailing',
            server_url: 'https://design.paracord.local',
            owner_id: user.id,
            member_count: 20,
            created_at: nowIso,
          }),
        ]);
      }
      if (pathname === `/api/v1/guilds/${SALT_ID}`) {
        return json(
          guildDetailFixture({
            id: SALT_ID,
            name: 'Saltmarsh Sailing',
            server_url: 'https://design.paracord.local',
            owner_id: user.id,
            member_count: 20,
            created_at: nowIso,
          }),
        );
      }
      if (pathname === `/api/v1/guilds/${GUILD_ID}/channels`) return json(kestrelChannels);
      if (pathname === `/api/v1/guilds/${SALT_ID}/channels`) return json(saltChannels);
      if (pathname === `/api/v1/guilds/${GUILD_ID}/channels/visible`)
        return json({ channel_ids: [...KESTREL_TEXT, ...KESTREL_VOICE] });
      if (pathname === `/api/v1/guilds/${SALT_ID}/channels/visible`)
        return json({ channel_ids: [...SALT_TEXT, ...SALT_VOICE] });
      if (pathname === `/api/v1/guilds/${GUILD_ID}/members`) return json(KESTREL_MEMBERS);
      if (pathname === `/api/v1/guilds/${SALT_ID}/members`) return json(SALT_MEMBERS);
      if (pathname === `/api/v1/guilds/${GUILD_ID}/events`)
        return json(scenario === 'lit' ? [eventToday] : []);
      if (pathname === '/api/v1/users/@me/read-states')
        return json(
          scenario === 'lit'
            ? [
                { channel_id: '2001', last_message_id: '3000', mention_count: 1 },
                { channel_id: '2101', last_message_id: '3000', mention_count: 0 },
              ]
            : [],
        );
      if (pathname === '/api/v1/users/@me/relationships')
        return json(
          scenario === 'lit'
            ? [
                {
                  id: `${CAST[6].id}:${user.id}`,
                  user_id: CAST[6].id,
                  target_id: user.id,
                  type: 3,
                  rel_type: 3,
                  created_at: nowIso,
                  user: {
                    id: CAST[6].id,
                    username: CAST[6].username,
                    display_name: CAST[6].display_name,
                    discriminator: 1,
                    avatar_hash: null,
                  },
                },
              ]
            : [],
        );
      if (pathname.endsWith('/messages/attention')) {
        const channelId = pathname.split('/')[4];
        return json({
          channel_id: channelId,
          user_id: user.id,
          kind: new URL(route.request().url()).searchParams.get('kind'),
          message: {
            id: '3010',
            channel_id: channelId,
            author: CAST[1],
            content: 'thermal rig is booked 1–3 pm',
            created_at: nowIso,
            attachments: [],
            reactions: [],
          },
        });
      }
      return route.fallback();
    });

    // The very first load of a fresh profile learns the database-history epoch
    // from the first response header. Learning it EXPIRES every operation
    // captured before it was known — including the one-shot guild fetch, which
    // is never retried. Warm the epoch into localStorage first, then shoot.
    await page.goto('/app');
    await page.waitForTimeout(1200);

    for (const [label, when, clock] of [
      ['lit-evening', 'lit', '2026-09-12T21:30:00'],
      ['quiet-morning', 'quiet', '2026-09-12T08:30:00'],
    ] as const) {
      scenario = when as Scenario;
      await page.clock.setFixedTime(new Date(clock));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.text()); });
      page.on('requestfailed', (r) => console.log('[failed]', r.url(), r.failure()?.errorText));
      page.on('response', async (r) => {
        if (r.url().includes('/users/@me/guilds')) {
          console.log('[guilds]', r.status(), (await r.text().catch(() => '')).slice(0, 300));
        }
      });
      for (const [size, viewport] of [
        ['1440x900', DESKTOP],
        ['390x844', PHONE],
      ] as const) {
        await page.setViewportSize(viewport);
        await page.goto('/app');
        await expect(page.getByRole('main')).toBeVisible();
        await expect(page.getByRole('main').getByText('Your buildings')).toBeVisible();
        await shoot(`home-${label}-${size}`);
      }
    }
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* WP3 — the Stage (§7.2).                                                 */
  /*                                                                        */
  /* A live call cannot exist in a mocked browser — there is no media server */
  /* on the other end — so the Stage is captured from `/design-stage`, the   */
  /* dev-only route that hands the real components the same models a call    */
  /* hands them. Four states, both viewports. Opt in with                    */
  /*   PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp3 npx playwright test  */
  /* ---------------------------------------------------------------------- */
  if (WP === 'wp3') {
    const states = ['share', 'speakers', 'joining', 'reconnecting'] as const;

    for (const [label, viewport] of [
      ['1440x900', DESKTOP],
      ['390x844', PHONE],
    ] as const) {
      await page.setViewportSize(viewport);
      const phone = viewport === PHONE;

      for (const state of states) {
        await page.goto(`/design-stage?state=${state}${phone ? '&phone=1' : ''}`);
        await expect(page.getByRole('heading', { name: 'Shop floor' })).toBeVisible();
        await shoot(`stage-${state}-${label}`);
      }

      // The room's own pre-join surface, on the real route: the Lobby a voice
      // room shows before you are in it.
      await page.goto(`/app/guilds/${GUILD_ID}/channels/${voiceChannel.id}`);
      await expect(page.getByRole('main')).toBeVisible();
      await shoot(`stage-lobby-${label}`);
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
    'My account',
    'Appearance',
    'Voice & video',
    'Notifications',
    'Activity privacy',
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
        const boundary = page.getByText('Something broke on our end');
        if (await boundary.count()) {
          await page.getByRole('group').first().click({ timeout: 3_000 }).catch(() => undefined);
          const detail = await page.locator('pre').first().innerText().catch(() => '');
          missed.push(`${name}-${label}: error boundary — ${detail.slice(0, 600)}`);
        }
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
        const phoneRow = page.getByRole('button', { name: 'Voice & video', exact: true });
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
    // Only the first-owner claim screen belongs to an unclaimed server; every
    // other entry screen redirects to it while `setup_required` is true.
    setupRequired = name === 'auth-setup-server';
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
