/**
 * Puts the Glass reference scene (`scene.ts`) behind a Playwright page: every
 * REST call the app makes, and a gateway stream that delivers READY carrying the
 * voice states, presences and channels, then a steady typing signal.
 *
 * Modeled on the Lantern design-review harness (retired in WP-G22): the API is
 * intercepted with `page.route`, and `window.EventSource` is replaced in the
 * page by a stub that replays whatever `window.__pcStream` holds — a real
 * persistent stream, because an intercepted SSE response always ends, which
 * would leave the client reconnecting and every dispatch dropped.
 *
 * Nothing here touches a server. The routes are declared last-wins, so a later
 * package's spec can call `installGlassScene` and then add its own overrides.
 */
import type { Page, Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { guildDetailFixture, guildSummaryFixture } from '../../../src/test/guildContractFixtures';
import {
  ATTACHMENT,
  BANNER_FILE,
  CAST,
  CH,
  CHANNELS,
  EVENTS,
  GAME_NIGHT_ID,
  GUILDS,
  LOUNGE,
  MESSAGES,
  ONLINE,
  PITCH,
  SCENE_NOW_ISO,
  SCENE_TIMEZONE,
  SUNDAY_LEAGUE_ID,
  TYPING,
  lastMessageIn,
  messagesIn,
  readStates,
  userRecord,
  type CastKey,
  type MessageSeed,
} from './scene';

export { SCENE_TIMEZONE, SCENE_NOW_ISO };

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HISTORY_EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SELF = userRecord(CAST.sean);

export interface GlassSceneOptions {
  /** Nobody in the Lounge: the "quiet" building. Default false (the reference is live). */
  quiet?: boolean;
  /** Suppress Eric's typing indicator. Default false. */
  noTyping?: boolean;
  /**
   * Light the room (and anything else that samples a live stream through
   * `lib/room`) from the DEV fixture scene, since no media server runs here
   * (WP-G8, `src/lib/room/devFixture.ts`). Default true.
   */
  roomFixture?: boolean;
}

function channelRecord(seed: (typeof CHANNELS)[number]) {
  const last = lastMessageIn(seed.id);
  return {
    id: seed.id,
    guild_id: seed.guild_id,
    name: seed.name,
    type: seed.type,
    channel_type: seed.type,
    position: seed.position,
    nsfw: false,
    parent_id: null,
    required_role_ids: [],
    last_message_id: seed.type === 0 || seed.type === 1 ? (last?.id ?? null) : null,
    created_at: SCENE_NOW_ISO,
    ...(seed.recipient
      ? {
          recipient: {
            id: CAST[seed.recipient].id,
            username: CAST[seed.recipient].username,
            discriminator: '0001',
            avatar_hash: null,
          },
        }
      : {}),
  };
}

function messageRecord(seed: MessageSeed) {
  const attachments = (seed.attachments ?? []).map(({ key }) => {
    const a = ATTACHMENT[key];
    return {
      id: a.id,
      filename: a.filename,
      size: 100_000,
      content_type: ('contentType' in a ? a.contentType : undefined) ?? 'image/png',
      url: `/attachments/${a.id}`,
      ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
    };
  });
  const poll = seed.poll
    ? {
        id: `${seed.id}-poll`,
        message_id: seed.id,
        channel_id: seed.channel_id,
        question: seed.poll.question,
        allow_multiselect: false,
        expires_at: null,
        created_at: seed.created_at,
        total_votes: seed.poll.options.reduce((sum, o) => sum + o.votes, 0),
        options: seed.poll.options.map((o, i) => ({
          id: `${seed.id}-opt-${i}`,
          text: o.text,
          emoji: null,
          position: i,
          vote_count: o.votes,
          voted: o.voted ?? false,
        })),
      }
    : undefined;
  return {
    id: seed.id,
    channel_id: seed.channel_id,
    author: userRecord(CAST[seed.author]),
    content: seed.content,
    created_at: seed.created_at,
    timestamp: seed.created_at,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments,
    reactions: seed.reactions ?? [],
    ...(poll ? { poll } : {}),
  };
}

/**
 * What `GET /guilds/{id}/channel-previews` answers: the newest message of every
 * channel that has one (an empty channel has no entry), as the server describes
 * it (docs/design/glass-g4-checkpoint.md): whitespace collapsed, at most 140
 * characters, the first attachment as `media`.
 */
function previewRecord(channelId: string) {
  const last = lastMessageIn(channelId);
  if (!last) return null;
  const first = last.attachments?.[0] ? ATTACHMENT[last.attachments[0].key] : null;
  const text = last.content.replace(/\s+/g, ' ').trim();
  return {
    channel_id: channelId,
    message_id: last.id,
    message_type: last.poll ? 20 : 0,
    author_id: CAST[last.author].id,
    author_kind: 'user',
    author_name: CAST[last.author].display_name,
    content: last.poll ? last.poll.question : text || null,
    truncated: false,
    encrypted: false,
    created_at: last.created_at,
    media: first
      ? {
          attachment_id: first.id,
          content_type: 'image/png',
          filename: first.filename,
          width: first.width,
          height: first.height,
        }
      : null,
    attachment_count: last.attachments?.length ?? 0,
    has_sticker: false,
  };
}

const memberRecord = (key: CastKey) => ({
  user: userRecord(CAST[key]),
  user_id: CAST[key].id,
  nick: null,
  roles: [],
  joined_at: SCENE_NOW_ISO,
  deaf: false,
  mute: false,
});

const eventRecord = (seed: (typeof EVENTS)[number]) => ({
  id: seed.id,
  guild_id: seed.guild_id,
  channel_id: seed.channel_id,
  creator_id: CAST[seed.creator].id,
  name: seed.name,
  description: null,
  scheduled_start: seed.scheduled_start,
  scheduled_end: null,
  status: 1,
  entity_type: seed.channel_id ? 1 : 2,
  location: seed.location,
  image_url: null,
  user_count: seed.user_count,
  user_rsvp: seed.user_rsvp,
  created_at: SCENE_NOW_ISO,
});

function voiceStatesIn(
  channelId: string,
  guildId: string,
  people: ReadonlyArray<{ who: CastKey; self_stream: boolean; self_video: boolean; self_mute: boolean; speaking: boolean }>,
) {
  return people.map(({ who, self_stream, self_video, self_mute, speaking }) => ({
    user_id: CAST[who].id,
    channel_id: channelId,
    guild_id: guildId,
    session_id: `session-${CAST[who].id}`,
    username: CAST[who].username,
    display_name: CAST[who].display_name,
    avatar_hash: null,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute,
    self_stream,
    self_video,
    suppress: false,
    speaking,
  }));
}

const loungeVoiceStates = () => voiceStatesIn(CH.lounge, GAME_NIGHT_ID, LOUNGE);
const pitchVoiceStates = () => voiceStatesIn(CH.pitch, SUNDAY_LEAGUE_ID, PITCH);

function readyFrame(quiet: boolean, icons: ReadonlyMap<string, string>) {
  return {
    op: 0,
    s: 1,
    t: 'READY',
    d: {
      session_id: 'glass-session',
      database_history_epoch: HISTORY_EPOCH,
      user: { id: SELF.id, username: SELF.username, display_name: SELF.display_name },
      guilds: GUILDS.map((guild) => ({
        id: guild.id,
        name: guild.name,
        owner_id: SELF.id,
        icon_hash: icons.get(guild.id) ?? null,
        member_count: guild.member_count,
        created_at: SCENE_NOW_ISO,
        channels: CHANNELS.filter((c) => c.guild_id === guild.id).map(channelRecord),
        voice_states:
          guild.id === GAME_NIGHT_ID && !quiet
            ? loungeVoiceStates()
            : guild.id === SUNDAY_LEAGUE_ID
              ? pitchVoiceStates()
              : [],
        presences: guild.members
          .filter((key) => ONLINE.includes(key))
          .map((key) => ({ user_id: CAST[key].id, status: 'online', activities: [] })),
      })),
    },
  };
}

const typingFrame = () => ({
  op: 0,
  t: 'TYPING_START',
  d: { channel_id: TYPING.channel_id, user_id: CAST[TYPING.who].id, guild_id: GAME_NIGHT_ID },
});

/** Install the whole scene. Call before the first `page.goto`. */
export async function installGlassScene(page: Page, options: GlassSceneOptions = {}): Promise<void> {
  const quiet = options.quiet ?? false;
  // Each server's uploaded icon, as the stored data URL the client draws.
  const icons = new Map<string, string>();
  for (const guild of GUILDS) {
    if (guild.icon) {
      const bytes = await readFile(path.join(HERE, guild.icon));
      icons.set(guild.id, `data:image/png;base64,${bytes.toString('base64')}`);
    }
  }

  // Pin Date (not timers) so "9:12 PM", "Today", "Fri" and "Tue" read the same
  // on every machine on every day. The timezone comes from the spec's `use`.
  await page.clock.setFixedTime(SCENE_NOW_ISO);

  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('paracord:auth:session-seen', '1');
      window.localStorage.setItem('paracord:v2:layout-tour-shell', 'done');
      window.localStorage.setItem('paracord:v2:layout-tour-guild-home', 'done');
      window.localStorage.setItem('paracord:v2:onboarding-complete', '1');
      window.localStorage.setItem('paracord:v2:guild-welcomed:1001', '1');
      window.localStorage.setItem('paracord:v2:guild-welcomed:1002', '1');
    } catch {
      /* storage unavailable: the tour simply shows */
    }
  });

  if (options.roomFixture ?? true) {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__PARACORD_ROOM_FIXTURE__ = 'stream';
    });
  }

  // The gateway: a persistent EventSource that replays READY once and the
  // typing signal on a beat.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __pcStream?: { once: unknown[]; repeat: unknown[] };
      EventSource: unknown;
    };
    class GlassEventSource {
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
          for (const frame of w.__pcStream?.once ?? []) this.emit(frame);
          const beat = () => {
            for (const frame of w.__pcStream?.repeat ?? []) this.emit(frame);
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
      dispatchEvent() {
        return true;
      }
      close() {
        this.readyState = 2;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      }
    }
    w.EventSource = GlassEventSource;
  });
  await page.addInitScript(
    (stream) => {
      (window as unknown as { __pcStream: unknown }).__pcStream = stream;
    },
    { once: [readyFrame(quiet, icons)], repeat: options.noTyping ? [] : [typingFrame()] },
  );

  const png = async (file: string) => readFile(path.join(HERE, file));
  const image = async (route: Route, file: string) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: await png(file) });

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

    if (pathname === '/api/v1/auth/refresh' && method === 'POST')
      return json({ token: 'glass-token', refresh_token: 'glass-refresh', user: SELF });
    if (pathname === '/api/v1/setup/status') return json({ setup_required: false, instance_name: 'Glass' });
    if (pathname === '/api/v1/instance')
      return json({ max_upload_size: 26214400, p2p_threshold: 8388608, setup_required: false, instance_name: 'Glass' });
    if (pathname === '/api/v1/users/@me' && method === 'GET') return json(SELF);
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
    if (pathname === '/api/v1/users/@me/read-states') return json(readStates());
    if (pathname === '/api/v1/users/@me/dms')
      return json(CHANNELS.filter((c) => c.guild_id === null).map(channelRecord));
    if (pathname === '/api/v1/users/@me/guilds')
      return json(
        GUILDS.map((g) =>
          guildSummaryFixture({
            id: g.id,
            name: g.name,
            server_url: 'https://glass.paracord.local',
            owner_id: SELF.id,
            member_count: g.member_count,
            banner_hash: g.banner_hash,
            icon_hash: icons.get(g.id) ?? null,
            created_at: SCENE_NOW_ISO,
          }),
        ),
      );

    const guildMatch = pathname.match(/^\/api\/v1\/guilds\/(\d+)(?:\/(.*))?$/);
    if (guildMatch) {
      const guild = GUILDS.find((g) => g.id === guildMatch[1]);
      const rest = guildMatch[2] ?? '';
      if (guild) {
        const channels = CHANNELS.filter((c) => c.guild_id === guild.id);
        if (rest === '' && method === 'GET')
          return json(
            guildDetailFixture({
              id: guild.id,
              name: guild.name,
              server_url: 'https://glass.paracord.local',
              owner_id: SELF.id,
              member_count: guild.member_count,
              banner_hash: guild.banner_hash,
              icon_hash: icons.get(guild.id) ?? null,
              created_at: SCENE_NOW_ISO,
            }),
          );
        if (rest === 'channels') return json(channels.map(channelRecord));
        if (rest === 'channels/visible') return json({ channel_ids: channels.map((c) => c.id) });
        if (rest === 'channel-previews')
          return json(
            channels
              .filter((c) => c.type === 0 || c.type === 2)
              .map((c) => previewRecord(c.id))
              .filter((entry) => entry !== null),
          );
        if (rest === 'members') return json(guild.members.map(memberRecord));
        if (rest === 'events') return json(EVENTS.filter((e) => e.guild_id === guild.id).map(eventRecord));
        // One event, for the plan card and the event chip (`<event:ID>` in a message).
        const oneEvent = rest.match(/^events\/(\d+)$/);
        if (oneEvent && method === 'GET') {
          const found = EVENTS.find((e) => e.guild_id === guild.id && e.id === oneEvent[1]);
          return found ? json(eventRecord(found)) : json({ error: 'not_found' }, 404);
        }
        if (rest === 'onboarding/me')
          return json({
            settings: { welcome_title: guild.name, welcome_body: null, rules_text: null, role_prompt: null, role_options: [] },
            member_state: { accepted_rules: true, selected_role_ids: [], completed_at: SCENE_NOW_ISO },
          });
      }
    }

    const channelMatch = pathname.match(/^\/api\/v1\/channels\/(\d+)(?:\/(.*))?$/);
    if (channelMatch) {
      const seed = CHANNELS.find((c) => c.id === channelMatch[1]);
      const rest = channelMatch[2] ?? '';
      if (seed) {
        if (rest === '' && method === 'GET') return json(channelRecord(seed));
        if (rest === 'messages' && method === 'GET') {
          // `after` is exclusive and `limit` keeps the newest, as the server answers.
          const after = url.searchParams.get('after');
          const limit = Number(url.searchParams.get('limit') ?? '50');
          const newer = messagesIn(seed.id).filter((m) => (after ? BigInt(m.id) > BigInt(after) : true));
          return json(newer.slice(-limit).reverse().map(messageRecord));
        }
        // Who reacted with an emoji (the list a rest on a reaction opens).
        if (/^messages\/\d+\/reactions\/[^/]+$/.test(rest) && method === 'GET')
          return json(['brendan', 'vincent', 'nick'].map((who) => ({
            id: CAST[who as CastKey].id,
            username: CAST[who as CastKey].username,
            display_name: CAST[who as CastKey].display_name,
            avatar_hash: null,
          })));
        if (rest === 'capabilities')
          return json({
            version: 1,
            channel_id: seed.id,
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
        if (rest === 'messages/recovery' && method === 'GET') {
          const after = url.searchParams.get('after') ?? '0';
          const knownIds = (url.searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
          return json({
            database_history_epoch: HISTORY_EPOCH,
            channel_id: seed.id,
            after,
            through: after,
            floor: '0',
            next: after,
            complete: true,
            projection_head: after,
            changes: [],
            states: knownIds.map((id) => {
              const found = MESSAGES.find((m) => m.id === id);
              return {
                message_id: id,
                state: 'present',
                revision: after,
                message: found ? { ...messageRecord(found), message_revision: after } : undefined,
              };
            }),
          });
        }
      }
    }

    if (pathname === '/api/v1/stream/ticket' && method === 'POST') return json({ ticket: 'glass-stream-ticket' });
    if (method === 'GET') return json([]);
    return route.fulfill({ status: 204, body: '' });
  });

  // Registered after the catch-all: Playwright runs the LAST matching route.
  for (const attachment of Object.values(ATTACHMENT)) {
    await page.route(`**/api/v1/attachments/${attachment.id}**`, (route) => image(route, attachment.file));
  }
  await page.route(`**/api/v1/guilds/*/banner**`, (route) => image(route, BANNER_FILE));

  await page.route('**/api/v2/rt/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ws_url: 'ws://127.0.0.1:0/gateway', session_id: 'glass-session', token: 'glass-rt-token' }),
    }),
  );
  await page.route('**/api/v2/rt/commands', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/v2/voice/**', (route) => route.fulfill({ status: 204, body: '' }));
}
