#!/usr/bin/env node
// seed-chat.mjs <scene.json> [count]: messages in the voice room's own chat, so
// the call view's chat column beside the stream has something to scroll.
import { readFileSync } from 'node:fs';

import { signInOnePassword } from '../../../client/scripts/lib/credential-node.mjs';

const scene = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const count = Number(process.argv[3] ?? 160);
const tokens = [
  (await signInOnePassword(scene.base, scene.sender.email, scene.password)).token,
  (await signInOnePassword(scene.base, scene.viewer.email, scene.password)).token,
];
for (let i = 0; i < count; i++) {
  const r = await fetch(`${scene.base}/api/v1/channels/${scene.voiceChannelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens[i % 2]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `Room message ${i}: scrolling this column beside the stream is one of the audit's motions. ${'more words here '.repeat(i % 6)}` }),
  });
  if (!r.ok) throw new Error(`message ${i}: ${r.status} ${await r.text()}`);
}
console.log(`seeded ${count} messages in the room chat`);
