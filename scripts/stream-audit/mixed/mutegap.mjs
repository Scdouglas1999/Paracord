// mutegap.mjs: with both in the call and speech in the sender's mic, the sender mutes for --gap ms and unmutes; the viewer's output says whether the voice comes back.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
import { run, sleep, mono, log, OUT } from './drv.mjs';
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? f : process.argv[i + 1]; };
const gaps = arg('gaps', '300,1000,2000,3000').split(',').map(Number);
const who = arg('who', 'sender');
const feed = spawn('bash', [join(HERE, 'micfeed.sh'), who === 'sender' ? 'v7-pwA' : 'v7-pwB', join(OUT, 'speech-long.wav')], { stdio: 'ignore', detached: true });
process.on('exit', () => { try { process.kill(-feed.pid); } catch {} });
const M = (e, i = {}) => appendFileSync(join(OUT, 'mute-marks.log'), `${mono()} ${e} ${JSON.stringify(i)}\n`);
const STATE = `return $('[data-testid=ix-card-mic]')?.dataset.muted ?? null;`;
for (const role of ['sender', 'viewer']) {
  await run(role, `if (!$('[data-testid=ix-card-leave]')) { const j = $('[data-testid=ix-card-join]') ?? $('[data-testid=ix-room-row]'); await click(j); await waitFor(() => $('[data-testid=ix-card-leave]'), 30000); } return 1;`);
}
await sleep(2000);
if ((await run(who, STATE)) === 'true') await run(who, `await click($('[data-testid=ix-card-mic]')); return 1;`);
await sleep(8000); // let a stuck start clear: we test the gap, not the join
for (const gap of gaps) {
  M('before', { gap }); await sleep(4000);
  await run(who, `await click($('[data-testid=ix-card-mic]')); return 1;`); M('muted', { gap });
  await sleep(gap);
  await run(who, `await click($('[data-testid=ix-card-mic]')); return 1;`); M('unmuted', { gap });
  await sleep(8000); M('end', { gap });
  log('gap', gap, 'muted state now', await run(who, STATE));
}
try { process.kill(-feed.pid); } catch {}
