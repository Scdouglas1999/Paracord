import { expect, type Page } from '@playwright/test';
import { guildDetailFixture, guildSummaryFixture } from '../../src/test/guildContractFixtures';
import { isGuildDetail, isGuildSummaryList } from '../../src/api/generated/validators';

/**
 * The mocked world the default CI gate (`e2e/smoke.spec.ts`) walks.
 *
 * Every `/api` call is intercepted with `page.route`, so the gate never touches
 * a real server. One account, one server with a deliberately long name (the
 * sidebar has to truncate it without breaking the layout), three channels (a
 * text channel with a long name, a voice channel, and a second text channel
 * with something unread), and two direct messages.
 *
 * What is proved here that a fixture could quietly stop proving:
 *   - the account is the real `CurrentUser` projection, because the client
 *     verifies it against the generated contract before it uses it at all;
 *   - every 200 the client gets for the guild list and a guild is validated
 *     against the generated contract, and `validated` counts them, so a spec can
 *     assert the validators actually ran (an unused validator proves nothing);
 *   - a sent message is echoed with its `nonce` and the authoritative recovery
 *     feed can answer for every message the fixture has ever served, exactly as
 *     the real server does: the durable-delivery runtime publishes no row that
 *     feed has not confirmed.
 *
 * It is the same world for every test: each test installs its own copy through
 * `installSmokeApp` and gets a handle for the parts a test changes mid-run.
 */

export const GUILD_ID = '1001';
export const TEXT_CHANNEL_ID = '2001';
export const VOICE_CHANNEL_ID = '2002';
export const ATTENTION_CHANNEL_ID = '2003';

/**
 * The fixture server is named at length on purpose. Every locator that names it
 * uses this constant, so an assertion matches the whole accessible name rather
 * than a prefix that silently stops matching.
 */
export const GUILD_NAME =
  'QA Guild With A Very Long Name That Should Truncate Instead Of Breaking Layout';
export const TEXT_CHANNEL_NAME = 'qa-general-channel-with-a-very-long-name-for-overflow-coverage';
export const VOICE_CHANNEL_NAME = 'Voice Lounge';
export const ATTENTION_CHANNEL_NAME = 'updates';

/** The composer's placeholder: "Message #name", or a generic prompt when the name is long. */
export const COMPOSER_PLACEHOLDER = /^(Message #qa-general-channel|Message |Write a message$)/;

/** `name:` accepts a RegExp; a literal fixture string has to be escaped for it. */
export const literal = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const HISTORY_EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export type HeaderAttention = 'read' | 'unread' | 'mentions';

/** The parts of the world a test changes while it runs. */
export interface SmokeApp {
  /** What `GET /users/@me/settings` says the theme is (an opaque string to the server). */
  serverTheme: string;
  /** Takes send, poll, attach and schedule away from every channel. */
  compositionRevoked: boolean;
  /** What the read states say about the `updates` channel. */
  headerAttention: HeaderAttention;
  /** Serves the two direct messages. */
  showDmFixtures: boolean;
  /** Everything the fixture has accepted as a message. */
  readonly messages: Array<Record<string, unknown>>;
  /** `GET /admin/stats` calls: a person without the admin flag must cause none. */
  adminStatsRequests: number;
  /** Voice join and leave requests the page made, in order. */
  readonly voiceRequests: string[];
  /** Responses the contract validators were run on. */
  readonly validated: { guildList: number; guild: number };
  /** Uncaught errors the page raised. */
  readonly pageErrors: string[];
  readonly user: typeof userPayload;
  readonly peer: typeof peerPayload;
  readonly dmFixtures: Array<Record<string, unknown> & { id: string; type: number }>;
}

const nowIso = new Date().toISOString();

/**
 * The mocked account must match the real `CurrentUser` projection: the client
 * verifies it against the generated contract before it will use the account at
 * all, so a short fixture leaves the app with no verified server account.
 */
const userPayload = {
  id: '42',
  username: 'smoke-user-with-a-very-long-unbroken-name-for-overflow-coverage',
  display_name: null,
  discriminator: 1,
  avatar_hash: null,
  banner_hash: null,
  accent_color: null,
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

const peerPayload = { ...userPayload, id: '43', username: 'Ada with a long name for header coverage' };

export async function installSmokeApp(page: Page): Promise<SmokeApp> {
  const served = new Map<string, Record<string, unknown>>();
  let messageCounter = 1;

  const attentionChannel = {
    id: ATTENTION_CHANNEL_ID,
    guild_id: GUILD_ID,
    name: ATTENTION_CHANNEL_NAME,
    type: 0,
    channel_type: 0,
    position: 2,
    nsfw: false,
    created_at: nowIso,
    last_message_id: '4000',
  };
  const dmFixtures = [
    { id: '2004', type: 1, channel_type: 1, recipient: peerPayload, recipients: [peerPayload], position: 0, nsfw: false, created_at: nowIso },
    {
      id: '2005',
      type: 3,
      channel_type: 3,
      name: 'Design discussion with a long group title',
      recipients: [userPayload, peerPayload],
      position: 0,
      nsfw: false,
      created_at: nowIso,
    },
  ];

  const app: SmokeApp = {
    serverTheme: 'glass',
    compositionRevoked: false,
    headerAttention: 'read',
    showDmFixtures: false,
    messages: [],
    adminStatsRequests: 0,
    voiceRequests: [],
    validated: { guildList: 0, guild: 0 },
    pageErrors: [],
    user: userPayload,
    peer: peerPayload,
    dmFixtures,
  };

  // This spec never signs in through the form: it opens /app directly and lets
  // the mocked POST /auth/refresh hand it a session, the way a returning
  // browser with a refresh cookie does. Since `685a6bf` the client no longer
  // makes that request on a cold load unless this origin has held a session
  // before (an anonymous visitor used to spend a 401 and a console error on
  // every page view), so the browser has to carry the same marker a real
  // returning browser would (`src/lib/authToken.ts`, `noteSessionEstablished`).
  // Without it the app is correctly anonymous and the whole flow lands on /login.
  //
  // A returning browser also remembers which database history it last saw
  // (`src/lib/databaseHistory.ts`). Without it the first READY adopts the epoch
  // and, by design, expires every request still in flight, which here is the
  // guild list (this READY carries no guilds, the real server's does), and the
  // places panel would say "This server is not available" until a reload.
  await page.addInitScript(
    ({ epoch, scopeKey, guildId }) => {
      try {
        localStorage.setItem('paracord:auth:session-seen', '1');
        localStorage.setItem(`paracord:database-history:${scopeKey}`, epoch);
        // First-run surfaces stay out of the way; the gate is about the product, not its welcome.
        localStorage.setItem('paracord:v2:layout-tour-shell', 'done');
        localStorage.setItem('paracord:v2:layout-tour-guild-home', 'done');
        localStorage.setItem('paracord:v2:onboarding-complete', '1');
        // The server's own welcome (a first visit) is not what this gate is about.
        localStorage.setItem(`paracord:v2:guild-welcomed:${guildId}`, '1');
      } catch {
        // A browser refusing storage keeps the old ask-and-see behavior anyway.
      }
    },
    { epoch: HISTORY_EPOCH, scopeKey: JSON.stringify(['__local__', userPayload.id]), guildId: GUILD_ID },
  );

  page.on('pageerror', (error) => {
    app.pageErrors.push(error.message);
  });
  if (process.env.PARACORD_E2E_DEBUG) {
    page.on('console', (message) => console.log(`[browser:${message.type()}]`, message.text()));
  }

  await page.route('**/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    const json = (status: number, payload: unknown) => {
      if (status === 200 && method === 'GET') {
        if (path === '/api/v1/users/@me/guilds') {
          expect(isGuildSummaryList(payload)).toBe(true);
          app.validated.guildList += 1;
        }
        if (/^\/api\/v1\/guilds\/[^/]+$/.test(path)) {
          expect(isGuildDetail(payload)).toBe(true);
          app.validated.guild += 1;
        }
      }
      // The authoritative recovery feed must be able to answer for every message
      // this fixture has ever shown, exactly as the real server does.
      if (/\/messages$/.test(path)) {
        for (const value of Array.isArray(payload) ? payload : [payload]) {
          const message = value as { id?: unknown; channel_id?: unknown; author?: unknown };
          if (message && typeof message.id === 'string' && typeof message.channel_id === 'string' && message.author) {
            served.set(message.id, message as Record<string, unknown>);
          }
        }
      }
      return route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
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
      const missing = knownIds.filter((id) => !served.has(id));
      if (missing.length) return json(500, { message: `The smoke fixture has no authoritative state for ${missing.join(',')}` });
      return json(200, {
        database_history_epoch: HISTORY_EPOCH,
        channel_id: channelId,
        after,
        through: after,
        floor: '0',
        next: after,
        complete: true,
        projection_head: after,
        changes: [],
        states: knownIds.map((id) => ({ message_id: id, state: 'present', revision: after, message: { ...served.get(id), message_revision: after } })),
      });
    }
    if (path.endsWith('/messages/attention') && method === 'GET') {
      const id = path.split('/')[4];
      const message = { id: '4000', channel_id: id, author: userPayload, content: 'An update waiting for you.', attachments: [], reactions: [] };
      return json(200, { channel_id: id, user_id: userPayload.id, kind: url.searchParams.get('kind'), message });
    }
    if (path === '/api/v1/auth/refresh' && method === 'POST') {
      return json(200, { token: 'smoke-token', refresh_token: 'smoke-refresh', user: userPayload });
    }
    if (path === '/api/v1/auth/login' && method === 'POST') {
      return json(200, { token: 'smoke-token', user: userPayload });
    }
    if (path === '/api/v1/users/@me' && method === 'GET') return json(200, userPayload);
    if (path.endsWith('/capabilities') && path.startsWith('/api/v1/channels/') && method === 'GET') {
      const revoked = ['send', 'poll', 'attach', 'schedule'];
      return json(200, {
        version: 1,
        channel_id: path.split('/')[4],
        user_id: userPayload.id,
        encrypted: false,
        own_identity_enrolled: false,
        peers_ready: true,
        actions: Object.fromEntries(
          ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => {
            const refused = app.compositionRevoked && revoked.includes(action);
            return [action, { supported: true, allowed: !refused, reason: refused ? 'Your role no longer allows posting in this channel.' : null }];
          }),
        ),
      });
    }
    if (path === '/api/v1/users/@me/dms' && method === 'GET') return json(200, app.showDmFixtures ? dmFixtures : []);
    if (path === '/api/v1/users/@me/reminders' && method === 'GET') return json(200, { items: [] });
    if (path === `/api/v1/guilds/${GUILD_ID}/feed` && method === 'GET') return json(200, { items: [], next_cursor: null });
    if (path === `/api/v1/guilds/${GUILD_ID}/attachments` && method === 'GET') return json(200, { items: [], next_cursor: null });
    if (app.showDmFixtures && method === 'GET') {
      const dm = dmFixtures.find((item) => path === `/api/v1/channels/${item.id}` || path === `/api/v1/channels/${item.id}/recipients`);
      if (dm) return json(200, path.endsWith('/recipients') ? dm.recipients : dm);
    }
    if (path === '/api/v1/users/@me/read-states' && method === 'GET') {
      return json(200, [
        {
          channel_id: attentionChannel.id,
          last_message_id: app.headerAttention === 'read' ? '4000' : '3999',
          mention_count: app.headerAttention === 'mentions' ? 3 : 0,
        },
      ]);
    }
    if (path === `/api/v1/channels/${attentionChannel.id}/messages` && method === 'GET') {
      return json(200, [{ id: '4000', channel_id: attentionChannel.id, author: userPayload, content: 'An update waiting for you.', created_at: nowIso, attachments: [], reactions: [] }]);
    }
    if (path === '/api/v1/users/@me/settings' && method === 'GET') {
      return json(200, {
        user_id: userPayload.id,
        theme: app.serverTheme,
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
    if (path === '/api/v1/users/@me/notification-settings' && method === 'GET') return json(200, { spaces: [], channels: [] });
    if (path === '/api/v1/users/@me/guilds' && method === 'GET') {
      return json(200, [
        guildSummaryFixture({
          id: GUILD_ID,
          name: GUILD_NAME,
          server_url: 'https://smoke.paracord.local',
          owner_id: userPayload.id,
          member_count: 4,
          created_at: nowIso,
        }),
      ]);
    }
    if (path === `/api/v1/guilds/${GUILD_ID}/channels/visible` && method === 'GET') {
      return json(200, { channel_ids: [TEXT_CHANNEL_ID, VOICE_CHANNEL_ID, attentionChannel.id] });
    }
    // What the places panel shows under each channel's name: the newest message
    // of every channel that has one (an empty channel has no entry).
    if (path === `/api/v1/guilds/${GUILD_ID}/channel-previews` && method === 'GET') {
      const preview = (channelId: string, messageId: string, content: string) => ({
        channel_id: channelId,
        message_id: messageId,
        message_type: 0,
        author_id: peerPayload.id,
        author_kind: 'user',
        author_name: 'Ada',
        content,
        truncated: false,
        encrypted: false,
        created_at: nowIso,
        media: null,
        attachment_count: 0,
        has_sticker: false,
      });
      return json(200, [
        preview(TEXT_CHANNEL_ID, '3900', 'Kickoff is at nine, bring a chair.'),
        preview(attentionChannel.id, '4000', 'An update waiting for you.'),
      ]);
    }
    if ((path === `/api/v1/channels/${TEXT_CHANNEL_ID}` || path === `/api/v1/channels/${VOICE_CHANNEL_ID}`) && method === 'GET') {
      const isVoice = path.endsWith(`/${VOICE_CHANNEL_ID}`);
      return json(200, {
        id: isVoice ? VOICE_CHANNEL_ID : TEXT_CHANNEL_ID,
        guild_id: GUILD_ID,
        name: isVoice ? VOICE_CHANNEL_NAME : TEXT_CHANNEL_NAME,
        type: isVoice ? 2 : 0,
        channel_type: isVoice ? 2 : 0,
        position: isVoice ? 1 : 0,
        nsfw: false,
        parent_id: null,
        required_role_ids: [],
        created_at: nowIso,
      });
    }
    if (path === `/api/v1/guilds/${GUILD_ID}/channels` && method === 'GET') {
      return json(200, [
        attentionChannel,
        {
          id: TEXT_CHANNEL_ID,
          guild_id: GUILD_ID,
          name: TEXT_CHANNEL_NAME,
          type: 0,
          channel_type: 0,
          position: 0,
          nsfw: false,
          parent_id: null,
          required_role_ids: [],
          created_at: nowIso,
        },
        {
          id: VOICE_CHANNEL_ID,
          guild_id: GUILD_ID,
          name: VOICE_CHANNEL_NAME,
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
    if (path === `/api/v1/guilds/${GUILD_ID}` && method === 'GET') {
      return json(
        200,
        guildDetailFixture({
          id: GUILD_ID,
          name: GUILD_NAME,
          server_url: 'https://smoke.paracord.local',
          owner_id: userPayload.id,
          member_count: 4,
          created_at: nowIso,
        }),
      );
    }
    if (path === `/api/v1/guilds/${GUILD_ID}/onboarding/me` && method === 'GET') {
      return json(200, {
        settings: {
          welcome_title: `Welcome to ${GUILD_NAME}`,
          welcome_body: 'Quick start onboarding',
          rules_text: null,
          role_prompt: null,
          role_options: [],
        },
        member_state: { accepted_rules: true, selected_role_ids: [], completed_at: nowIso },
      });
    }
    if (path === `/api/v1/guilds/${GUILD_ID}/onboarding/me` && method === 'PATCH') {
      const payload = request.postDataJSON() as { accepted_rules?: boolean; selected_role_ids?: string[]; completed?: boolean };
      return json(200, {
        accepted_rules: Boolean(payload?.accepted_rules),
        selected_role_ids: payload?.selected_role_ids ?? [],
        completed_at: payload?.completed ? nowIso : null,
      });
    }
    if (path === `/api/v1/channels/${TEXT_CHANNEL_ID}/messages` && method === 'GET') return json(200, app.messages);
    if (path === `/api/v1/channels/${TEXT_CHANNEL_ID}/messages` && method === 'POST') {
      const payload = request.postDataJSON() as { content?: string; nonce?: string };
      const message = {
        id: `${3000 + messageCounter++}`,
        channel_id: TEXT_CHANNEL_ID,
        author: {
          id: userPayload.id,
          username: userPayload.username,
          discriminator: userPayload.discriminator,
          avatar_hash: null,
        },
        content: payload?.content ?? '',
        // The transport matches its own send on this; a fixture that forgets it
        // leaves the message queued forever and the row never lands.
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
      app.messages.push(message);
      return json(201, message);
    }
    if (path === `/api/v1/channels/${TEXT_CHANNEL_ID}/typing` && method === 'POST') return route.fulfill({ status: 204 });
    if (path === `/api/v1/channels/${TEXT_CHANNEL_ID}/read` && method === 'PUT') {
      return json(200, { channel_id: TEXT_CHANNEL_ID, last_message_id: app.messages.at(-1)?.id ?? null, mention_count: 0 });
    }
    if (path === `/api/v1/channels/${VOICE_CHANNEL_ID}/messages` && method === 'GET') return json(200, []);
    if (path === `/api/v1/guilds/${GUILD_ID}/members` && method === 'GET') return json(200, []);
    if (path === `/api/v1/guilds/${GUILD_ID}/economy/leaderboard` && method === 'GET') {
      return json(200, { guild_id: GUILD_ID, entries: [], limit: 8 });
    }
    if (path === `/api/v1/guilds/${GUILD_ID}/economy/me` && method === 'GET') {
      return json(200, {
        guild_id: GUILD_ID,
        user_id: userPayload.id,
        xp: 0,
        level: 0,
        rank: null,
        last_xp_at: nowIso,
        progress: { current_level_floor: 0, next_level_at: 100, xp_into_level: 0, xp_required_this_level: 100 },
        streak: { days: 0, longest_days: 0, last_active_date: nowIso.slice(0, 10) },
        achievements: [],
      });
    }
    if (path === `/api/v1/guilds/${GUILD_ID}/economy/level-roles` && method === 'GET') {
      return json(200, { guild_id: GUILD_ID, mappings: [] });
    }
    if (path === '/api/v1/discovery/guilds' && method === 'GET') return json(200, { guilds: [], total: 0 });
    if (path === '/api/v1/templates' && method === 'GET') return json(200, []);
    if (path === '/api/v1/bots/applications' && method === 'GET') return json(200, []);
    if (path === '/api/v1/admin/stats' && method === 'GET') {
      app.adminStatsRequests += 1;
      return json(403, { error: 'admin required' });
    }

    if (method === 'GET') return json(200, []);
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/api/v2/rt/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ws_url: 'ws://127.0.0.1:0/gateway', session_id: 'smoke-session', token: 'smoke-rt-token' }),
    });
  });
  // The realtime stream is served by e2e/realtime-stub.mjs through the dev
  // proxy so READY arrives on one connection that stays open.
  await page.route('**/api/v2/rt/commands', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
  // There is no media relay behind a mocked page, so a join is refused. What the
  // product must do with a refusal (say so, stay out of the call, leave the pill
  // where it was) is what the voice test asserts.
  //
  // Every answer carries the history epoch, as the real server's do: a reply
  // without it, to a request that named one, is read as the database having
  // changed, and the call is closed without a word.
  await page.route('**/api/v2/voice/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'X-Paracord-History-Epoch': HISTORY_EPOCH };
    if (path.endsWith('/join')) {
      app.voiceRequests.push(`join ${path.split('/')[4]}`);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers,
        body: JSON.stringify({ message: 'Voice unavailable in smoke harness' }),
      });
      return;
    }
    if (path.endsWith('/leave')) app.voiceRequests.push(`leave ${path.split('/')[4]}`);
    await route.fulfill({ status: 204, headers, body: '' });
  });

  return app;
}

/** The page has no horizontal scroll: nothing pokes out of the window. */
export const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
