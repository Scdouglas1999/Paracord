// `index-scene.mjs --check`: the scene's data agrees with itself, offline (no
// instance, no browser). The unit test of a driver whose subject is a live
// instance: every key a post, a DM, a call, a step or a shot names exists; the
// shots are exactly the reference renders.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ARRIVE_MESSAGES, BUSY_MESSAGES, CAST, DMS, FILLERS, IMAGE_NAMES, LOUNGE, POSTS, SERVERS } from './scene.mjs';
import { STATES, STATE_NAMES } from './shots.mjs';
import { POSITIONS } from './story.mjs';

export function checkScene({ repoRoot }) {
  const problems = [];
  const bad = message => problems.push(message);
  const people = new Set([...Object.keys(CAST), ...FILLERS.map(f => f.key)]);
  const server = key => SERVERS.find(s => s.key === key);

  for (const spec of SERVERS) {
    const keys = spec.channels.map(c => c.key);
    if (new Set(keys).size !== keys.length) bad(`${spec.key}: duplicate channel keys`);
    if (!people.has(spec.owner)) bad(`${spec.key}: unknown owner ${spec.owner}`);
    for (const key of spec.members) if (!people.has(key)) bad(`${spec.key}: unknown member ${key}`);
    if (spec.members.includes(spec.owner)) bad(`${spec.key}: the owner is already a member`);
    if (!spec.channels.some(c => c.type === 0)) bad(`${spec.key}: no text channel`);
    if (!Number.isInteger(spec.hue) || spec.hue < 0 || spec.hue > 359) bad(`${spec.key}: hue ${spec.hue} is not 0-359`);
  }
  const fuel = server('fuel');
  for (const key of ['general', 'clips', 'plans', 'generalRoom']) {
    if (!fuel?.channels.some(c => c.key === key)) bad(`fuel has no channel "${key}" (the story uses it)`);
  }
  if (fuel && fuel.members.length) bad('fuel must start with its owner alone');
  if (!fuel?.roles?.some(r => r.name === 'Hosts')) bad('fuel has no Hosts role (Jeremy plans Movie night with it)');

  for (const post of POSTS) {
    const s = server(post.server);
    if (!s?.channels.some(c => c.key === post.channel && c.type === 0)) bad(`post in ${post.server}/${post.channel}: not a text channel of that server`);
    if (post.read && post.read !== 'sean') bad(`post read mark by ${post.read}: only sean has read states in the scene`);
    if (!post.read) {
      if (!people.has(post.by)) bad(`post by unknown ${post.by}`);
      else if (s && ![s.owner, ...s.members].includes(post.by)) bad(`${post.by} posts in ${post.server} without being a member`);
      if (!post.text && !(post.images?.length)) bad(`post by ${post.by} in ${post.channel} has neither text nor images`);
    }
    for (const image of post.images ?? []) if (!IMAGE_NAMES.includes(image)) bad(`unknown image ${image}`);
  }
  for (const entry of DMS) {
    if (!CAST[entry.with] || entry.with === 'sean') bad(`DM with ${entry.with}`);
    for (const [who] of entry.lines) if (who !== 'sean' && who !== entry.with) bad(`DM with ${entry.with}: a line by ${who}`);
  }
  const lounge = server(LOUNGE.server);
  if (lounge?.channels.find(c => c.key === LOUNGE.room)?.type !== 2) bad('the Lounge is not a voice channel of its server');
  for (const member of LOUNGE.members) if (!CAST[member.who]) bad(`Lounge member ${member.who} is not in the cast`);
  for (const message of [...ARRIVE_MESSAGES, ...BUSY_MESSAGES]) if (!CAST[message.by]) bad(`story message by unknown ${message.by}`);

  for (const name of STATE_NAMES) {
    if (!POSITIONS.includes(STATES[name].at)) bad(`state ${name} needs unknown position ${STATES[name].at}`);
  }
  const refs = join(repoRoot, 'output', 'design-reference', 'index', 'ref');
  if (existsSync(refs)) {
    const names = readdirSync(refs).filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, '')).sort();
    const have = [...STATE_NAMES].sort();
    if (names.join() !== have.join()) bad(`shots ${have.join(', ')} are not the reference renders ${names.join(', ')}`);
  }
  return problems;
}
