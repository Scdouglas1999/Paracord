// Stand the Index scene up on an instance through its public API, as the cast.
// Idempotent by inspection: a complete scene is found and reused; a partial
// one (a run killed half way) is deleted by its owners and rebuilt. Nothing
// here reaches into the database or seeds anything the product's own API would
// not accept.
//
// Servers get no icon and people no avatar, so the monograms show (spec 2.3).

import { CAST, EMAIL_DOMAIN, FILLERS, PASSWORD, POSTS, SERVERS, nextWeekday } from './scene.mjs';

const channelType = c => c.channel_type ?? c.type;

export function castAccount(key, name, tag = '') {
  return {
    key,
    name,
    username: `${key}${tag}`,
    email: `${key}${tag}@${EMAIL_DOMAIN}`,
    password: PASSWORD,
  };
}

/** Every account the scene uses, cast first. */
export function allAccounts(tag = '') {
  return [
    ...Object.entries(CAST).map(([key, c]) => castAccount(key, c.name, tag)),
    ...FILLERS.map(f => castAccount(f.key, f.name, tag)),
  ];
}

/** Register (or sign in) everyone and set display names. No avatars: monograms. */
export async function signInPeople(api, { tag = '', known = null, log = () => {} } = {}) {
  const people = {};
  let likelyExists = Boolean(known?.sean);
  for (const account of allAccounts(tag)) {
    const session = await api.account(account, { likelyExists });
    // Whatever the first account turned out to be, the rest almost certainly are too.
    likelyExists = !session.created;
    const person = { ...account, ...session };
    const me = await api.request(person.token, 'GET', '/users/@me');
    if (me.display_name !== person.name) {
      await api.request(person.token, 'PATCH', '/users/@me', { display_name: person.name });
    }
    people[account.key] = person;
    api.keepSignedIn(person);
    if (CAST[account.key]) {
      log(`  ${person.name.padEnd(8)} ${person.username.padEnd(12)} id=${person.id}${session.created ? '  (new)' : ''}`);
    }
  }
  log(`  ${FILLERS.map(f => f.name).join(', ')}  (fillers, they only make the member counts honest)`);
  return people;
}

/** A fresh REST token for each (a session ends when its account enrolls encryption). */
export async function refreshTokens(api, people, keys) {
  for (const key of keys) {
    const person = people[key];
    const session = await api.account(person, { likelyExists: true });
    person.token = session.token;
    api.keepSignedIn(person);
  }
}

/**
 * Find the scene on the instance. Returns `{ complete, found, ids }`, where
 * `ids.servers[key] = { id, name, channels: { key: id } }`.
 */
export async function findScene(api, people) {
  const sean = people.sean;
  const guilds = await api.request(sean.token, 'GET', '/users/@me/guilds');
  const ids = { servers: {} };
  const found = [];
  let complete = true;
  for (const server of SERVERS) {
    const owner = people[server.owner];
    const guild = guilds.find(g => g.name === server.name && String(g.owner_id) === owner.id);
    if (!guild) { complete = false; continue; }
    found.push({ key: server.key, id: String(guild.id), owner: server.owner });
    const channels = await api.request(sean.token, 'GET', `/guilds/${guild.id}/channels`);
    const byKey = {};
    for (const spec of server.channels) {
      const match = channels.find(c => c.name === spec.name && channelType(c) === spec.type);
      if (match) byKey[spec.key] = String(match.id);
      else complete = false;
    }
    ids.servers[server.key] = { id: String(guild.id), name: server.name, channels: byKey };
  }
  if (complete) {
    // The last post of the seed is Vincent's line in Lounge; if it is there,
    // everything before it is too.
    const last = POSTS.filter(p => p.by).at(-1);
    const channelId = ids.servers[last.server].channels[last.channel];
    const messages = await api.request(sean.token, 'GET', `/channels/${channelId}/messages?limit=3`);
    complete = Array.isArray(messages) && messages.some(m => String(m.author?.id) === people[last.by].id && m.content === last.text);
  }
  return { complete, found, ids };
}

export async function deleteScene(api, people, found, log = () => {}) {
  for (const entry of found) {
    await api.request(people[entry.owner].token, 'DELETE', `/guilds/${entry.id}`);
    log(`  deleted ${entry.key} (${entry.id})`);
  }
}

function resolveText(text, people) {
  return text.replace(/\{@(\w+)\}/g, (_, key) => {
    if (!people[key]) throw new Error(`unknown cast member in mention: ${key}`);
    return `<@${people[key].id}>`;
  });
}

/**
 * Store a server's color when this server build has the field (IX-2's
 * `spaces.hue`), and say plainly whether it did. A build without it ignores
 * the field, and the app derives a hue from the id; the shot is then not at the
 * prototype's color, which is reported rather than hidden.
 */
async function setHue(api, owner, guildId, hue, log) {
  try {
    await api.request(owner.token, 'PATCH', `/guilds/${guildId}`, { hue });
    const guild = await api.request(owner.token, 'GET', `/guilds/${guildId}`);
    if (guild?.hue === hue) return true;
  } catch { /* an older build refuses or ignores the field */ }
  log(`    (hue ${hue} not stored: this server build has no server color yet; the app derives one from the id)`);
  return false;
}

/**
 * What the story needs from Fuel that only creation hands back: a never-
 * expiring invite (the people who arrive use it) and the Hosts role. Found or
 * made on every run, so a scene found on the instance works like a new one.
 */
export async function ensureFuelHandles(api, people, ids) {
  const fuel = ids.servers.fuel;
  const owner = people.sean;
  const invite = await api.request(owner.token, 'POST', `/channels/${fuel.channels.general}/invites`, { max_age: 0, max_uses: 0 });
  const roles = await api.request(owner.token, 'GET', `/guilds/${fuel.id}/roles`);
  const hosts = (Array.isArray(roles) ? roles : []).find(r => r.name === 'Hosts');
  if (!hosts) throw new Error('Fuel has no Hosts role; rerun with --reseed');
  fuel.invite = invite.code;
  fuel.roles = { Hosts: String(hosts.id) };
}

/** One server: guild, channels, members, roles, invite. No messages yet. */
export async function createServer(api, people, spec, { log = () => {} } = {}) {
  const owner = people[spec.owner];
  const guild = await api.request(owner.token, 'POST', '/guilds', { name: spec.name });
  const guildId = String(guild.id);
  const defaults = await api.request(owner.token, 'GET', `/guilds/${guildId}/channels`);
  const channelIds = {};

  for (const channel of spec.channels) {
    let created;
    if (channel.reuse !== undefined) {
      const existing = defaults.find(c => channelType(c) === channel.reuse);
      if (!existing) throw new Error(`${spec.name}: no default channel of type ${channel.reuse} to reuse`);
      created = existing;
      if (existing.name !== channel.name) {
        created = await api.request(owner.token, 'PATCH', `/channels/${existing.id}`, { name: channel.name });
      }
    } else {
      created = await api.request(owner.token, 'POST', `/guilds/${guildId}/channels`, { name: channel.name, channel_type: channel.type });
    }
    if (channel.topic) await api.request(owner.token, 'PATCH', `/channels/${created.id}`, { topic: channel.topic });
    channelIds[channel.key] = String(created.id);
  }
  // Anything the server made by default that the scene did not ask for is gone.
  for (const channel of defaults) {
    if (!Object.values(channelIds).includes(String(channel.id)) && channelType(channel) !== 4) {
      await api.request(owner.token, 'DELETE', `/channels/${channel.id}`);
    }
  }

  const firstText = spec.channels.find(c => c.type === 0);
  const invite = await api.request(owner.token, 'POST', `/channels/${channelIds[firstText.key]}/invites`, { max_age: 0, max_uses: 0 });
  for (const key of spec.members) {
    await api.request(people[key].token, 'POST', `/invites/${invite.code}`, {});
  }
  const roles = {};
  for (const role of spec.roles ?? []) {
    const made = await api.request(owner.token, 'POST', `/guilds/${guildId}/roles`, {
      name: role.name, permissions: role.permissions, color: 0, hoist: false, mentionable: false,
    });
    roles[role.name] = String(made.id);
    for (const key of role.members) {
      // The default Member role shares the guild's id; keep it.
      await api.request(owner.token, 'PATCH', `/guilds/${guildId}/members/${people[key].id}`, { roles: [guildId, String(made.id)] });
    }
  }
  const hueStored = spec.hue === undefined ? false : await setHue(api, owner, guildId, spec.hue, log);
  log(`  ${spec.name.padEnd(11)} ${guildId}  owner ${owner.name}, ${spec.members.length + 1} member${spec.members.length ? 's' : ''}, ` +
    `${spec.channels.map(c => c.name).join(' · ')}${hueStored ? `, hue ${spec.hue}` : ''}`);
  return { id: guildId, name: spec.name, channels: channelIds, invite: invite.code, roles };
}

async function markRead(api, people, ids, post) {
  const channelId = ids.servers[post.server].channels[post.channel];
  const [latest] = await api.request(people[post.read].token, 'GET', `/channels/${channelId}/messages?limit=1`);
  if (latest) await api.request(people[post.read].token, 'PUT', `/channels/${channelId}/read`, { last_message_id: String(latest.id) });
}

/** Post one message as its author: text and/or images. */
export async function publish(api, people, channelId, { by, text = '', images = [] }, renderer) {
  const author = people[by];
  const attachmentIds = [];
  for (const name of images) {
    attachmentIds.push(await api.uploadAttachment(author.token, channelId, `${name}.png`, await renderer.image(name)));
  }
  return api.request(author.token, 'POST', `/channels/${channelId}/messages`, {
    content: resolveText(text, people),
    ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
  });
}

/** Servers, channels, members, then the conversations that were already going. */
export async function seedScene(api, people, renderer, { log = () => {} } = {}) {
  const ids = { servers: {} };

  log('\nServers');
  for (const spec of SERVERS) {
    ids.servers[spec.key] = await createServer(api, people, spec, { log });
  }

  log('\nConversations');
  let posted = 0;
  for (const post of POSTS) {
    if (post.read) {
      await markRead(api, people, ids, post);
      continue;
    }
    await publish(api, people, ids.servers[post.server].channels[post.channel], post, renderer);
    posted += 1;
  }
  log(`  ${posted} posts (Game Night: lounge, looking-for-group unread, 4 photos; Basecamp: general, builds)`);
  return ids;
}

// ----------------------------------------------------------------- Fuel

/**
 * Is Fuel as the quiet start wants it: Sean alone, nothing said, no events,
 * nobody in its rooms.
 */
export async function fuelIsQuiet(api, people, ids) {
  const fuel = ids.servers.fuel;
  const members = await api.request(people.sean.token, 'GET', `/guilds/${fuel.id}/members`);
  if ((Array.isArray(members) ? members.length : 0) !== 1) return false;
  for (const key of ['general', 'clips', 'plans']) {
    const messages = await api.request(people.sean.token, 'GET', `/channels/${fuel.channels[key]}/messages?limit=1`);
    if (Array.isArray(messages) && messages.length) return false;
  }
  const events = await api.request(people.sean.token, 'GET', `/guilds/${fuel.id}/events`).catch(() => []);
  return !(Array.isArray(events) && events.length);
}

/**
 * Put Fuel back to the quiet start without changing its id (the dock lists
 * servers in join order, and a rebuilt Fuel would move to the end): Sean, its
 * owner, takes down every message and event and removes everyone else.
 */
export async function resetFuel(api, people, ids, { log = () => {} } = {}) {
  const fuel = ids.servers.fuel;
  const sean = people.sean;
  let removedMessages = 0;
  for (const key of ['general', 'clips', 'plans']) {
    for (;;) {
      const messages = await api.request(sean.token, 'GET', `/channels/${fuel.channels[key]}/messages?limit=100`);
      if (!Array.isArray(messages) || messages.length === 0) break;
      for (const message of messages) {
        await api.request(sean.token, 'DELETE', `/channels/${fuel.channels[key]}/messages/${message.id}`);
        removedMessages += 1;
      }
    }
  }
  const events = await api.request(sean.token, 'GET', `/guilds/${fuel.id}/events`).catch(() => []);
  for (const event of Array.isArray(events) ? events : []) {
    await api.request(sean.token, 'DELETE', `/guilds/${fuel.id}/events/${event.id}`);
  }
  const members = await api.request(sean.token, 'GET', `/guilds/${fuel.id}/members`);
  let removedMembers = 0;
  for (const member of Array.isArray(members) ? members : []) {
    const id = String(member.user?.id ?? member.user_id);
    if (id === sean.id) continue;
    await api.request(sean.token, 'DELETE', `/guilds/${fuel.id}/members/${id}`);
    removedMembers += 1;
  }
  log(`  Fuel back to quiet: ${removedMessages} messages, ${events?.length ?? 0} events and ${removedMembers} members removed`);
}

/** Jeremy (or anyone) joins Fuel by its invite; resolves once the server lists them. */
export async function joinFuel(api, people, ids, key) {
  const fuel = ids.servers.fuel;
  await api.request(people[key].token, 'POST', `/invites/${fuel.invite}`, {});
}

/** The next Friday at 9 PM, local: the prototype's Movie night. */
export function movieNightStart() {
  return nextWeekday(5, 21, 0);
}
