#!/usr/bin/env node
// seed.mjs <base> <out.json>: the audit's accounts and server on a throwaway
// instance (scripts/live-env.mjs): Vincent (sender) owns "Stream audit" with a
// text channel and a voice room; Sam (viewer) joins through an invite. Prints
// and writes the ids the driver needs.
import { writeFileSync } from 'node:fs';



const base = process.argv[2].replace(/\/+$/, '');
const out = process.argv[3];
const password = 'Stream-Audit-Password-123!';

async function call(token, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function account(username) {
  // Legacy accounts (an older server has no one-password registration).
  const email = `${username}@stream-audit.test`;
  const r = await call(null, 'POST', '/auth/register', { username, email, password });
  return { username, email, password, id: String(r.user?.id ?? r.id ?? ''), token: r.token };
}

const sender = await account('vincent');
const viewer = await account('sam');
const guild = await call(sender.token, 'POST', '/guilds', { name: 'Stream audit' });
const channels = await call(sender.token, 'GET', `/guilds/${guild.id}/channels`);
const type = (c) => c.channel_type ?? c.type;
const text = channels.find((c) => type(c) === 0);
const voice = channels.find((c) => type(c) === 2);
const invite = await call(sender.token, 'POST', `/channels/${text.id}/invites`, { max_age: 0, max_uses: 0 });
await call(viewer.token, 'POST', `/invites/${invite.code}`, {});
const scene = {
  base,
  password,
  sender: { ...sender, token: undefined },
  viewer: { ...viewer, token: undefined },
  tokens: { sender: sender.token, viewer: viewer.token },
  guildId: String(guild.id),
  textChannelId: String(text.id),
  voiceChannelId: String(voice.id),
  voiceName: voice.name,
};
writeFileSync(out, JSON.stringify(scene, null, 2));
console.log(JSON.stringify(scene, null, 2));
