/**
 * What the pages inside the conversation pane need beyond the reference scene
 * (WP-G19): friends and their requests, a forum with posts, the server home's
 * feed, a richer roster of presences, and a call ringing in a direct message.
 *
 * `installGlassScene` (install.ts) comes first; this file layers on top of it
 * and never edits it. Playwright runs the LAST matching route, so the handlers
 * below win over the scene's catch-all, and the init scripts run after the
 * scene's, so they can amend the READY frame it stored on `window.__pcStream`.
 */
import type { Page } from '@playwright/test';
import { BASECAMP_ID, CAST, CH, CHANNELS, GAME_NIGHT_ID, MESSAGES, SCENE_NOW_ISO, at, lastMessageIn, snowflakeAt, userRecord, type CastMember } from './scene';

/** Game Night's forum, type 7. */
export const FORUM_ID = '2006';
/** One of its posts (a thread), with a short conversation inside it. */
export const POST_ID = '2601';

const TODAY = '2026-10-01';

export const EXTRA_CAST = {
  mara: { id: '57', username: 'mara', display_name: 'Mara' },
  dana: { id: '58', username: 'dana', display_name: 'Dana' },
  ivo: { id: '59', username: 'ivo', display_name: 'Ivo' },
} as const satisfies Record<string, CastMember>;

const relationship = (who: CastMember, type: number, createdAt: string) => ({
  id: `42:${who.id}`,
  type,
  rel_type: type,
  user_id: '42',
  target_id: who.id,
  created_at: createdAt,
  user: {
    id: who.id,
    username: who.username,
    display_name: who.display_name,
    discriminator: 1,
    avatar_hash: null,
  },
});

/** Six friends, one request waiting on Sean, one Sean is waiting on, one blocked. */
export function relationships() {
  return [
    relationship(CAST.vincent, 1, at('2026-03-02', '10:00')),
    relationship(CAST.brendan, 1, at('2026-03-02', '10:05')),
    relationship(CAST.nick, 1, at('2026-04-11', '18:40')),
    relationship(CAST.jeremy, 1, at('2026-05-20', '09:12')),
    relationship(CAST.luke, 1, at('2026-06-01', '20:00')),
    relationship(CAST.eric, 1, at('2026-07-15', '14:30')),
    relationship(EXTRA_CAST.mara, 3, at(TODAY, '20:41')),
    relationship(EXTRA_CAST.dana, 4, at('2026-09-29', '12:00')),
    relationship(EXTRA_CAST.ivo, 2, at('2026-08-01', '12:00')),
  ];
}

const forumTags = [
  { id: '2701', channel_id: FORUM_ID, name: 'Loadouts', emoji: null, moderated: false, position: 0, created_at: SCENE_NOW_ISO },
  { id: '2702', channel_id: FORUM_ID, name: 'Help', emoji: null, moderated: false, position: 1, created_at: SCENE_NOW_ISO },
  { id: '2703', channel_id: FORUM_ID, name: 'Clips', emoji: null, moderated: false, position: 2, created_at: SCENE_NOW_ISO },
];

interface PostSeed {
  id: string;
  name: string;
  owner: CastMember;
  replies: number;
  day: string;
  time: string;
  tags: string[];
  archived?: boolean;
  /** Newest reply, for the row's "last reply" line. */
  lastReply?: { by: CastMember; time: string };
}

const POSTS: PostSeed[] = [
  {
    id: POST_ID,
    name: 'Best loadout for Hazard 5 with three?',
    owner: CAST.brendan,
    replies: 7,
    day: TODAY,
    time: '20:31',
    tags: ['2701', '2702'],
    lastReply: { by: CAST.vincent, time: '21:04' },
  },
  {
    id: '2602',
    name: '41:07 route notes, with the timestamps',
    owner: CAST.nick,
    replies: 12,
    day: TODAY,
    time: '18:10',
    tags: ['2703'],
    lastReply: { by: CAST.luke, time: '20:52' },
  },
  {
    id: '2603',
    name: 'Anyone running the new stealth build?',
    owner: CAST.luke,
    replies: 3,
    day: '2026-09-30',
    time: '22:15',
    tags: ['2701'],
    lastReply: { by: CAST.jeremy, time: '23:01' },
  },
  {
    id: '2604',
    name: 'Voice chat etiquette for run nights',
    owner: CAST.sean,
    replies: 0,
    day: '2026-09-28',
    time: '19:00',
    tags: [],
  },
  {
    id: '2605',
    name: 'Season one retrospective',
    owner: CAST.eric,
    replies: 21,
    day: '2026-09-12',
    time: '15:20',
    tags: [],
    archived: true,
  },
];

function postChannel(post: PostSeed) {
  return {
    id: post.id,
    guild_id: GAME_NIGHT_ID,
    name: post.name,
    type: 11,
    channel_type: 11,
    position: 0,
    nsfw: false,
    parent_id: FORUM_ID,
    required_role_ids: [],
    owner_id: post.owner.id,
    message_count: post.replies + 1,
    applied_tags: post.tags,
    last_message_id: null,
    thread_metadata: { archived: post.archived === true, locked: false },
    created_at: at(post.day, post.time),
  };
}

export const forumChannel = () => ({
  id: FORUM_ID,
  guild_id: GAME_NIGHT_ID,
  name: 'Strategy',
  type: 7,
  channel_type: 7,
  position: 5,
  nsfw: false,
  parent_id: null,
  required_role_ids: [],
  last_message_id: null,
  created_at: SCENE_NOW_ISO,
});

/** The conversation inside the first post: the opening message and three replies. */
function postMessages() {
  const seeds: Array<[CastMember, string, string]> = [
    [CAST.brendan, '20:31', 'Three of us on tonight, no revive perk between us. What do you take on the long carry?'],
    [CAST.vincent, '20:44', 'Silenced marksman and the short-fuse charges. You never want to be loud at the pod.'],
    [CAST.luke, '20:52', 'Agree on the charges. Skip the scope, the corridors are too tight for it.'],
    [CAST.vincent, '21:04', 'I can run it from the Lounge if you want to see the route. Streaming in ten.'],
  ];
  return seeds.map(([who, time, content]) => {
    const created_at = at(TODAY, time);
    return {
      id: snowflakeAt(created_at),
      channel_id: POST_ID,
      author: userRecord(who),
      content,
      created_at,
      timestamp: created_at,
      tts: false,
      mention_everyone: false,
      pinned: false,
      type: 0,
      attachments: [],
      reactions: [],
    };
  });
}

/* ----------------------------------------------------------- a direct message */

/**
 * The conversation with Brendan: the scene's own last message (the unread one),
 * with the evening before it, so the pane reads like a conversation.
 */
function dmMessages() {
  const last = MESSAGES.filter((m) => m.channel_id === CH.dmBrendan).at(-1)!;
  const earlier: Array<[CastMember, string, string]> = [
    [CAST.brendan, '20:41', 'hey, did the patch fix the door glitch?'],
    [CAST.sean, '20:43', 'no, still there on the third floor. sent Vincent the clip'],
    [CAST.brendan, '20:44', 'ugh. ok. he said he would look tonight'],
    [CAST.sean, '20:50', 'i can be on at 9:30 if we still do the run'],
  ];
  const wire = (id: string, who: CastMember, created_at: string, content: string) => ({
    id,
    channel_id: CH.dmBrendan,
    author: userRecord(who),
    content,
    created_at,
    timestamp: created_at,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
  });
  return [
    ...earlier.map(([who, time, content]) => {
      const created_at = at(TODAY, time);
      return wire(snowflakeAt(created_at), who, created_at, content);
    }),
    wire(last.id, CAST.brendan, last.created_at, last.content),
  ];
}

/* ------------------------------------------------------------- feed items */

const feedUser = (who: CastMember) => ({
  id: who.id,
  username: who.username,
  display_name: who.display_name,
  avatar_hash: null,
});

function feedMessage(opts: {
  channelId: string;
  channelName: string;
  who: CastMember;
  time: string;
  content: string;
  reason: string;
  attachments?: Array<{ id: string; filename: string; width: number; height: number }>;
  poll?: { question: string; options: Array<{ text: string; votes: number; voted?: boolean }> };
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
}) {
  const created_at = at(TODAY, opts.time);
  const id = snowflakeAt(created_at);
  return {
    type: 'message',
    id: `m:${id}`,
    key: id,
    at: created_at,
    channel_id: opts.channelId,
    channel_name: opts.channelName,
    channel_type: 0,
    reason: opts.reason,
    message: {
      id,
      channel_id: opts.channelId,
      author: userRecord(opts.who),
      content: opts.content,
      created_at,
      timestamp: created_at,
      tts: false,
      mention_everyone: false,
      pinned: false,
      type: 0,
      attachments: (opts.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        size: 100_000,
        content_type: 'image/png',
        url: `/api/v1/attachments/${a.id}`,
        width: a.width,
        height: a.height,
      })),
      reactions: opts.reactions ?? [],
      ...(opts.poll
        ? {
            poll: {
              id: `${id}-poll`,
              message_id: id,
              channel_id: opts.channelId,
              question: opts.poll.question,
              allow_multiselect: false,
              expires_at: null,
              created_at,
              total_votes: opts.poll.options.reduce((sum, o) => sum + o.votes, 0),
              options: opts.poll.options.map((o, i) => ({
                id: `${id}-opt-${i}`,
                text: o.text,
                emoji: null,
                position: i,
                vote_count: o.votes,
                voted: o.voted ?? false,
              })),
            },
          }
        : {}),
    },
  };
}

function gameNightFeed() {
  const forumAt = at(TODAY, '20:31');
  const forumId = snowflakeAt(forumAt);
  return {
    items: [
      feedMessage({
        channelId: CH.clips,
        channelName: 'Clips',
        who: CAST.nick,
        time: '21:06',
        content: 'new personal best, 41:07',
        reason: 'attachment',
        attachments: [{ id: '9001', filename: 'mission-41-07.png', width: 480, height: 270 }],
        reactions: [
          { emoji: '🔥', count: 5, me: false },
          { emoji: '🤍', count: 3, me: false },
        ],
      }),
      {
        type: 'forum_post',
        id: `f:${forumId}`,
        key: forumId,
        at: forumAt,
        channel_id: FORUM_ID,
        channel_name: 'Strategy',
        thread_id: POST_ID,
        title: 'Best loadout for Hazard 5 with three?',
        author: feedUser(CAST.brendan),
        excerpt: 'Three of us on tonight, no revive perk between us. What do you take on the long carry?',
        reply_count: 7,
        last_reply_at: at(TODAY, '21:04'),
        last_reply_author: feedUser(CAST.vincent),
        participants: [feedUser(CAST.vincent), feedUser(CAST.luke), feedUser(CAST.nick)],
      },
      feedMessage({
        channelId: CH.lfg,
        channelName: 'LFG',
        who: CAST.luke,
        time: '20:35',
        content: 'Late one after the run?',
        reason: 'poll',
        poll: {
          question: 'Late one after the run?',
          options: [
            { text: 'Count me in', votes: 3, voted: true },
            { text: 'Maybe one round', votes: 2 },
            { text: 'Bed', votes: 1 },
          ],
        },
      }),
      {
        type: 'members_joined',
        id: `j:${TODAY}`,
        key: snowflakeAt(at(TODAY, '17:00')),
        at: at(TODAY, '17:00'),
        day: TODAY,
        users: [feedUser(EXTRA_CAST.mara), feedUser(EXTRA_CAST.dana)],
        total: 2,
      },
    ],
    next_cursor: null,
  };
}

/* --------------------------------------------------------------- install */

export interface GlassPagesOptions {
  /** A call ringing in the Brendan direct message. */
  ringing?: boolean;
}

/**
 * Layer the extras over an installed scene. Call after `installGlassScene` and
 * before the first `page.goto`.
 */
export async function installGlassPages(page: Page, options: GlassPagesOptions = {}): Promise<void> {
  const forum = forumChannel();
  const ringing = options.ringing === true;

  // READY: the forum channel, and a roster with more than "online": Eric is
  // away, Luke does not want to be disturbed, Jeremy is offline, Vincent is
  // playing, Nick is listening to something.
  await page.addInitScript(
    ({ forumRecords, gameNight, ring, startedAt }) => {
      const w = window as unknown as {
        __pcStream?: { once: Array<{ t?: string; d?: { guilds?: Array<Record<string, unknown>> } }> };
      };
      const ready = w.__pcStream?.once.find((frame) => frame.t === 'READY');
      const guilds = ready?.d?.guilds ?? [];
      const guild = guilds.find((entry) => entry.id === gameNight);
      if (!guild) return;
      (guild.channels as unknown[]).push(...forumRecords);
      const activity = (type: number, name: string, details?: string) => ({ type, activity_type: type, name, details: details ?? null });
      const status: Record<string, { status: string; activities: unknown[] }> = {
        '51': { status: 'online', activities: [activity(0, 'Hazard 5')] },
        '52': { status: 'online', activities: [] },
        // Nick asked not to be disturbed (he is in the Lounge, muted); Jeremy is away.
        '53': { status: 'dnd', activities: [activity(2, 'Windowlicker', 'Aphex Twin')] },
        '54': { status: 'idle', activities: [] },
      };
      // Streams say when they began (`self_stream_started_at`), so the live rows
      // can say "LIVE 42 MIN": the scene's clock is 9:12 PM, so 8:30 PM.
      for (const entry of guilds) {
        for (const voice of (entry.voice_states ?? []) as Array<{ self_stream?: boolean; self_stream_started_at?: string | null }>) {
          voice.self_stream_started_at = voice.self_stream ? startedAt : null;
        }
      }
      // A person is one person in every server they share with Sean, so the
      // roster is amended in all of them. Eric is offline: no presence at all.
      for (const entry of guilds) {
        const presences = (entry.presences ?? []) as Array<{ user_id: string; status: string; activities: unknown[] }>;
        entry.presences = presences
          .filter((item) => item.user_id !== '56')
          .map((item) => (status[item.user_id] ? { ...item, ...status[item.user_id] } : item));
      }
      if (ring) {
        // Brendan is calling in the direct message the scene already has: a
        // voice state with no guild, delivered right after READY.
        w.__pcStream?.once.push({
          op: 0,
          s: 2,
          t: 'VOICE_STATE_UPDATE',
          d: { user_id: '52', channel_id: '3001', session_id: 'session-52', username: 'brendan', display_name: 'Brendan', self_mute: false, self_deaf: false, self_stream: false, self_video: false, suppress: false, deaf: false, mute: false },
        } as never);
      }
    },
    { forumRecords: [forum, ...POSTS.map(postChannel)], gameNight: GAME_NIGHT_ID, ring: ringing, startedAt: at(TODAY, '20:30') },
  );

  // The client refuses a response that does not name the history it belongs to.
  const json = (route: import('@playwright/test').Route, payload: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      body: JSON.stringify(payload),
    });

  // A download ticket, so a picture on a page (not a message) can load.
  await page.route('**/api/v1/download/ticket', (route) => json(route, { ticket: 'glass-download-ticket' }));

  await page.route('**/api/v1/users/@me/relationships', (route) =>
    route.request().method() === 'GET' ? json(route, relationships()) : route.fulfill({ status: 204, body: '' }),
  );
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/feed**`, (route) => json(route, gameNightFeed()));
  await page.route(`**/api/v1/guilds/${BASECAMP_ID}/feed**`, (route) => json(route, { items: [], next_cursor: null }));
  // The server home's widgets: the newest pictures, the week's most active, and a
  // roster with some people who joined lately ("New here").
  const attachmentItem = (index: number, key: 'mission' | 'photo', who: CastMember, time: string) => {
    const a = key === 'mission'
      ? { id: '9001', filename: 'mission-41-07.png', width: 480, height: 270 }
      : { id: '9002', filename: 'ridge-first-light.png', width: 640, height: 400 };
    return {
      id: `${a.id}-g${index}`,
      message_id: snowflakeAt(at(TODAY, time)),
      channel_id: CH.clips,
      filename: a.filename,
      content_type: 'image/png',
      size: 100_000,
      url: `/api/v1/attachments/${a.id}`,
      width: a.width,
      height: a.height,
      kind: 'image',
      created_at: at(TODAY, time),
      author: { id: who.id, username: who.username, display_name: who.display_name, avatar_hash: null },
    };
  };
  await page.route(`**/api/v1/guilds/${BASECAMP_ID}/attachments**`, (route) =>
    json(route, {
      items: [attachmentItem(1, 'photo', CAST.eric, '19:20'), attachmentItem(2, 'photo', CAST.luke, '17:30'), attachmentItem(3, 'photo', CAST.nick, '15:10')],
      next_before: null,
    }),
  );
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/attachments**`, (route) =>
    json(route, {
      items: [
        attachmentItem(1, 'mission', CAST.nick, '21:06'),
        attachmentItem(2, 'photo', CAST.eric, '19:20'),
        attachmentItem(3, 'mission', CAST.brendan, '18:50'),
        attachmentItem(4, 'photo', CAST.luke, '17:30'),
      ],
      next_before: null,
    }),
  );
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/economy/leaderboard**`, (route) =>
    json(route, {
      window: 'weekly',
      entries: [
        [CAST.nick, 4120],
        [CAST.brendan, 3560],
        [CAST.vincent, 2210],
        [CAST.luke, 980],
      ].map(([who, xp], index) => ({
        rank: index + 1,
        user: { id: (who as CastMember).id, username: (who as CastMember).username, display_name: (who as CastMember).display_name, discriminator: 1, avatar: null },
        xp,
        level: 12 - index,
        streak_days: 3,
        last_xp_at: SCENE_NOW_ISO,
      })),
    }),
  );
  await page.route(`**/api/v1/guilds/${BASECAMP_ID}/members**`, (route) =>
    json(
      route,
      (['sean', 'eric', 'luke', 'jeremy', 'nick'] as const).map((key) => ({
        user: userRecord(CAST[key]),
        user_id: CAST[key].id,
        nick: null,
        roles: [],
        joined_at: key === 'nick' ? at('2026-09-30', '09:00') : at('2026-03-01', '12:00'),
        deaf: false,
        mute: false,
      })),
    ),
  );
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/members**`, (route) =>
    json(
      route,
      (['sean', 'vincent', 'brendan', 'nick', 'jeremy', 'luke', 'eric'] as const).map((key) => ({
        user: userRecord(CAST[key]),
        user_id: CAST[key].id,
        nick: null,
        roles: [],
        // Eric and Luke joined this week; the rest a long time ago.
        joined_at: key === 'eric' ? at('2026-09-29', '18:00') : key === 'luke' ? at('2026-09-26', '20:00') : at('2026-02-01', '12:00'),
        deaf: false,
        mute: false,
      })),
    ),
  );
  // The direct message with Brendan: a real evening's conversation, and the
  // recovery feed the durable runtime confirms it against.
  const dmThread = dmMessages();
  await page.route(`**/api/v1/channels/${CH.dmBrendan}/messages**`, (route) => {
    const url = route.request().url();
    if (url.includes('/messages/recovery') || url.includes('/messages/attention')) return route.fallback();
    const params = new URL(url).searchParams;
    const after = params.get('after');
    const limit = Number(params.get('limit') ?? '50');
    const pool = dmThread.filter((m) => (after ? BigInt(m.id) > BigInt(after) : true));
    return route.request().method() === 'GET' ? json(route, pool.slice(-limit).reverse()) : route.fulfill({ status: 204, body: '' });
  });
  await page.route(`**/api/v1/channels/${CH.dmBrendan}/messages/recovery**`, (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get('after') ?? '0';
    const knownIds = (url.searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
    return json(route, {
      database_history_epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel_id: CH.dmBrendan,
      after,
      through: after,
      floor: '0',
      next: after,
      complete: true,
      projection_head: after,
      changes: [],
      states: knownIds.map((id) => {
        const found = dmThread.find((m) => m.id === id);
        return { message_id: id, state: 'present', revision: after, message: found ? { ...found, message_revision: after } : undefined };
      }),
    });
  });
  // What is waiting in a conversation, for "For you": the newest message after
  // the read position, or the newest that mentions Sean.
  await page.route('**/api/v1/channels/*/messages/attention**', (route) => {
    const url = new URL(route.request().url());
    const channelId = url.pathname.split('/')[4];
    const kind = url.searchParams.get('kind') ?? 'unread';
    const after = url.searchParams.get('after');
    const pool = MESSAGES.filter(
      (m) =>
        m.channel_id === channelId &&
        (after ? BigInt(m.id) > BigInt(after) : true) &&
        (kind === 'mention' ? m.content.includes('<@42>') : true),
    );
    const found = pool.at(-1);
    return json(route, {
      channel_id: channelId,
      user_id: '42',
      kind,
      message: found
        ? {
            id: found.id,
            channel_id: found.channel_id,
            author: userRecord(CAST[found.author]),
            content: found.content,
            created_at: found.created_at,
            timestamp: found.created_at,
            tts: false,
            mention_everyone: false,
            pinned: false,
            type: 0,
            attachments: [],
            reactions: [],
          }
        : null,
    });
  });
  // Game Night's channels as the scene lists them, plus the forum and its posts,
  // so the list a page fetches agrees with the one READY delivered.
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/channels`, (route) =>
    route.request().method() === 'GET'
      ? json(route, [
          ...CHANNELS.filter((c) => c.guild_id === GAME_NIGHT_ID).map((c) => ({
            id: c.id,
            guild_id: c.guild_id,
            name: c.name,
            type: c.type,
            channel_type: c.type,
            position: c.position,
            nsfw: false,
            parent_id: null,
            required_role_ids: [],
            last_message_id: c.type === 0 || c.type === 1 ? (lastMessageIn(c.id)?.id ?? null) : null,
            created_at: SCENE_NOW_ISO,
          })),
          forum,
          ...POSTS.map(postChannel),
        ])
      : route.fallback(),
  );
  // Which of them Sean may see: all of them, forum and posts included.
  await page.route(`**/api/v1/guilds/${GAME_NIGHT_ID}/channels/visible`, (route) =>
    json(route, {
      channel_ids: [...CHANNELS.filter((c) => c.guild_id === GAME_NIGHT_ID).map((c) => c.id), FORUM_ID, ...POSTS.map((p) => p.id)],
    }),
  );
  await page.route(`**/api/v1/channels/${FORUM_ID}`, (route) => json(route, forum));
  await page.route(`**/api/v1/channels/${FORUM_ID}/forum/posts**`, (route) =>
    route.request().method() === 'GET'
      ? json(route, { posts: POSTS.map(postChannel), tags: forumTags, sort_order: 0 })
      : json(route, postChannel(POSTS[0])),
  );
  await page.route(`**/api/v1/channels/${FORUM_ID}/forum/tags**`, (route) => json(route, forumTags));
  await page.route(`**/api/v1/channels/${POST_ID}`, (route) => json(route, postChannel(POSTS[0])));
  // The post's conversation: its messages, the recovery feed the durable runtime
  // confirms them against, and what Sean may do in it.
  const postThread = postMessages();
  await page.route(`**/api/v1/channels/${POST_ID}/messages/recovery**`, (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get('after') ?? '0';
    const knownIds = (url.searchParams.get('known_ids') ?? '').split(',').filter(Boolean);
    return json(route, {
      database_history_epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel_id: POST_ID,
      after,
      through: after,
      floor: '0',
      next: after,
      complete: true,
      projection_head: after,
      changes: [],
      states: knownIds.map((id) => {
        const found = postThread.find((m) => m.id === id);
        return { message_id: id, state: 'present', revision: after, message: found ? { ...found, message_revision: after } : undefined };
      }),
    });
  });
  await page.route(`**/api/v1/channels/${POST_ID}/capabilities**`, (route) =>
    json(route, {
      version: 1,
      channel_id: POST_ID,
      user_id: '42',
      encrypted: false,
      own_identity_enrolled: false,
      peers_ready: true,
      actions: Object.fromEntries(
        ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => [
          action,
          { supported: true, allowed: true, reason: null },
        ]),
      ),
    }),
  );
  await page.route(`**/api/v1/channels/${POST_ID}/messages**`, (route) => {
    if (route.request().url().includes('/messages/recovery')) return route.fallback();
    return route.request().method() === 'GET' ? json(route, [...postThread].reverse()) : route.fulfill({ status: 204, body: '' });
  });

}
