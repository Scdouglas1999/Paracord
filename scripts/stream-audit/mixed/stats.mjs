import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { scene, OUT, mono, sleep } from './drv.mjs';
import { signInOnePassword } from '../../../client/scripts/lib/credential-node.mjs';
let token = scene.tokens?.sender;
async function auth() {
  try { const r = await signInOnePassword(scene.base, scene.sender.email, scene.password); token = r.token; }
  catch { const r = await fetch(`${scene.base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: scene.sender.email, password: scene.password }) }); token = (await r.json()).token; }
}
await auth();
let n = 0;
for (;;) {
  const r = await fetch(`${scene.base}/api/v1/voice/${scene.voiceChannelId}/media-stats`, { headers: { Authorization: `Bearer ${token}` } });
  appendFileSync(join(OUT, 'relay-stats.log'), `${mono()} ${r.status} ${(await r.text()).replace(/\n/g, ' ')}\n`);
  if (r.status === 401) await auth();
  if (++n % 1200 === 0) await auth();
  await sleep(500);
}
