// The Glass reference scene as data: who is in it, which servers and channels
// exist, what was said, what is coming up. Taken from the reference renders
// (output/design-reference/glass/screens/*.png) and their sources.
//
// Message text may carry `{@name}` (a mention of that cast member) and
// `{#channelKey}` (a link to that channel in the same server); seed.mjs
// resolves both to the ids the instance issued.
//
// Order is meaningful: posts land in the order listed, so the last post in a
// channel is its preview, and General in Game Night is posted last so it is the
// most recent conversation, as in 01-conversation.

export const PASSWORD = 'Glass-Scene-Password-123!';

/** Cast, by key. `name` is the display name the UI shows. */
export const CAST = {
  sean: { name: 'Sean', note: 'the viewer; every --shot is from his browser' },
  vincent: { name: 'Vincent', note: 'in Lounge, sharing his screen' },
  brendan: { name: 'Brendan', note: 'in Lounge, camera on, talking' },
  nick: { name: 'Nick', note: 'in Lounge, muted' },
  jeremy: { name: 'Jeremy', note: 'online, mentions Sean' },
  luke: { name: 'Luke', note: 'online' },
  eric: { name: 'Eric', note: 'online, typing in General' },
};

/** Who holds a browser in the Lounge call, and how. */
export const CALL = {
  server: 'gameNight',
  channel: 'lounge',
  members: [
    { who: 'vincent', share: true, voice: 'quiet' },
    { who: 'brendan', camera: true, voice: 'talking' },
    { who: 'nick', mute: true, voice: 'quiet' },
  ],
};

/** Accounts kept online by a bare realtime stream (no browser). */
export const AROUND = ['jeremy', 'luke', 'eric'];

/** Someone typing in a conversation for as long as the scene is held. */
export const TYPING = { who: 'eric', server: 'gameNight', channel: 'general' };

// Servers are created in this order, which is the order of Sean's server row.
export const SERVERS = [
  {
    key: 'gameNight',
    name: 'Game Night',
    owner: 'brendan',
    icon: 'gameNight',
    members: ['sean', 'vincent', 'nick', 'jeremy', 'luke', 'eric'],
    // Sean hosts Movie night, and creating an event needs Manage Server.
    roles: [{ name: 'Hosts', permissions: 1 << 5, members: ['sean'] }],
    channels: [
      { key: 'general', name: 'General', type: 0, reuse: 0, topic: 'Haz 5 runs from 9. Bring snacks.' },
      { key: 'lounge', name: 'Lounge', type: 2, reuse: 2 },
      { key: 'clips', name: 'Clips', type: 0 },
      { key: 'lfg', name: 'LFG', type: 0 },
      { key: 'patchNotes', name: 'Patch notes', type: 0 },
    ],
  },
  {
    key: 'basecamp',
    name: 'Basecamp',
    owner: 'eric',
    icon: 'basecamp',
    banner: true,
    members: ['sean', 'luke', 'jeremy', 'brendan'],
    channels: [
      // The default text channel becomes Trips so the order needs no reshuffle.
      { key: 'trips', name: 'Trips', type: 0, reuse: 0 },
      { key: 'general', name: 'General', type: 0 },
      { key: 'photos', name: 'Photos', type: 0 },
      { key: 'gear', name: 'Gear', type: 0 },
    ],
    dropDefaultVoice: true,
  },
  {
    // In the reference's server row with two mentions for Sean.
    key: 'sundayLeague',
    name: 'Sunday League',
    owner: 'luke',
    icon: 'sundayLeague',
    members: ['sean', 'nick', 'jeremy'],
    channels: [{ key: 'matchday', name: 'Matchday', type: 0, reuse: 0 }],
    dropDefaultVoice: true,
  },
];

/**
 * Posts in the order they land. `read: 'sean'` marks Sean's read state at the
 * newest message of that channel so far, which is what sets the unread badges
 * of the reference (General: a mention; Clips 3; Trips 4).
 */
export const POSTS = [
  // Sunday League — two mentions of Sean, unread.
  { server: 'sundayLeague', channel: 'matchday', by: 'luke', text: '{@sean} you\'re in goal on Sunday, Dave\'s knee is still out' },
  { server: 'sundayLeague', channel: 'matchday', by: 'nick', text: '{@sean} can you bring the spare bibs' },

  // Basecamp, oldest first.
  { server: 'basecamp', channel: 'gear', by: 'luke', text: 'anyone have a spare stove?' },
  { server: 'basecamp', channel: 'gear', read: 'sean' },
  { server: 'basecamp', channel: 'photos', by: 'eric', text: 'from the ridge last weekend', images: ['photo-0', 'photo-1', 'photo-2', 'photo-3'] },
  { server: 'basecamp', channel: 'photos', read: 'sean' },
  { server: 'basecamp', channel: 'general', by: 'luke', text: 'see you all Saturday' },
  { server: 'basecamp', channel: 'general', read: 'sean' },
  { server: 'basecamp', channel: 'trips', by: 'sean', text: 'has anyone heard back about the permits?' },
  { server: 'basecamp', channel: 'trips', read: 'sean' },
  { server: 'basecamp', channel: 'trips', by: 'eric', text: 'permits came through for Saturday' },
  { server: 'basecamp', channel: 'trips', by: 'eric', text: 'rim trail, north lot at 7' },
  { server: 'basecamp', channel: 'trips', by: 'luke', text: 'I\'ll drive. leaving at 6 sharp, coffee on me' },
  { server: 'basecamp', channel: 'trips', by: 'eric', text: 'bring layers, it\'s 28° at the trailhead in the morning' },

  // Game Night.
  { server: 'gameNight', channel: 'patchNotes', by: 'vincent', text: 'Season 6 patch is live: new biome, flare rework, two new warnings' },
  { server: 'gameNight', channel: 'patchNotes', read: 'sean' },
  { server: 'gameNight', channel: 'lfg', by: 'luke', poll: { question: 'What are we playing after the run?', options: ['Another haz 5', 'Lethal Company', 'Call it a night'] }, votes: { 0: ['brendan', 'nick'], 1: ['jeremy', 'vincent'], 2: ['eric'] } },
  { server: 'gameNight', channel: 'lfg', by: 'luke', text: 'anyone up for a late one after?' },
  { server: 'gameNight', channel: 'lfg', read: 'sean' },
  { server: 'gameNight', channel: 'clips', by: 'vincent', text: 'clip dump from last night' },
  { server: 'gameNight', channel: 'clips', read: 'sean' },
  { server: 'gameNight', channel: 'clips', by: 'brendan', text: 'that revive at 38 min though', images: ['triple-revive'], label: 'revive' },
  { server: 'gameNight', channel: 'clips', by: 'luke', text: 'absolutely clean. how did you get to the pod', replyTo: 'revive' },
  { server: 'gameNight', channel: 'clips', by: 'nick', text: 'new personal best btw', images: ['mission-complete'] },
  { server: 'gameNight', channel: 'general', by: 'luke', text: 'patch dropped at 6, servers were rough for a bit' },
  { server: 'gameNight', channel: 'general', by: 'vincent', text: 'haz 4 warmup first, then the real one' },
  { server: 'gameNight', channel: 'general', by: 'sean', text: 'home in 20. what are we playing tonight?' },
  { server: 'gameNight', channel: 'general', read: 'sean' },
  { server: 'gameNight', channel: 'general', by: 'brendan', text: 'okay who\'s actually on tonight? need two more for a haz 5 run' },
  { server: 'gameNight', channel: 'general', by: 'vincent', text: 'already in {#lounge} streaming the warmup. come heckle' },
  {
    server: 'gameNight', channel: 'general', by: 'nick', text: 'new personal best btw. 41 minutes, nobody went down', images: ['mission-complete'],
    reactions: { '🔥': ['sean', 'brendan', 'vincent', 'luke', 'jeremy'], '❤️': ['brendan', 'luke', 'eric'] },
  },
  { server: 'gameNight', channel: 'general', by: 'jeremy', text: '{@sean} is movie night still on? I\'m bringing the projector' },
];

function atLocal(date, hours, minutes) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d;
}
function nextWeekday(weekday, hours, minutes) {
  const now = new Date();
  const d = atLocal(now, hours, minutes);
  const ahead = (weekday - now.getDay() + 7) % 7;
  d.setDate(d.getDate() + ahead);
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}
/** Tonight at 9:30 PM, or the next half hour when that has passed. */
function tonightAtHalfPastNine() {
  const now = new Date();
  const d = atLocal(now, 21, 30);
  if (d > now) return d;
  const soon = new Date(now.getTime() + 30 * 60 * 1000);
  soon.setMinutes(soon.getMinutes() < 30 ? 30 : 60, 0, 0);
  return soon;
}

export const EVENTS = [
  {
    server: 'gameNight', by: 'brendan', name: 'Haz 5 run', start: tonightAtHalfPastNine, hours: 1.5,
    entity: 1, channel: 'lounge', description: 'Hazard 5, four slots. Bring flares.',
    rsvps: ['brendan', 'vincent', 'luke'],
  },
  {
    server: 'gameNight', by: 'sean', name: 'Movie night', start: () => nextWeekday(5, 21, 0), hours: 2.5,
    entity: 1, channel: 'lounge', description: 'Jeremy is bringing the projector.',
    rsvps: ['sean', 'jeremy', 'nick', 'vincent', 'brendan', 'luke'],
  },
  {
    server: 'basecamp', by: 'eric', name: 'Rim trail hike', start: () => nextWeekday(6, 7, 0), hours: 6,
    entity: 2, location: 'North lot, rim trail', description: 'Permits sorted. Layers, it is 28° at the trailhead.',
    rsvps: ['eric', 'luke', 'sean', 'jeremy'],
  },
];

/** Images posted as attachments, by name → art source (see assets.mjs). */
export const IMAGES = {
  'mission-complete': { art: 'MISSION_COMPLETE', width: 1280, height: 720 },
  'triple-revive': { art: 'TRIPLE_REVIVE', width: 1280, height: 720 },
  'photo-0': { art: 'trailPhoto', variant: 0, width: 1280, height: 720 },
  'photo-1': { art: 'trailPhoto', variant: 1, width: 1280, height: 720 },
  'photo-2': { art: 'trailPhoto', variant: 2, width: 1280, height: 720 },
  'photo-3': { art: 'trailPhoto', variant: 3, width: 1280, height: 720 },
};
