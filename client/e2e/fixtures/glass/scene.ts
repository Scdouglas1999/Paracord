/**
 * The Glass reference scene as data: who is here, what they said, who is in the
 * Lounge and what has and has not been read.
 *
 * Source of truth is `output/design-reference/glass/source/GlassV14.dc.html` and
 * its sibling artboards. Nothing here talks to a browser; `install.ts` turns it
 * into routes and a gateway stream.
 *
 * THE CLOCK. The scene is set on Thursday 1 October 2026, 9:12 PM Central
 * (CDT, UTC-5): the reference shows "Today 9:30" for the Haz 5 run, "Fri 2" for
 * Movie night, and weekday labels for the quieter channels. `install.ts` pins
 * the page's clock to `SCENE_NOW` and its timezone to `SCENE_TIMEZONE`, so
 * every label in a screenshot is the same on every machine on every day.
 *
 * KNOWN DIFFERENCES FROM THE ARTBOARD (kept deliberately small, listed in
 * docs/design/glass-g2-checkpoint.md): the reference's "8 online" and Basecamp's
 * "5 members" come from the guild's `member_count`; the member list itself is
 * the seven cast members, because the cast is what the scene needs.
 */

export const SCENE_TIMEZONE = 'America/Chicago';
export const SCENE_NOW_ISO = '2026-10-01T21:12:00-05:00';

/** Paracord snowflake epoch (2024-01-01). */
const EPOCH_MS = Date.UTC(2024, 0, 1);
let sequence = 0n;

/** A snowflake minted for a wall-clock moment, so message ids sort like time. */
export function snowflakeAt(iso: string): string {
  sequence += 1n;
  return ((BigInt(Date.parse(iso) - EPOCH_MS) << 22n) + sequence).toString();
}

/** `at('2026-10-01', '21:09')` in the scene's zone. */
export function at(day: string, time: string): string {
  return `${day}T${time}:00-05:00`;
}

const TODAY = '2026-10-01';

/* ------------------------------------------------------------------ cast */

export interface CastMember {
  id: string;
  username: string;
  display_name: string;
}

// Brandon and Brendan are both real names in the project's cast; only Brendan
// appears in this scene.
export const CAST = {
  sean: { id: '42', username: 'sean', display_name: 'Sean' },
  vincent: { id: '51', username: 'vincent', display_name: 'Vincent' },
  brendan: { id: '52', username: 'brendan', display_name: 'Brendan' },
  nick: { id: '53', username: 'nick', display_name: 'Nick' },
  jeremy: { id: '54', username: 'jeremy', display_name: 'Jeremy' },
  luke: { id: '55', username: 'luke', display_name: 'Luke' },
  eric: { id: '56', username: 'eric', display_name: 'Eric' },
} as const satisfies Record<string, CastMember>;

export type CastKey = keyof typeof CAST;

/** A complete user record. `avatar_hash: null` means the app draws initials. */
export function userRecord(who: CastMember) {
  return {
    id: who.id,
    username: who.username,
    display_name: who.display_name,
    discriminator: 1,
    avatar_hash: null,
    banner_hash: null,
    accent_color: null,
    bio: null,
    pronouns: null,
    email: `${who.username}@example.test`,
    email_verified: true,
    has_public_key: false,
    public_key: null,
    linked_accounts: [],
    bot: false,
    system: false,
    flags: 0,
    created_at: '2026-01-01T00:00:00-05:00',
  };
}

/* ---------------------------------------------------------------- servers */

export const GAME_NIGHT_ID = '1001';
export const BASECAMP_ID = '1002';

export const CH = {
  general: '2001',
  lounge: '2002',
  clips: '2003',
  lfg: '2004',
  patchNotes: '2005',
  trips: '2101',
  basecampGeneral: '2102',
  photos: '2103',
  gear: '2104',
} as const;

export const CHANNEL_KEYS = Object.keys(CH) as Array<keyof typeof CH>;

const TEXT = 0;
const VOICE = 2;

interface ChannelSeed {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position: number;
}

export const CHANNELS: ChannelSeed[] = [
  { id: CH.general, guild_id: GAME_NIGHT_ID, name: 'General', type: TEXT, position: 0 },
  { id: CH.lounge, guild_id: GAME_NIGHT_ID, name: 'Lounge', type: VOICE, position: 1 },
  { id: CH.clips, guild_id: GAME_NIGHT_ID, name: 'Clips', type: TEXT, position: 2 },
  { id: CH.lfg, guild_id: GAME_NIGHT_ID, name: 'LFG', type: TEXT, position: 3 },
  { id: CH.patchNotes, guild_id: GAME_NIGHT_ID, name: 'Patch notes', type: TEXT, position: 4 },
  { id: CH.trips, guild_id: BASECAMP_ID, name: 'Trips', type: TEXT, position: 0 },
  { id: CH.basecampGeneral, guild_id: BASECAMP_ID, name: 'General', type: TEXT, position: 1 },
  { id: CH.photos, guild_id: BASECAMP_ID, name: 'Photos', type: TEXT, position: 2 },
  { id: CH.gear, guild_id: BASECAMP_ID, name: 'Gear', type: TEXT, position: 3 },
];

export interface GuildSeed {
  id: string;
  name: string;
  member_count: number;
  banner_hash: string | null;
  members: CastKey[];
}

export const GUILDS: GuildSeed[] = [
  {
    id: GAME_NIGHT_ID,
    name: 'Game Night',
    member_count: 8,
    banner_hash: null,
    members: ['sean', 'vincent', 'brendan', 'nick', 'jeremy', 'luke', 'eric'],
  },
  {
    id: BASECAMP_ID,
    name: 'Basecamp',
    member_count: 5,
    banner_hash: `/api/v1/guilds/${BASECAMP_ID}/banner`,
    members: ['sean', 'eric', 'luke', 'jeremy', 'nick'],
  },
];

/* --------------------------------------------------------------- pictures */

export const ATTACHMENT = {
  mission: { id: '9001', file: 'mission-41-07.png', filename: 'mission-41-07.png', width: 480, height: 270 },
  photo: { id: '9002', file: 'photo-ridge.png', filename: 'ridge-first-light.png', width: 640, height: 400 },
} as const;

export const BANNER_FILE = 'basecamp-banner.png';

/* --------------------------------------------------------------- messages */

export interface MessageSeed {
  id: string;
  channel_id: string;
  author: CastKey;
  content: string;
  created_at: string;
  attachments?: Array<{ key: keyof typeof ATTACHMENT }>;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  poll?: {
    question: string;
    options: Array<{ text: string; votes: number; voted?: boolean }>;
  };
}

const msg = (
  channel: string,
  author: CastKey,
  day: string,
  time: string,
  content: string,
  extra: Partial<MessageSeed> = {},
): MessageSeed => {
  const created_at = at(day, time);
  return { id: snowflakeAt(created_at), channel_id: channel, author, content, created_at, ...extra };
};

/** Oldest first. `install.ts` serves them newest first, as the API does. */
export const MESSAGES: MessageSeed[] = [
  // Game Night · General — the reference conversation, exactly.
  msg(CH.general, 'sean', TODAY, '20:58', 'home in 20. what are we playing tonight?'),
  msg(CH.general, 'brendan', TODAY, '21:02', "okay who's actually on tonight? need two more for a haz 5 run"),
  // Stand-in for the plan card WP-G13 draws; the words are the card's.
  msg(CH.general, 'brendan', TODAY, '21:02', 'Haz 5 run: Tonight at 9:30 PM in Lounge'),
  msg(CH.general, 'vincent', TODAY, '21:04', 'already in Lounge streaming the warmup. come heckle'),
  msg(CH.general, 'nick', TODAY, '21:06', 'new personal best btw. 41 minutes, nobody went down'),
  msg(CH.general, 'nick', TODAY, '21:06', '', {
    attachments: [{ key: 'mission' }],
    reactions: [
      { emoji: '🔥', count: 5, me: false },
      { emoji: '🤍', count: 3, me: false },
    ],
  }),
  msg(CH.general, 'jeremy', TODAY, '21:09', "<@42> is Movie night still on? I'm bringing the projector"),

  // Game Night · Clips — three unread, the last is the 41:07.
  msg(CH.clips, 'brendan', TODAY, '20:47', 'that revive at 38 min though'),
  msg(CH.clips, 'luke', TODAY, '20:52', 'absolutely clean. how did you get to the pod'),
  msg(CH.clips, 'nick', TODAY, '21:06', 'new personal best, 41:07', { attachments: [{ key: 'mission' }] }),

  // Game Night · LFG — with a poll, and read.
  msg(CH.lfg, 'luke', TODAY, '20:35', 'Late one after the run?', {
    poll: {
      question: 'Late one after the run?',
      options: [
        { text: 'Count me in', votes: 3, voted: true },
        { text: 'Maybe one round', votes: 2 },
        { text: 'Bed', votes: 1 },
      ],
    },
  }),
  msg(CH.lfg, 'luke', TODAY, '20:40', 'anyone up for a late one after?'),

  // Game Night · Patch notes — quiet since Tuesday.
  msg(CH.patchNotes, 'vincent', '2026-09-29', '16:30', '1.4.2 is live. the revive window is back to 4 seconds'),

  // Basecamp · Trips — four unread.
  msg(CH.trips, 'eric', TODAY, '19:40', 'permits came through for Saturday'),
  msg(CH.trips, 'eric', TODAY, '19:40', 'rim trail, north lot at 7'),
  msg(CH.trips, 'luke', TODAY, '19:44', "I'll drive. leaving at 6 sharp, coffee on me"),
  msg(CH.trips, 'eric', TODAY, '19:48', "bring layers, it's 28° at the trailhead in the morning"),

  // Basecamp · the quiet ones.
  msg(CH.basecampGeneral, 'luke', TODAY, '18:15', 'see you all Saturday'),
  msg(CH.photos, 'eric', '2026-09-27', '11:20', 'shared 12 photos', { attachments: [{ key: 'photo' }] }),
  msg(CH.gear, 'luke', '2026-09-26', '14:05', 'anyone have a spare stove?'),
];

export const messagesIn = (channelId: string) => MESSAGES.filter((m) => m.channel_id === channelId);
export const lastMessageIn = (channelId: string) => messagesIn(channelId).at(-1) ?? null;
const firstMessageIn = (channelId: string) => messagesIn(channelId)[0];

/* ------------------------------------------------------------ read states */

export interface ReadStateSeed {
  channel_id: string;
  last_message_id: string;
  mention_count: number;
}

/**
 * What Sean has read. A channel absent from this list has never been opened;
 * the ones below are written so the sidebar shows exactly the reference badges:
 *
 *   General   read up to 8:58 PM, one mention (Jeremy)  -> "6 new since 8:58", @
 *   Clips     read up to before the first clip           -> 3
 *   Trips     read up to before the first message        -> 4
 *   the rest  read to their last message                 -> no badge
 */
export function readStates(): ReadStateSeed[] {
  const before = (channelId: string) => {
    const first = firstMessageIn(channelId);
    return String(BigInt(first.id) - 1n);
  };
  const general = messagesIn(CH.general);
  return [
    { channel_id: CH.general, last_message_id: general[0].id, mention_count: 1 },
    { channel_id: CH.clips, last_message_id: before(CH.clips), mention_count: 0 },
    { channel_id: CH.lfg, last_message_id: lastMessageIn(CH.lfg)!.id, mention_count: 0 },
    { channel_id: CH.patchNotes, last_message_id: lastMessageIn(CH.patchNotes)!.id, mention_count: 0 },
    { channel_id: CH.trips, last_message_id: before(CH.trips), mention_count: 0 },
    { channel_id: CH.basecampGeneral, last_message_id: lastMessageIn(CH.basecampGeneral)!.id, mention_count: 0 },
    { channel_id: CH.photos, last_message_id: lastMessageIn(CH.photos)!.id, mention_count: 0 },
    { channel_id: CH.gear, last_message_id: lastMessageIn(CH.gear)!.id, mention_count: 0 },
  ];
}

/* ----------------------------------------------------------------- events */

export interface EventSeed {
  id: string;
  guild_id: string;
  channel_id: string | null;
  creator: CastKey;
  name: string;
  scheduled_start: string;
  location: string | null;
  user_count: number;
  user_rsvp: boolean;
}

export const EVENTS: EventSeed[] = [
  {
    id: '7001',
    guild_id: GAME_NIGHT_ID,
    channel_id: CH.lounge,
    creator: 'brendan',
    name: 'Haz 5 run',
    scheduled_start: at(TODAY, '21:30'),
    location: null,
    user_count: 3,
    user_rsvp: false,
  },
  {
    id: '7002',
    guild_id: GAME_NIGHT_ID,
    channel_id: null,
    creator: 'sean',
    name: 'Movie night',
    scheduled_start: at('2026-10-02', '21:00'),
    location: "Sean's place",
    user_count: 6,
    user_rsvp: true,
  },
  {
    id: '7003',
    guild_id: BASECAMP_ID,
    channel_id: null,
    creator: 'eric',
    name: 'Rim trail hike',
    scheduled_start: at('2026-10-03', '07:00'),
    location: 'the north lot',
    user_count: 4,
    user_rsvp: true,
  },
];

/* ----------------------------------------------------------------- lights */

/** Who is in the Lounge, and what each is doing. */
export const LOUNGE = [
  { who: 'vincent', self_stream: true, self_video: false, self_mute: false, speaking: false },
  { who: 'brendan', self_stream: false, self_video: true, self_mute: false, speaking: true },
  { who: 'nick', self_stream: false, self_video: false, self_mute: true, speaking: false },
] as const satisfies ReadonlyArray<{
  who: CastKey;
  self_stream: boolean;
  self_video: boolean;
  self_mute: boolean;
  speaking: boolean;
}>;

/** Online now, by cast key. Eric is typing in General, so he is on. */
export const ONLINE: CastKey[] = ['sean', 'vincent', 'brendan', 'nick', 'jeremy', 'luke', 'eric'];

/** Eric is typing in General. */
export const TYPING = { channel_id: CH.general, who: 'eric' as CastKey };
