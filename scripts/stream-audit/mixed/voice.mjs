// voice.mjs: join-time voice and mute checks (stream-fix V7).
//   RUN=<run> node voice.mjs --first sender --trials 4 [--tag x]
// Speech loops into both apps' microphones (private graphs) the whole time; the
// level recorders (lvlrec.py, 50 ms) on each app's output say when the other's
// voice arrives. Per trial: both leave; <first> joins and unmutes; the other
// joins and presses Unmute as soon as the button is there (item 3), then 12 s.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
import { run, sleep, mono, log, OUT } from './drv.mjs';
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? f : process.argv[i + 1]; };
const first = arg('first', 'sender');
const second = first === 'sender' ? 'viewer' : 'sender';
const trials = Number(arg('trials', '4'));
const tag = arg('tag', 'v');
const unmuteFast = arg('unmute', 'fast'); // fast | settled
const marks = join(OUT, 'voice-marks.log');
const mark = (e, info = {}) => appendFileSync(marks, `${mono()} ${e} ${JSON.stringify(info)}\n`);
const graph = { sender: 'v7-pwA', viewer: 'v7-pwB' };
const loops = [];
function startLoop(role) {
  loops.push(spawn('bash', [join(HERE, 'micfeed.sh'), graph[role], join(OUT, 'speech-long.wav')], { stdio: 'ignore', detached: true }));
}
const STATE = `return { inCall: !!$('[data-testid=ix-card-leave]'), muted: $('[data-testid=ix-card-mic]')?.dataset.muted ?? null, mic: !!$('[data-testid=ix-card-mic]') };`;
async function leave(role) {
  await run(role, `const b = $('[data-testid=ix-card-leave]'); if (b) { await click(b); await waitFor(() => !$('[data-testid=ix-card-leave]'), 15000); } return 1;`);
}
async function joinRoom(role) {
  return run(role, `
    if (!$('[data-testid=ix-card-join]') && !$('[data-testid=ix-card-leave]')) { await click($('[data-testid=ix-room-row]')); await sleep(400); }
    const j = $('[data-testid=ix-card-join]'); if (j) await click(j);
    return 1;`);
}
async function waitIn(role, ms = 30000) {
  return run(role, `await waitFor(() => $('[data-testid=ix-card-leave]') && $('[data-testid=ix-card-mic]'), ${ms}, 30); return 1;`, ms + 5000);
}
async function unmute(role) {
  return run(role, `const m = $('[data-testid=ix-card-mic]'); if (m && m.dataset.muted === 'true') { await click(m); return 'clicked'; } return m ? 'already' : 'none';`);
}
startLoop('sender'); startLoop('viewer');
process.on('exit', () => { for (const l of loops) try { process.kill(-l.pid); } catch {} });
process.on('SIGINT', () => process.exit(1));
const results = [];
try {
  for (let t = 0; t < trials; t++) {
    await leave(second).catch(() => {}); await leave(first).catch(() => {});
    await sleep(3000);
    await joinRoom(first); await waitIn(first); await sleep(1500);
    await unmute(first); await sleep(3000);
    const fs = await run(first, STATE);
    mark('trial', { t, tag, first, second, firstState: fs });
    // The second joins and presses Unmute the moment the mic button exists.
    const tJoin = mono(); mark('join', { t, role: second });
    await joinRoom(second);
    const pressed = await run(second, `
      const t0 = performance.now();
      await waitFor(() => $('[data-testid=ix-card-mic]'), 30000, 20);
      const seen = performance.now() - t0;
      ${unmuteFast === 'settled' ? "await waitFor(() => $('[data-testid=ix-card-leave]'), 30000, 20); await sleep(1500);" : ''}
      const m = $('[data-testid=ix-card-mic]'); const before = m.dataset.muted; await click(m);
      return { seen: Math.round(seen), before, joined: !!$('[data-testid=ix-card-leave]') };`, 40000);
    const tClick = mono(); mark('unmute-click', { t, role: second, ...pressed });
    const samples = [];
    for (const at of [300, 1000, 2000, 4000, 6000]) {
      await sleep(at - (samples.length ? [300, 1000, 2000, 4000, 6000][samples.length - 1] : 0));
      samples.push({ at, ...(await run(second, STATE)) });
    }
    const reverted = samples[samples.length - 1].muted === 'true';
    mark('mute-samples', { t, samples, reverted });
    if (reverted) { await unmute(second); mark('unmute-again', { t }); }
    await sleep(12000);
    mark('trial-end', { t });
    results.push({ t, pressed, samples, reverted, tJoin, tClick });
    log(`trial ${t}: ${second} unmute ${JSON.stringify(pressed)} -> muted ${samples.map((s) => s.muted).join(',')} reverted=${reverted}`);
  }
} finally {
  for (const l of loops) try { process.kill(-l.pid); } catch {}
}
console.log(JSON.stringify(results));
