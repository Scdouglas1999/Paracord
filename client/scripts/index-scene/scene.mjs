// The Index reference scene as data: who is in it, which servers, channels and
// rooms exist, what was said, and the four moments of the story the reference
// renders (output/design-reference/index/ref/*.png) are cut from.
//
// Source of truth is the prototype, output/design-reference/index/
// paracord-index.html (its `P`, `S`, `DMS` and `steps`). Keys are stable
// identifiers the driver uses; `name` is what the UI shows. Placeholders stay
// placeholders: nothing here is tuned to the prototype beyond what a reference
// state needs to be recognisable (docs/index-spec.md, "Reference material").
//
// Message text may carry `{@name}` (a mention of that cast member); seed.mjs
// resolves it to the id the instance issued.

export const PASSWORD = 'Index-Scene-Password-123!';
/** The passphrase every cast member's end-to-end encryption is set up with. */
export const ENCRYPTION_PASSWORD = 'index scene encryption passphrase';
export const EMAIL_DOMAIN = 'index-scene.test';

/** The cast, by key. `name` is the display name the UI shows. */
export const CAST = {
  sean: { name: 'Sean', note: 'you: the viewer; every --shot is from this browser' },
  jeremy: { name: 'Jeremy', note: 'arrives in Fuel, hops into General' },
  vincent: { name: 'Vincent', note: 'streams in Game Night › Lounge, then moves to Fuel › General' },
  brendan: { name: 'Brendan', note: 'in Lounge, then Fuel › General' },
  nick: { name: 'Nick', note: 'in Lounge, muted, the whole time' },
  maya: { name: 'Maya', note: 'offline until the busy step, then joins Fuel › General' },
};

/**
 * People who only make a server's member count honest ("12 members") and never
 * do anything. Names are placeholders.
 */
export const FILLERS = [
  { key: 'priya', name: 'Priya' },
  { key: 'tomas', name: 'Tomas' },
  { key: 'wren', name: 'Wren' },
  { key: 'kofi', name: 'Kofi' },
  { key: 'lena', name: 'Lena' },
  { key: 'marcus', name: 'Marcus' },
  { key: 'ines', name: 'Ines' },
];

/**
 * Servers are created in this order, which is the order of the dock (join
 * order, spec 4.8): Fuel, Game Night, Basecamp. None has an icon, so the
 * monograms show (spec 2.3). `hue` is the prototype's server color; it is
 * stored only when the instance has the server `hue` field (IX-2), and the
 * seed says plainly whether it was.
 *
 * Channel keys are the driver's handles. Text channels are lower case, as in
 * the prototype; rooms (voice channels) are named as the prototype names them.
 */
export const SERVERS = [
  {
    key: 'fuel',
    name: 'Fuel',
    owner: 'sean',
    hue: 350,
    // Fuel starts empty: Sean alone. Everyone else arrives during the story.
    members: [],
    // Jeremy plans Movie night in the busy step, and creating an event needs
    // Manage Server.
    roles: [{ name: 'Hosts', permissions: 1 << 5, members: [] }],
    channels: [
      { key: 'general', name: 'general', type: 0, reuse: 0, topic: 'Fuel’s main channel' },
      { key: 'clips', name: 'clips', type: 0, topic: 'Highlights from calls and games' },
      { key: 'plans', name: 'plans', type: 0, topic: 'Game nights and meetups' },
      { key: 'generalRoom', name: 'General', type: 2, reuse: 2 },
      { key: 'lateNight', name: 'Late night', type: 2 },
    ],
  },
  {
    key: 'gameNight',
    name: 'Game Night',
    owner: 'brendan',
    hue: 195,
    // 5 cast + 7 fillers = the prototype's 12 members.
    members: ['sean', 'vincent', 'nick', 'maya', 'priya', 'tomas', 'wren', 'kofi', 'lena', 'marcus', 'ines'],
    channels: [
      { key: 'lounge', name: 'lounge', type: 0, reuse: 0, topic: 'Hang out' },
      { key: 'lfg', name: 'looking-for-group', type: 0, topic: 'Find a squad' },
      { key: 'screenshots', name: 'screenshots', type: 0, topic: 'Pics or it didn’t happen' },
      { key: 'loungeRoom', name: 'Lounge', type: 2, reuse: 2 },
      { key: 'ranked', name: 'Ranked', type: 2 },
    ],
  },
  {
    key: 'basecamp',
    name: 'Basecamp',
    owner: 'brendan',
    hue: 150,
    members: ['sean', 'priya', 'tomas', 'wren'],
    channels: [
      { key: 'general', name: 'general', type: 0, reuse: 0, topic: 'Basecamp’s main channel' },
      { key: 'builds', name: 'builds', type: 0, topic: 'Test builds' },
      { key: 'workshop', name: 'Workshop', type: 2, reuse: 2 },
    ],
  },
];

/**
 * The call that is already running before the story starts, held by real
 * browsers: Vincent shares a canvas and talks, Brendan listens, Nick is muted
 * (the prototype's Lounge: V talking and streaming, B, N). `voice` is the
 * synthetic microphone each one has (media-init.mjs).
 */
export const LOUNGE = {
  server: 'gameNight',
  room: 'loungeRoom',
  members: [
    { who: 'vincent', share: true, voice: 'talking' },
    { who: 'brendan', voice: 'quiet' },
    { who: 'nick', mute: true, voice: 'quiet' },
  ],
};

/**
 * Posts in the order they land, before the story starts. `read: 'sean'` marks
 * Sean's read state at the newest message of that channel so far, which is
 * what leaves looking-for-group as the one unread channel in Game Night (the
 * prototype's white dot on G in the dock).
 */
export const POSTS = [
  // Basecamp, oldest first.
  { server: 'basecamp', channel: 'builds', by: 'brendan', text: 'v0.4 is up' },
  { server: 'basecamp', channel: 'builds', read: 'sean' },
  { server: 'basecamp', channel: 'general', by: 'brendan', text: 'pushed the new map' },
  { server: 'basecamp', channel: 'general', by: 'brendan', text: 'try the north ridge, it’s rough' },
  { server: 'basecamp', channel: 'general', read: 'sean' },

  // Game Night.
  { server: 'gameNight', channel: 'screenshots', by: 'nick', images: ['photo-0', 'photo-1', 'photo-2', 'photo-3'] },
  { server: 'gameNight', channel: 'screenshots', read: 'sean' },
  { server: 'gameNight', channel: 'lfg', by: 'maya', text: 'need one for ranked' },
  { server: 'gameNight', channel: 'lounge', by: 'brendan', text: 'drop pod in five' },
  { server: 'gameNight', channel: 'lounge', by: 'brendan', text: 'bring the good guns this time' },
  { server: 'gameNight', channel: 'lounge', by: 'nick', text: 'I always bring the good guns' },
  { server: 'gameNight', channel: 'lounge', by: 'vincent', text: 'streaming in Lounge if anyone wants to watch' },
  { server: 'gameNight', channel: 'lounge', read: 'sean' },
];

/**
 * Direct messages, oldest conversation first so People lists them as the
 * prototype does (Jeremy newest, then Nick, then Maya). End-to-end encrypted:
 * every line is typed into its author's own composer, because the client does
 * the sealing (seed.mjs, `seedDirectMessages`).
 */
export const DMS = [
  { with: 'maya', lines: [['maya', 'ok sending the invite']] },
  { with: 'nick', lines: [['nick', 'that last round was a mess'], ['sean', 'we got there'], ['nick', 'lol yeah']] },
  { with: 'jeremy', lines: [['jeremy', 'made the server yet?'], ['sean', 'doing it now'], ['jeremy', 'see you tonight']] },
];

/** Images posted as attachments, by name (assets.mjs of the Glass scene renders them). */
export const IMAGE_NAMES = ['photo-0', 'photo-1', 'photo-2', 'photo-3'];

// -------------------------------------------------------------- the story

/**
 * The moments after the quiet start. Each is one `--step`; `story.mjs` runs
 * them. Listed here so the README of the whole scene is in one file.
 *
 *   quiet    (start)  Fuel is new: Sean alone, general opens on "Fuel is ready".
 *                     Game Night's Lounge is live (Vincent sharing, Brendan,
 *                     Nick) and looking-for-group is unread.
 *   arrive            Jeremy joins Fuel, says hello in general, posts a clip,
 *                     and joins General, talking.
 *   join              Sean joins General from the card.
 *   busy              Vincent and Brendan move from Lounge to General, Maya
 *                     comes online and joins, Jeremy mutes and Vincent talks,
 *                     Nick, Maya, Jeremy and Sean talk in general, Jeremy
 *                     plans Movie night.
 *   reset             Back to quiet.
 */
export const STEPS = ['arrive', 'join', 'busy', 'reset'];

/** What is said in Fuel › general when someone arrives. */
export const ARRIVE_MESSAGES = [
  { by: 'jeremy', text: 'hey! finally made it in' },
  { by: 'jeremy', text: 'who’s up for a run tonight? I’m in General' },
];

/** What is said in Fuel › general when it gets busy (prototype step 5). */
export const BUSY_MESSAGES = [
  { by: 'vincent', text: 'already in, come heckle' },
  { by: 'brendan', text: 'need two more for a haz 5 run' },
  { by: 'brendan', text: 'Nick you in?' },
  { by: 'nick', text: 'new personal best btw. 41 minutes, nobody went down' },
  { by: 'sean', text: 'that’s actually insane' },
  { by: 'maya', text: 'clip it next time' },
  { by: 'jeremy', text: 'movie night still on friday?' },
  { by: 'nick', text: 'yep, bringing the projector' },
];

/** The next occurrence of a weekday (0 = Sunday) at a local time. */
export function nextWeekday(weekday, hours, minutes = 0, from = new Date()) {
  const d = new Date(from);
  d.setHours(hours, minutes, 0, 0);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
  if (d <= from) d.setDate(d.getDate() + 7);
  return d;
}
