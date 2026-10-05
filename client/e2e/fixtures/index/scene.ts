/**
 * The Index reference scene as data: who is here, which servers they are in,
 * what each channel says, and what is already live.
 *
 * Source of truth is the approved prototype, `output/design-reference/index/
 * paracord-index.html` (its `P`, `S`, `DMS` and `steps` tables). Nothing here
 * talks to a browser: `world.ts` turns it into API payloads and gateway frames,
 * `harness.ts` puts those behind a Playwright page.
 *
 * THE CAST. You (Sean, the "S" in the dock), Jeremy, Vincent, Brendan, Nick and
 * Maya. The prototype's names are placeholders; what matters is that the same
 * six people appear in the same places on every reference state.
 *
 * THE CLOCK. The scene is set on Thursday 1 October 2026 in Central time (CDT,
 * UTC-5). The prototype's weekday labels (Sat, Mon,
 * Tue, Sun) are all within six days of a Thursday, "Friday" is tomorrow, and
 * the story runs from 9:38 PM to 10:02 PM. `harness.ts` pins the page's Date to
 * `CLOCK.start` and moves it as steps run, so every label ("9:41 PM", "Today",
 * "live 34 min", "Tue") is the same on every machine on every day.
 *
 * IDS. Every id is a decimal string. People and servers are minted so that
 * `paletteHue(id)` (docs/index-spec.md §2.2: index = the last nine digits mod
 * 11 into `PALETTE`) lands on the hue the prototype paints them with, or the
 * nearest hue the palette allows (it has no purples): the avatars and marks in
 * a screenshot match the reference without anything having to override them.
 */

export const SCENE_TIMEZONE = 'America/Chicago';
export const SCENE_DAY = '2026-10-01';
/** UTC offset of `SCENE_TIMEZONE` on every scene day (CDT; DST ends 1 November). */
const OFFSET = '-05:00';

/** `at('21:41')` is today 9:41 PM in the scene's zone; pass a day for another date. */
export function at(time: string, day: string = SCENE_DAY): string {
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  return `${day}T${hhmmss}${OFFSET}`;
}

/** The scene's moments, in order. A step moves the page's clock to its own. */
export const CLOCK = {
  /** s0: the new server, Jeremy's "see you tonight" is 26 minutes old. */
  start: at('21:38:00'),
  /** Jeremy's two messages and the clip arrive, then he hops into General. */
  arrive: at('21:44:20'),
  /** You join General. */
  join: at('21:45:10'),
  /** The call is open over the conversation (s3). */
  call: at('21:45:40'),
  /** Visiting Game Night while still in the call (s4): its Lounge is "live 34 min". */
  visit: at('21:46:50'),
  /** Vincent, Brendan and Maya come into General. */
  crowd: at('21:58:30'),
  /** The channel has moved on (s5): General is "live 18 min". */
  busy: at('22:02:20'),
} as const;

/** The eleven hues `paletteHue` can return (docs/index-spec.md §2.2). Never 250-320. */
export const PALETTE = [350, 8, 22, 36, 150, 162, 176, 190, 200, 214, 226] as const;

/** `paletteHue(id)` as the spec defines it: the last nine digits, mod 11, into `PALETTE`. */
export function paletteHueOf(id: string): number {
  return PALETTE[Number(id.slice(-9)) % PALETTE.length];
}

let minted = 0n;
/** An 18-digit id whose `paletteHue` is `PALETTE[hueIndex]`. */
function mint(hueIndex: number): string {
  minted += 1n;
  return (310_000_000_000_000_000n + minted * 1_000_000_000_000n + BigInt(hueIndex)).toString();
}

/* ------------------------------------------------------------------ cast */

export type PersonKey = 'you' | 'jeremy' | 'vincent' | 'brendan' | 'nick' | 'maya';

export interface Person {
  key: PersonKey;
  id: string;
  username: string;
  display_name: string;
  /** What the prototype paints this person's avatar with; the palette hue stands in for it. */
  prototypeHue: number;
}

const person = (key: PersonKey, display_name: string, prototypeHue: number, hueIndex: number): Person => ({
  key,
  id: mint(hueIndex),
  username: display_name.toLowerCase(),
  display_name,
  prototypeHue,
});

export const PEOPLE: Record<PersonKey, Person> = {
  // Prototype hues: J 24, V 30, B 210, N 160, S 200, M 330. 330 is magenta, which the
  // palette excludes; Maya takes 350, the nearest allowed hue.
  you: person('you', 'Sean', 200, 8),
  jeremy: person('jeremy', 'Jeremy', 24, 2),
  vincent: person('vincent', 'Vincent', 30, 3),
  brendan: person('brendan', 'Brendan', 210, 9),
  nick: person('nick', 'Nick', 160, 5),
  maya: person('maya', 'Maya', 330, 0),
};
export const ME = PEOPLE.you;
export const PERSON_KEYS = Object.keys(PEOPLE) as PersonKey[];

/**
 * Members who fill a server's head count and never speak, so "12 members" is
 * true of the member list and not only of a number. Offline throughout.
 */
export const FILLER_NAMES = ['Ari', 'Casey', 'Dana', 'Eli', 'Fran', 'Gus', 'Hana'] as const;
export type Identity = Pick<Person, 'id' | 'username' | 'display_name'>;
export const FILLER_PEOPLE: Identity[] = FILLER_NAMES.map((name) => ({
  id: mint(1),
  username: name.toLowerCase(),
  display_name: name,
}));

/** A complete user record. `avatar_hash: null` means the app draws the monogram. */
export function userRecord(who: Identity) {
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

/* --------------------------------------------------------------- servers */

export type GuildKey = 'fuel' | 'gameNight' | 'basecamp';
export type ChannelKey =
  // Fuel
  | 'fuelGeneral' | 'fuelClips' | 'fuelPlans' | 'fuelRoomGeneral' | 'fuelRoomLateNight'
  // Game Night
  | 'gnLounge' | 'gnLfg' | 'gnScreenshots' | 'gnRoomLounge' | 'gnRoomRanked'
  // Basecamp
  | 'bcGeneral' | 'bcBuilds' | 'bcRoomWorkshop'
  // Direct messages
  | 'dmJeremy' | 'dmNick' | 'dmMaya';

export interface ChannelSeed {
  key: ChannelKey;
  id: string;
  /** Null for a direct message. */
  guild: GuildKey | null;
  /** The channel's name (a DM has none). Text channels are lower case, rooms are title case, as the prototype shows. */
  name: string;
  kind: 'text' | 'voice' | 'dm';
  position: number;
  topic?: string;
  /** The other person in a direct message. */
  recipient?: PersonKey;
}

const CHANNEL_SEEDS: Omit<ChannelSeed, 'id'>[] = [
  // An empty channel's preview is its topic, or "No messages yet" without one: the
  // prototype's three lines. The prototype's page subtitles ("Fuel's main channel", ...)
  // are the product's to derive, not a topic.
  { key: 'fuelGeneral', guild: 'fuel', name: 'general', kind: 'text', position: 0 },
  { key: 'fuelClips', guild: 'fuel', name: 'clips', kind: 'text', position: 1, topic: 'Share your best moments' },
  { key: 'fuelPlans', guild: 'fuel', name: 'plans', kind: 'text', position: 2, topic: 'Nothing planned yet' },
  { key: 'fuelRoomGeneral', guild: 'fuel', name: 'General', kind: 'voice', position: 3 },
  { key: 'fuelRoomLateNight', guild: 'fuel', name: 'Late night', kind: 'voice', position: 4 },

  { key: 'gnLounge', guild: 'gameNight', name: 'lounge', kind: 'text', position: 0, topic: 'Hang out' },
  { key: 'gnLfg', guild: 'gameNight', name: 'looking-for-group', kind: 'text', position: 1, topic: 'Find a squad' },
  { key: 'gnScreenshots', guild: 'gameNight', name: 'screenshots', kind: 'text', position: 2, topic: 'Pics or it didn’t happen' },
  { key: 'gnRoomLounge', guild: 'gameNight', name: 'Lounge', kind: 'voice', position: 3 },
  { key: 'gnRoomRanked', guild: 'gameNight', name: 'Ranked', kind: 'voice', position: 4 },

  { key: 'bcGeneral', guild: 'basecamp', name: 'general', kind: 'text', position: 0, topic: 'Basecamp’s main channel' },
  { key: 'bcBuilds', guild: 'basecamp', name: 'builds', kind: 'text', position: 1, topic: 'Test builds' },
  { key: 'bcRoomWorkshop', guild: 'basecamp', name: 'Workshop', kind: 'voice', position: 2 },

  { key: 'dmJeremy', guild: null, name: '', kind: 'dm', position: 0, recipient: 'jeremy' },
  { key: 'dmNick', guild: null, name: '', kind: 'dm', position: 0, recipient: 'nick' },
  { key: 'dmMaya', guild: null, name: '', kind: 'dm', position: 0, recipient: 'maya' },
];

export const CHANNELS: ChannelSeed[] = CHANNEL_SEEDS.map((seed) => ({ ...seed, id: mint(0) }));
export const CH = Object.fromEntries(CHANNELS.map((c) => [c.key, c.id])) as Record<ChannelKey, string>;
export const channelSeed = (key: ChannelKey): ChannelSeed => CHANNELS.find((c) => c.key === key)!;

export interface GuildSeed {
  key: GuildKey;
  id: string;
  name: string;
  /**
   * An explicit server color (`guild.hue`, docs/index-spec.md §11), or null to
   * let the id decide. Fuel and Basecamp take the palette's own hue for their
   * ids (350 and 150, the prototype's); Game Night's 195 is not in the palette,
   * so it is set the way an admin would.
   */
  hue: number | null;
  member_count: number;
  /** Who is a member when the scene starts. */
  members: PersonKey[];
  /** Who is online when the scene starts. */
  online: PersonKey[];
  created_at: string;
}

export const GUILDS: GuildSeed[] = [
  {
    key: 'fuel',
    id: mint(0), // paletteHue 350
    name: 'Fuel',
    hue: null,
    member_count: 1,
    members: ['you'],
    online: ['you'],
    created_at: at('21:20:00'),
  },
  {
    key: 'gameNight',
    id: mint(7), // paletteHue 190; the explicit hue below is the prototype's 195
    name: 'Game Night',
    hue: 195,
    member_count: 12,
    members: ['you', 'vincent', 'brendan', 'nick', 'maya'],
    online: ['vincent', 'brendan', 'nick', 'maya'],
    created_at: '2026-08-14T19:00:00-05:00',
  },
  {
    key: 'basecamp',
    id: mint(4), // paletteHue 150
    name: 'Basecamp',
    hue: null,
    member_count: 5,
    members: ['you', 'brendan'],
    online: ['you', 'brendan'],
    created_at: '2026-07-02T10:00:00-05:00',
  },
];
export const GUILD = Object.fromEntries(GUILDS.map((g) => [g.key, g])) as Record<GuildKey, GuildSeed>;
/** Dock order, left to right after People (the prototype's `dockOrder`). */
export const DOCK_ORDER: GuildKey[] = ['fuel', 'gameNight', 'basecamp'];

/* -------------------------------------------------------------- pictures */

export const ATTACHMENTS = {
  /** A photo: the bytes are a generated PNG (`png.ts`), `variant` picks its color. */
  photo1: { id: mint(0), filename: 'photo-1.png', content_type: 'image/png', width: 640, height: 400, variant: 0 },
  photo2: { id: mint(0), filename: 'photo-2.png', content_type: 'image/png', width: 640, height: 400, variant: 1 },
  photo3: { id: mint(0), filename: 'photo-3.png', content_type: 'image/png', width: 640, height: 400, variant: 2 },
  photo4: { id: mint(0), filename: 'photo-4.png', content_type: 'image/png', width: 640, height: 400, variant: 3 },
  /** Jeremy's clip: a video attachment. The server answers its bytes with a still. */
  clip: { id: mint(0), filename: 'clip.mp4', content_type: 'video/mp4', width: 1280, height: 720, variant: 4 },
} as const;
export type AttachmentKey = keyof typeof ATTACHMENTS;

/* ------------------------------------------------------------ message seed */

export interface MessageSeed {
  channel: ChannelKey;
  author: PersonKey;
  content: string;
  /** RFC 3339 with the scene's offset. */
  at: string;
  attachments?: AttachmentKey[];
  /** `<event:ID>` posts: the scene event this message shares. */
  event?: EventKey;
}

const m = (
  channel: ChannelKey,
  author: PersonKey,
  time: string,
  content: string,
  extra: Partial<MessageSeed> & { day?: string } = {},
): MessageSeed => {
  const { day, ...rest } = extra;
  return { channel, author, content, at: at(time, day), ...rest };
};

const SAT = '2026-09-26';
const SUN = '2026-09-27';
const MON = '2026-09-28';
const TUE = '2026-09-29';

/**
 * What was said before the scene starts, oldest first. Fuel has no history at
 * all: that is the point of s0. Everything after (Jeremy, the busy channel) is
 * a step.
 */
export const HISTORY: MessageSeed[] = [
  // Game Night · lounge: the divider reads "Today 8:52 PM"; Vincent's line is the preview.
  m('gnLounge', 'brendan', '20:52:00', 'drop pod in five'),
  m('gnLounge', 'brendan', '20:52:30', 'bring the good guns this time'),
  m('gnLounge', 'nick', '20:55:00', 'I always bring the good guns'),
  m('gnLounge', 'vincent', '20:58:00', 'streaming in Lounge if anyone wants to watch'),
  // Game Night · looking-for-group: unread (the white dot on Game Night in the dock).
  m('gnLfg', 'maya', '20:31:00', 'need one for ranked'),
  // Game Night · screenshots: Saturday, so the row reads "Sat"; four photos, no text.
  m('gnScreenshots', 'nick', '01:12:00', '', { day: SAT, attachments: ['photo1', 'photo2', 'photo3', 'photo4'] }),
  // Basecamp: quiet, read.
  m('bcGeneral', 'brendan', '18:20:00', 'try the north ridge, it’s rough', { day: TUE }),
  m('bcGeneral', 'brendan', '18:20:30', 'pushed the new map', { day: TUE }),
  m('bcBuilds', 'brendan', '16:02:00', 'v0.4 is up', { day: MON }),
  // Direct messages. Jeremy's is today and the newest, so it opens first in People.
  m('dmJeremy', 'jeremy', '21:10:00', 'made the server yet?'),
  m('dmJeremy', 'you', '21:11:00', 'doing it now'),
  m('dmJeremy', 'jeremy', '21:12:00', 'see you tonight'),
  m('dmNick', 'nick', '23:02:00', 'that last round was a mess', { day: MON }),
  m('dmNick', 'you', '23:02:30', 'we got there', { day: MON }),
  m('dmNick', 'nick', '23:03:00', 'lol yeah', { day: MON }),
  m('dmMaya', 'maya', '14:40:00', 'ok sending the invite', { day: SUN }),
];

/** Channels where you have read everything. Anything not listed here is read; these are the exceptions. */
export const UNREAD_AT_START: ChannelKey[] = ['gnLfg'];

/* ----------------------------------------------------------------- events */

export type EventKey = 'movieNight';

export interface EventSeed {
  key: EventKey;
  id: string;
  guild: GuildKey;
  room: ChannelKey | null;
  creator: PersonKey;
  name: string;
  scheduled_start: string;
  user_count: number;
}

export const EVENTS: EventSeed[] = [
  {
    key: 'movieNight',
    id: mint(0),
    guild: 'fuel',
    room: 'fuelRoomGeneral',
    creator: 'jeremy',
    name: 'Movie night',
    // Friday 9:00 PM: the "Fri 9 PM" the plans preview and the Coming up row read.
    scheduled_start: at('21:00', '2026-10-02'),
    user_count: 2,
  },
];
export const EVENT = Object.fromEntries(EVENTS.map((e) => [e.key, e])) as Record<EventKey, EventSeed>;

/* ------------------------------------------------------------------ voice */

export interface VoiceSeed {
  who: PersonKey;
  room: ChannelKey;
  /** RFC 3339: when this person came into the room. The earliest is when the room went live. */
  joined_at: string;
  self_stream?: boolean;
  self_video?: boolean;
  self_mute?: boolean;
}

/**
 * Who is in a room when the scene starts. Game Night's Lounge has been live
 * since 9:12 PM: at `CLOCK.visit` (9:46:50) it reads "live 34 min", and Vincent
 * is sharing his screen and talking, so the Lounge's card says "Watch Vincent".
 */
export const VOICE_AT_START: VoiceSeed[] = [
  { who: 'vincent', room: 'gnRoomLounge', joined_at: at('21:12:50'), self_stream: true },
  { who: 'brendan', room: 'gnRoomLounge', joined_at: at('21:13:10') },
  { who: 'nick', room: 'gnRoomLounge', joined_at: at('21:20:00') },
];
/** Who is talking when the scene starts. */
export const SPEAKING_AT_START: PersonKey[] = ['vincent'];

/** Where the live minutes come from: Vincent's stream began with the room. */
export const STREAM_STARTED_AT = at('21:12:50');
