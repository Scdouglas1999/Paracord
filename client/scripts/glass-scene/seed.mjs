// Stand the reference scene up on an instance through its public API, as the
// cast. Idempotent by inspection: a complete scene is found and reused; a
// partial one (a run killed half way) is deleted by its owners and rebuilt.

import { AROUND, CAST, EVENTS, PASSWORD, POSTS, SERVERS } from './scene.mjs';
import { pngDataUrl } from './assets.mjs';

export function castAccount(key, tag = '') {
  return {
    key,
    name: CAST[key].name,
    username: `${key}${tag}`,
    email: `${key}${tag}@glass-scene.test`,
    password: PASSWORD,
  };
}

/** Register (or sign in) all seven, set names, and give each their face once. */
export async function signInCast(api, { tag = '', renderer = null, known = null, log = () => {} } = {}) {
  const people = {};
  let likelyExists = Boolean(known?.sean);
  for (const key of Object.keys(CAST)) {
    const account = castAccount(key, tag);
    const session = await api.account(account, { likelyExists });
    // Whatever Sean turned out to be, the rest of the cast almost certainly is too.
    likelyExists = !session.created;
    const person = { ...account, ...session };
    const me = await api.request(person.token, 'GET', '/users/@me');
    if (me.display_name !== person.name) {
      await api.request(person.token, 'PATCH', '/users/@me', { display_name: person.name });
    }
    if (!me.avatar_hash && renderer) {
      await api.uploadMultipart(person.token, '/users/@me/avatar', 'avatar', `${key}.png`, await renderer.avatar(person.name));
    }
    people[key] = person;
    log(`  ${person.name.padEnd(8)} ${person.username.padEnd(14)} id=${person.id}${session.created ? '  (new)' : ''}`);
  }
  return people;
}

const channelType = c => c.channel_type ?? c.type;

/**
 * Find the scene on the instance. Returns `{ complete, found, ids }`, where
 * `ids.servers[key] = { id, channels: { key: id } }`.
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
    // The last post of the seed is Jeremy's mention in General; if it is there,
    // everything before it is too.
    const last = POSTS.filter(p => p.text).at(-1);
    const channelId = ids.servers[last.server].channels[last.channel];
    const messages = await api.request(sean.token, 'GET', `/channels/${channelId}/messages?limit=5`);
    const jeremyId = people[last.by].id;
    complete = Array.isArray(messages) && messages.some(m => String(m.author?.id) === jeremyId && /movie night/.test(m.content ?? ''));
    if (complete) {
      const events = await api.request(sean.token, 'GET', `/guilds/${ids.servers.basecamp.id}/events`);
      complete = Array.isArray(events) && events.some(e => e.name === 'Rim trail hike');
    }
  }
  return { complete, found, ids };
}

export async function deleteScene(api, people, found, log = () => {}) {
  for (const entry of found) {
    await api.request(people[entry.owner].token, 'DELETE', `/guilds/${entry.id}`);
    log(`  deleted ${entry.key} (${entry.id})`);
  }
}

function resolveText(text, people, channelIds) {
  return text
    .replace(/\{@(\w+)\}/g, (_, key) => {
      if (!people[key]) throw new Error(`unknown cast member in mention: ${key}`);
      return `<@${people[key].id}>`;
    })
    .replace(/\{#(\w+)\}/g, (_, key) => {
      if (!channelIds[key]) throw new Error(`unknown channel in link: ${key}`);
      return `<#${channelIds[key]}>`;
    });
}

export async function seedScene(api, people, renderer, { log = () => {} } = {}) {
  const ids = { servers: {} };

  log('\nServers');
  for (const server of SERVERS) {
    const owner = people[server.owner];
    const icon = pngDataUrl(await renderer.icon(server.icon));
    const guild = await api.request(owner.token, 'POST', '/guilds', { name: server.name, icon });
    const guildId = String(guild.id);
    const defaults = await api.request(owner.token, 'GET', `/guilds/${guildId}/channels`);
    const channelIds = {};

    for (const spec of server.channels) {
      let channel;
      if (spec.reuse !== undefined) {
        const existing = defaults.find(c => channelType(c) === spec.reuse);
        if (!existing) throw new Error(`${server.name}: no default channel of type ${spec.reuse} to reuse`);
        channel = existing;
        if (existing.name !== spec.name) {
          channel = await api.request(owner.token, 'PATCH', `/channels/${existing.id}`, { name: spec.name });
        }
      } else {
        channel = await api.request(owner.token, 'POST', `/guilds/${guildId}/channels`, { name: spec.name, channel_type: spec.type });
      }
      if (spec.topic) await api.request(owner.token, 'PATCH', `/channels/${channel.id}`, { topic: spec.topic });
      channelIds[spec.key] = String(channel.id);
    }
    if (server.dropDefaultVoice) {
      for (const c of defaults) {
        if (channelType(c) === 2 && !Object.values(channelIds).includes(String(c.id))) {
          await api.request(owner.token, 'DELETE', `/channels/${c.id}`);
        }
      }
    }
    if (server.banner) {
      await api.uploadMultipart(owner.token, `/guilds/${guildId}/banner`, 'banner', 'banner.png', await renderer.banner());
    }

    const firstText = server.channels.find(c => c.type === 0);
    const invite = await api.request(owner.token, 'POST', `/channels/${channelIds[firstText.key]}/invites`, { max_age: 0, max_uses: 0 });
    for (const key of server.members) {
      await api.request(people[key].token, 'POST', `/invites/${invite.code}`, {});
    }
    for (const role of server.roles ?? []) {
      const created = await api.request(owner.token, 'POST', `/guilds/${guildId}/roles`, {
        name: role.name, permissions: role.permissions, color: 0, hoist: false, mentionable: false,
      });
      for (const key of role.members) {
        // The default Member role shares the guild's id; keep it.
        await api.request(owner.token, 'PATCH', `/guilds/${guildId}/members/${people[key].id}`, { roles: [guildId, String(created.id)] });
      }
    }
    ids.servers[server.key] = { id: guildId, name: server.name, channels: channelIds };
    log(`  ${server.name.padEnd(14)} ${guildId}  owner ${people[server.owner].name}, ` +
      `${server.members.length + 1} members, channels ${server.channels.map(c => c.name).join(' · ')}`);
  }

  log('\nConversations');
  const labels = {};
  let posted = 0;
  for (const post of POSTS) {
    if (post.read) {
      await markRead(api, people, ids, post);
      continue;
    }
    await publish(api, people, ids, renderer, post, labels);
    posted += 1;
  }
  log(`  ${posted} posts (images, a reply, mentions of Sean, reactions, a poll)`);

  log('\nComing up');
  for (const event of EVENTS) {
    const server = ids.servers[event.server];
    const start = event.start();
    const created = await api.request(people[event.by].token, 'POST', `/guilds/${server.id}/events`, {
      name: event.name,
      description: event.description,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + event.hours * 3600e3).toISOString(),
      entity_type: event.entity,
      ...(event.channel ? { channel_id: server.channels[event.channel] } : {}),
      ...(event.location ? { location: event.location } : {}),
    });
    for (const key of event.rsvps) {
      // The creator may already be counted; a repeat RSVP is not an error here.
      await api.request(people[key].token, 'PUT', `/guilds/${server.id}/events/${created.id}/rsvp`)
        .catch(error => { if (error.status !== 409) throw error; });
    }
    log(`  ${event.name.padEnd(15)} ${start.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` +
      `  by ${people[event.by].name}, ${event.rsvps.length} going`);
  }

  return ids;
}

async function markRead(api, people, ids, post) {
  const channelId = ids.servers[post.server].channels[post.channel];
  const [latest] = await api.request(people[post.read].token, 'GET', `/channels/${channelId}/messages?limit=1`);
  if (latest) await api.request(people[post.read].token, 'PUT', `/channels/${channelId}/read`, { last_message_id: String(latest.id) });
}

/** Post one entry of POSTS as its author: text, images, a reply, a poll, reactions. */
async function publish(api, people, ids, renderer, post, labels) {
  const server = ids.servers[post.server];
  const channelId = server.channels[post.channel];
  const author = people[post.by];
  let message;
  if (post.poll) {
    message = await api.request(author.token, 'POST', `/channels/${channelId}/polls`, {
      question: post.poll.question,
      options: post.poll.options.map(text => ({ text })),
    });
    const poll = message.poll;
    for (const [index, voters] of Object.entries(post.votes ?? {})) {
      const option = poll?.options?.[Number(index)];
      if (!option) throw new Error(`poll has no option ${index}: ${JSON.stringify(poll).slice(0, 300)}`);
      for (const voter of voters) {
        await api.request(people[voter].token, 'PUT', `/channels/${channelId}/polls/${poll.id}/votes/${option.id}`);
      }
    }
  } else {
    const attachmentIds = [];
    for (const name of post.images ?? []) {
      attachmentIds.push(await api.uploadAttachment(author.token, channelId, `${name}.png`, await renderer.image(name)));
    }
    message = await api.request(author.token, 'POST', `/channels/${channelId}/messages`, {
      content: resolveText(post.text ?? '', people, server.channels),
      ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
      ...(post.replyTo ? { referenced_message_id: labels[post.replyTo] } : {}),
    });
  }
  if (post.label) labels[post.label] = String(message.id);
  for (const [emoji, who] of Object.entries(post.reactions ?? {})) {
    for (const key of who) {
      await api.request(people[key].token, 'PUT', `/channels/${channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`);
    }
  }
  return message;
}

/**
 * Put Sean's unread state back the way the seed left it.
 *
 * Read state only moves forward on the instance, and opening a conversation
 * marks it read — so after the first shot of General its "new since" divider
 * and badge would be gone for good. Instead of reaching into the database, the
 * posts that followed each of Sean's read marks are taken down by their authors
 * and posted again, identical, so they are once more newer than his mark.
 * Channels he has not read past are left alone.
 */
export async function resetUnread(api, people, ids, renderer, { log = () => {} } = {}) {
  const sean = people.sean;
  const states = await api.request(sean.token, 'GET', '/users/@me/read-states');
  const readUpTo = new Map((Array.isArray(states) ? states : []).map(s => [String(s.channel_id), BigInt(s.last_message_id ?? 0)]));
  const channels = new Map();
  for (const post of POSTS) {
    const key = `${post.server}/${post.channel}`;
    if (post.read === 'sean') channels.set(key, []);
    else if (channels.has(key)) channels.get(key).push(post);
  }
  let reposted = 0;
  for (const [key, after] of channels) {
    if (after.length === 0) continue;
    const [serverKey, channelKey] = key.split('/');
    const channelId = ids.servers[serverKey].channels[channelKey];
    const recent = await api.request(sean.token, 'GET', `/channels/${channelId}/messages?limit=${after.length}`);
    const newestFirst = Array.isArray(recent) ? recent : [];
    const oldestAfter = newestFirst.at(-1);
    const mark = readUpTo.get(channelId) ?? 0n;
    if (!oldestAfter || BigInt(oldestAfter.id) > mark) continue; // still unread
    const expected = [...after].reverse().map(p => people[p.by].id);
    const authors = newestFirst.map(m => String(m.author?.id));
    if (authors.join() !== expected.join()) {
      throw new Error(`${key}: the newest messages are not the seeded ones (authors ${authors.join()} vs ${expected.join()}); rerun with --reseed`);
    }
    for (const message of newestFirst) {
      const owner = Object.values(people).find(p => p.id === String(message.author.id));
      await api.request(owner.token, 'DELETE', `/channels/${channelId}/messages/${message.id}`);
    }
    const labels = {};
    for (const post of after) await publish(api, people, ids, renderer, post, labels);
    reposted += after.length;
    log(`  ${ids.servers[serverKey].name} › ${channelKey}: ${after.length} unread again`);
  }
  return reposted;
}

export { AROUND };
