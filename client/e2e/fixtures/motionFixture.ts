import type { Page } from '@playwright/test';

import { guildDetailFixture, guildSummaryFixture } from '../../src/test/guildContractFixtures';

/**
 * The mocked world the motion gate drives (`e2e/motion-gate.spec.ts`).
 *
 * It is the smoke fixture's shape, trimmed to the one moment the gate measures:
 * a signed-in account, one building, one text room, and a send that actually
 * completes. The send is the load-bearing part — §5.1's "a message has mass"
 * only exists if a message can leave the composer and a row can land — so the
 * two routes that make that possible are exactly the smoke's:
 *
 *   · `POST /channels/:id/messages` echoes the request `nonce` back, which is
 *     how the durable-delivery transport recognises its own send;
 *   · `GET  /channels/:id/messages/recovery` can vouch for every message the
 *     fixture has ever served, including the one just posted — the runtime will
 *     not publish a row the authoritative feed has not confirmed.
 *
 * Every response carries `X-Paracord-History-Epoch`, matching the READY the
 * realtime stub emits; without it no send is ever accepted.
 */

export const MOTION_GUILD_ID = '1001';
export const MOTION_TEXT_CHANNEL_ID = '2001';
export const MOTION_CHANNEL_NAME = 'build-log';
export const MOTION_HISTORY_EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export async function installMotionMocks(page: Page): Promise<void> {
  const nowIso = new Date().toISOString();
  /** Everything the fixture has served on a `/messages` path, by id. */
  const served = new Map<string, Record<string, unknown>>();
  let messageCounter = 1;

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
  const peer = { ...user, id: '43', username: 'priya.raman', display_name: 'Priya Raman' };

  const textChannel = {
    id: MOTION_TEXT_CHANNEL_ID,
    guild_id: MOTION_GUILD_ID,
    name: MOTION_CHANNEL_NAME,
    type: 0,
    channel_type: 0,
    position: 0,
    nsfw: false,
    parent_id: null,
    required_role_ids: [],
    created_at: nowIso,
  };

  const messages: Array<Record<string, unknown>> = [
    {
      id: '3000',
      channel_id: MOTION_TEXT_CHANNEL_ID,
      author: peer,
      content: "thermal rig is booked 1–3 pm. I'll be in the shop if anyone wants to watch it cook.",
      created_at: nowIso,
      timestamp: nowIso,
      attachments: [],
      reactions: [],
    },
  ];

  // The first-run tour and the welcome sheet would sit on top of the composer.
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
    const url = new URL(request.url());
    const path = url.pathname;

    const json = (status: number, payload: unknown) => {
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
        headers: { 'X-Paracord-History-Epoch': MOTION_HISTORY_EPOCH },
        body: JSON.stringify(payload),
      });
    };

    if (path.endsWith('/messages/recovery') && method === 'GET') {
      const channelId = path.split('/')[4];
      const after = url.searchParams.get('after') ?? '0';
      const knownIds = (url.searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
      const missing = knownIds.filter((id) => !served.has(id));
      if (missing.length) {
        return json(500, { message: `The motion fixture has no authoritative state for ${missing.join(',')}` });
      }
      return json(200, {
        database_history_epoch: MOTION_HISTORY_EPOCH,
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
          message: { ...served.get(id), message_revision: after },
        })),
      });
    }

    if (path === `/api/v1/channels/${MOTION_TEXT_CHANNEL_ID}/messages` && method === 'POST') {
      const payload = request.postDataJSON() as { content?: string; nonce?: string };
      const message = {
        id: `${3000 + messageCounter++}`,
        channel_id: MOTION_TEXT_CHANNEL_ID,
        author: { id: user.id, username: user.username, discriminator: user.discriminator, avatar_hash: null },
        content: payload?.content ?? '',
        // The transport matches its own send on this; a fixture that forgets it
        // leaves the message queued forever and the row never lands.
        nonce: payload?.nonce,
        pinned: false,
        type: 0,
        message_type: 0,
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        edited_timestamp: null,
        edited_at: null,
        reference_id: null,
        attachments: [],
        reactions: [],
      };
      messages.push(message);
      return json(201, message);
    }

    if (path === '/api/v1/auth/refresh' && method === 'POST') {
      return json(200, { token: 'motion-token', refresh_token: 'motion-refresh', user });
    }
    if (path === '/api/v1/users/@me' && method === 'GET') return json(200, user);
    if (path === '/api/v1/stream/ticket' && method === 'POST') return json(200, { ticket: 'motion-stream-ticket' });
    if (path.endsWith('/capabilities') && path.startsWith('/api/v1/channels/') && method === 'GET') {
      return json(200, {
        version: 1,
        channel_id: path.split('/')[4],
        user_id: user.id,
        encrypted: false,
        own_identity_enrolled: false,
        peers_ready: true,
        actions: Object.fromEntries(
          ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => [
            action,
            { supported: true, allowed: true, reason: null },
          ]),
        ),
      });
    }
    if (path === '/api/v1/users/@me/settings' && method === 'GET') {
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
    }
    if (path === '/api/v1/users/@me/notification-settings' && method === 'GET') return json(200, { spaces: [], channels: [] });
    if (path === '/api/v1/users/@me/read-states' && method === 'GET') return json(200, []);
    if (path === '/api/v1/users/@me/dms' && method === 'GET') return json(200, []);
    if (path === '/api/v1/users/@me/guilds' && method === 'GET') {
      return json(200, [
        guildSummaryFixture({
          id: MOTION_GUILD_ID,
          name: 'Kestrel Robotics',
          server_url: 'https://motion.paracord.local',
          owner_id: user.id,
          member_count: 24,
          created_at: nowIso,
        }),
      ]);
    }
    if (path === `/api/v1/guilds/${MOTION_GUILD_ID}` && method === 'GET') {
      return json(
        200,
        guildDetailFixture({
          id: MOTION_GUILD_ID,
          name: 'Kestrel Robotics',
          server_url: 'https://motion.paracord.local',
          owner_id: user.id,
          member_count: 24,
          created_at: nowIso,
        }),
      );
    }
    if (path === `/api/v1/guilds/${MOTION_GUILD_ID}/channels` && method === 'GET') return json(200, [textChannel]);
    if (path === `/api/v1/guilds/${MOTION_GUILD_ID}/channels/visible` && method === 'GET') {
      return json(200, { channel_ids: [MOTION_TEXT_CHANNEL_ID] });
    }
    if (path === `/api/v1/channels/${MOTION_TEXT_CHANNEL_ID}` && method === 'GET') return json(200, textChannel);
    if (path === `/api/v1/channels/${MOTION_TEXT_CHANNEL_ID}/messages` && method === 'GET') return json(200, messages);
    if (path === `/api/v1/guilds/${MOTION_GUILD_ID}/onboarding/me` && method === 'GET') {
      return json(200, {
        settings: { welcome_title: 'Kestrel Robotics', welcome_body: null, rules_text: null, role_prompt: null, role_options: [] },
        member_state: { accepted_rules: true, selected_role_ids: [], completed_at: nowIso },
      });
    }
    if (method === 'GET') return json(200, []);
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/api/v2/rt/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ws_url: 'ws://127.0.0.1:0/gateway', session_id: 'motion-session', token: 'motion-rt-token' }),
    }),
  );
  await page.route('**/api/v2/rt/commands', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/v2/voice/**', (route) => route.fulfill({ status: 204, body: '' }));
}
