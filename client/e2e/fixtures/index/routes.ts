/**
 * Every REST call the app makes, answered from the world (`world.ts`) with
 * `page.route`. Nothing here touches a server. Playwright runs the LAST route
 * that matches, so a spec can call `installIndexScene` and then add its own
 * `page.route` for one endpoint (the way a package mocks its own POST).
 *
 * The routes are built on the Glass harness's (`fixtures/glass/install.ts`),
 * which was modeled on a real server, with two differences: they read the live
 * world instead of a constant, so a step's change shows up in the next request,
 * and a few writes the Index packages need are real (read position, sending a
 * message, typing).
 */
import type { Page, Route } from '@playwright/test';
import { guildDetailFixture, guildSummaryFixture } from '../../../src/test/guildContractFixtures';
import { frames, type RealtimeStub } from './gateway';
import { gradientPng } from './png';
import { ATTACHMENTS, DOCK_ORDER, GUILD, ME, type ChannelKey, type PersonKey } from './scene';
import { HISTORY_EPOCH, type IndexWorld } from './world';

const SELF = ME;

export interface RouteOptions {
  /** The realtime stub, so a posted message is announced the way a server announces it. */
  stub: RealtimeStub;
  /** Called with every request no specific route answered (a debugging aid, off by default). */
  onUnhandled?: (method: string, path: string) => void;
}

export async function installRoutes(page: Page, world: IndexWorld, options: RouteOptions): Promise<void> {
  await page.route('**/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const { pathname } = url;
    const json = (payload: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
        body: JSON.stringify(payload),
      });
    // Every API answer carries the history epoch: a reply without it makes the client
    // distrust its database history and reconnect (`lib/databaseHistory.ts`).
    const none = () => route.fulfill({ status: 204, headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH }, body: '' });

    if (pathname === '/api/v1/auth/refresh' && method === 'POST')
      return json({ token: 'index-token', refresh_token: 'index-refresh', user: world.userRecord('you') });
    if (pathname === '/api/v1/setup/status') return json({ setup_required: false, instance_name: 'Index' });
    if (pathname === '/api/v1/instance')
      return json({ max_upload_size: 26214400, p2p_threshold: 8388608, setup_required: false, instance_name: 'Index' });
    if (pathname === '/api/v1/users/@me' && method === 'GET') return json(world.userRecord('you'));
    if (pathname === '/api/v1/users/@me/settings' && method === 'GET')
      return json({
        user_id: SELF.id,
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
    if (pathname === '/api/v1/users/@me/notification-settings') return json({ spaces: [], channels: [] });
    if (pathname === '/api/v1/users/@me/read-states') return json(world.readStateRecords());
    if (pathname === '/api/v1/users/@me/dms') {
      // Most recent conversation first, as the server lists them.
      const dms = [...world.channels.values()].filter((c) => c.seed.kind === 'dm');
      dms.sort((a, b) => BigInt(b.messages.at(-1)?.id ?? '0') > BigInt(a.messages.at(-1)?.id ?? '0') ? 1 : -1);
      return json(dms.map((c) => world.channelRecord(c.seed.key)));
    }
    if (pathname === '/api/v1/users/@me/guilds')
      return json(
        DOCK_ORDER.map((key) => GUILD[key]).map((g) => ({
          ...guildSummaryFixture({ ...world.guildSummary(g), server_url: 'https://index.paracord.local' }),
          hue: g.hue,
        })),
      );

    const guildMatch = pathname.match(/^\/api\/v1\/guilds\/(\d+)(?:\/(.*))?$/);
    if (guildMatch) {
      const guild = world.guildByIdOrKey(guildMatch[1]);
      const rest = guildMatch[2] ?? '';
      if (guild) {
        const summary = world.guildSummary(guild);
        if (rest === '' && method === 'GET')
          return json({
            ...guildDetailFixture({ ...summary, server_url: 'https://index.paracord.local' }),
            hue: guild.hue,
          });
        if (rest === 'channels') return json(world.channelsOf(guild.key).map((k) => world.channelRecord(k)));
        if (rest === 'channels/visible') return json({ channel_ids: world.channelsOf(guild.key).map((k) => world.channelState(k).seed.id) });
        if (rest === 'channel-previews')
          return json(
            world
              .channelsOf(guild.key)
              .filter((k) => world.channelState(k).seed.kind === 'text')
              .map((k) => world.previewRecord(k))
              .filter((entry) => entry !== null),
          );
        if (rest === 'members') return json(world.memberRecords(guild.key));
        if (rest === 'events') return json(world.events.filter((e) => e.guild === guild.key).map((e) => world.eventRecord(e)));
        const oneEvent = rest.match(/^events\/(\d+)$/);
        if (oneEvent && method === 'GET') {
          const found = world.events.find((e) => e.guild === guild.key && e.id === oneEvent[1]);
          return found ? json(world.eventRecord(found)) : json({ error: 'not_found' }, 404);
        }
        if (rest === 'onboarding/me')
          return json({
            settings: { welcome_title: guild.name, welcome_body: null, rules_text: null, role_prompt: null, role_options: [] },
            member_state: { accepted_rules: true, selected_role_ids: [], completed_at: world.nowIso },
          });
      }
    }

    const channelMatch = pathname.match(/^\/api\/v1\/channels\/(\d+)(?:\/(.*))?$/);
    if (channelMatch) {
      const channel = world.channelByIdOrKey(channelMatch[1]);
      const rest = channelMatch[2] ?? '';
      if (channel) {
        const key = channel.seed.key;
        if (rest === '' && method === 'GET') return json(world.channelRecord(key));
        if (rest === 'messages' && method === 'GET') {
          // `after`/`before` are exclusive and `limit` keeps the newest, as the server answers.
          const after = url.searchParams.get('after');
          const before = url.searchParams.get('before');
          const limit = Number(url.searchParams.get('limit') ?? '50');
          let list = channel.messages;
          if (after) list = list.filter((m) => BigInt(m.id) > BigInt(after));
          if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before));
          return json(list.slice(-limit).reverse().map((m) => world.revisedMessageRecord(m)));
        }
        if (rest === 'messages' && method === 'POST') return postMessage(route, world, key, options.stub);
        if (rest === 'read' && method === 'PUT') {
          const body = request.postDataJSON() as { last_message_id?: string } | null;
          if (body?.last_message_id) world.markRead(channel.seed.id, body.last_message_id);
          return none();
        }
        if (rest === 'typing' && method === 'POST') return none();
        // Who reacted with an emoji (the list a rest on a reaction opens).
        if (/^messages\/\d+\/reactions\/[^/]+$/.test(rest) && method === 'GET')
          return json((['brendan', 'vincent', 'nick'] as PersonKey[]).map((who) => world.userRecord(who)));
        if (rest === 'capabilities')
          return json({
            version: 1,
            channel_id: channel.seed.id,
            user_id: SELF.id,
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
        // The durable-delivery runtime surfaces a message only after the
        // authoritative recovery feed confirms it, as it would against a server.
        if (rest === 'messages/recovery' && method === 'GET')
          return json(
            world.recoveryPage(key, {
              after: url.searchParams.get('after') ?? '0',
              through: url.searchParams.get('through') ?? undefined,
              known_ids: (url.searchParams.get('known_ids') ?? '').split(',').filter(Boolean),
              limit: Number(url.searchParams.get('limit') ?? '100'),
            }),
          );
      }
    }

    if (pathname === '/api/v1/stream/ticket' && method === 'POST') return json({ ticket: 'index-stream-ticket' });
    options.onUnhandled?.(method, pathname);
    if (method === 'GET') return json([]);
    return none();
  });

  // Registered after the catch-all: Playwright runs the LAST matching route.
  for (const attachment of Object.values(ATTACHMENTS)) {
    await page.route(`**/api/v1/attachments/${attachment.id}**`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: gradientPng(attachment.variant) }),
    );
  }

  // The realtime session. The stream itself is the stub's, through the dev server's proxy.
  await page.route('**/api/v2/rt/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ws_url: 'ws://127.0.0.1:0/gateway', session_id: 'index-session', token: 'index-rt-token' }),
    }),
  );
  // Same rule as /api/v1: an answer without the epoch header makes the client reconnect.
  const epoch = { 'X-Paracord-History-Epoch': HISTORY_EPOCH };
  await page.route('**/api/v2/rt/commands', (route) => route.fulfill({ status: 204, headers: epoch, body: '' }));
  await page.route('**/api/v2/voice/**', (route) => route.fulfill({ status: 204, headers: epoch, body: '' }));
}

/** `POST /channels/{id}/messages`: you post. The server stores it and announces it to every stream, yours included. */
async function postMessage(route: Route, world: IndexWorld, key: ChannelKey, stub: RealtimeStub): Promise<void> {
  const body = (route.request().postDataJSON() ?? {}) as {
    content?: string | null;
    nonce?: string | null;
    referenced_message_id?: string | null;
  };
  const message = world.post(key, 'you', body.content ?? '', {
    nonce: body.nonce ?? null,
    reference_id: body.referenced_message_id ?? undefined,
  });
  await stub.emit(frames.messageCreate(world, message));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
    body: JSON.stringify(world.revisedMessageRecord(message)),
  });
}
