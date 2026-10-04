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
/** The third circle in the server row of the reference: a live match, two mentions. */
export const SUNDAY_LEAGUE_ID = '1003';

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
  matchDay: '2201',
  pitch: '2202',
  dmBrendan: '3001',
  dmNick: '3002',
} as const;

export const CHANNEL_KEYS = Object.keys(CH) as Array<keyof typeof CH>;

const TEXT = 0;
const DM = 1;
const VOICE = 2;

interface ChannelSeed {
  id: string;
  /** Null for a direct message. */
  guild_id: string | null;
  name: string;
  type: number;
  position: number;
  /** The other person in a direct message. */
  recipient?: CastKey;
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
  { id: CH.matchDay, guild_id: SUNDAY_LEAGUE_ID, name: 'Match day', type: TEXT, position: 0 },
  { id: CH.pitch, guild_id: SUNDAY_LEAGUE_ID, name: 'Pitch', type: VOICE, position: 1 },
  // Two unread conversations: the "2" on the tray in the server row.
  { id: CH.dmBrendan, guild_id: null, name: '', type: DM, position: 0, recipient: 'brendan' },
  { id: CH.dmNick, guild_id: null, name: '', type: DM, position: 0, recipient: 'nick' },
];

export interface GuildSeed {
  id: string;
  name: string;
  member_count: number;
  banner_hash: string | null;
  /** A picture in this folder; `install.ts` serves it as the server's stored icon. */
  icon: string | null;
  members: CastKey[];
}

export const GUILDS: GuildSeed[] = [
  {
    id: GAME_NIGHT_ID,
    name: 'Game Night',
    member_count: 8,
    banner_hash: null,
    icon: 'icon-game-night.png',
    members: ['sean', 'vincent', 'brendan', 'nick', 'jeremy', 'luke', 'eric'],
  },
  {
    id: BASECAMP_ID,
    name: 'Basecamp',
    member_count: 5,
    banner_hash: `/api/v1/guilds/${BASECAMP_ID}/banner`,
    icon: 'icon-basecamp.png',
    members: ['sean', 'eric', 'luke', 'jeremy', 'nick'],
  },
  {
    id: SUNDAY_LEAGUE_ID,
    name: 'Sunday League',
    member_count: 12,
    banner_hash: null,
    icon: 'icon-sunday-league.png',
    members: ['sean', 'luke', 'jeremy'],
  },
];

/* --------------------------------------------------------------- pictures */

export const ATTACHMENT = {
  mission: { id: '9001', file: 'mission-41-07.png', filename: 'mission-41-07.png', width: 480, height: 270 },
  photo: { id: '9002', file: 'photo-ridge.png', filename: 'ridge-first-light.png', width: 640, height: 400 },
  // Not in the reference scene: shapes a review shot can add (WP-G13) — a tall
  // picture (the frame crops past 320px) and a file that is not a picture.
  tall: { id: '9004', file: 'photo-ridge.png', filename: 'ridge-portrait.png', width: 300, height: 600 },
  doc: { id: '9005', file: 'photo-ridge.png', filename: 'patch-notes-1.4.2.pdf', width: 0, height: 0, contentType: 'application/pdf' },
} as const satisfies Record<string, { id: string; file: string; filename: string; width: number; height: number; contentType?: string }>;

export const BANNER_FILE = 'basecamp-banner.png';

/* --------------------------------------------------------------- messages */

export interface MessageSeed {
  id: string;
  channel_id: string;
  author: CastKey;
  content: string;
  created_at: string;
  attachments?: Array<{ key: keyof typeof ATTACHMENT }>;
  /** The message this one answers (a reply). */
  reference_id?: string;
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
  // An event shared on its own: the plan card (WP-G13). `<event:7001>` is Haz 5 run.
  msg(CH.general, 'brendan', TODAY, '21:02', '<event:7001>'),
  // `<#2002>` is the Lounge, with people in it: the live-channel chip.
  msg(CH.general, 'vincent', TODAY, '21:04', `already in <#${CH.lounge}> streaming the warmup. come heckle`),
  msg(CH.general, 'nick', TODAY, '21:06', 'new personal best btw. 41 minutes, nobody went down'),
  msg(CH.general, 'nick', TODAY, '21:06', '', {
    attachments: [{ key: 'mission' }],
    reactions: [
      { emoji: '🔥', count: 5, me: false },
      { emoji: '🤍', count: 3, me: false },
    ],
  }),
  // `<event:7002>` is Movie night, named inside a sentence: the event chip.
  msg(CH.general, 'jeremy', TODAY, '21:09', "<@42> is <event:7002> still on? I'm bringing the projector"),

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

  // Game Night · Patch notes — quiet since Tuesday last week (nine days): a
  // channel with nothing new for more than a week is the places panel's
  // one-line row (WP-G9). The reference draws it as "Tue".
  msg(CH.patchNotes, 'vincent', '2026-09-22', '16:30', '1.4.2 is live. the revive window is back to 4 seconds'),

  // Basecamp · Trips — four unread.
  msg(CH.trips, 'eric', TODAY, '19:40', 'permits came through for Saturday'),
  msg(CH.trips, 'eric', TODAY, '19:40', 'rim trail, north lot at 7'),
  msg(CH.trips, 'luke', TODAY, '19:44', "I'll drive. leaving at 6 sharp, coffee on me"),
  msg(CH.trips, 'eric', TODAY, '19:48', "bring layers, it's 28° at the trailhead in the morning"),

  // Sunday League · Match day — two mentions of Sean, unread.
  msg(CH.matchDay, 'luke', TODAY, '20:10', '<@42> kickoff is 10 sharp, bring the away shirts'),
  msg(CH.matchDay, 'jeremy', TODAY, '20:31', '<@42> can you take the second half in goal?'),

  // Direct messages, unread.
  msg(CH.dmBrendan, 'brendan', TODAY, '20:55', 'you around for the haz run? we need a fourth'),
  msg(CH.dmNick, 'nick', TODAY, '20:20', 'sent you the 41:07 clip'),

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
 *   Match day read up to before its first message, 2 mentions -> the white @2 on
 *             Sunday League's circle
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
    { channel_id: CH.matchDay, last_message_id: before(CH.matchDay), mention_count: 2 },
    { channel_id: CH.dmBrendan, last_message_id: before(CH.dmBrendan), mention_count: 0 },
    { channel_id: CH.dmNick, last_message_id: before(CH.dmNick), mention_count: 0 },
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
    location: null,
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

/** Who is on the pitch in Sunday League: a live match, so the circle wears the amber ring. */
export const PITCH = [
  { who: 'luke', self_stream: true, self_video: false, self_mute: false, speaking: true },
  { who: 'jeremy', self_stream: false, self_video: false, self_mute: true, speaking: false },
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
