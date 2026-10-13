#!/usr/bin/env node
// reshare.mjs: the audit's B1 check (stream-fix-v2). The sharer stops and
// shares again, over and over, while the viewer keeps watching and is never
// touched; each cycle records whether the viewer said the share stopped, and
// whether and how fast frames reached its decoder again (the probe's DIN lines)
// with the picture marked live.
//
//   node reshare.mjs --out <run dir> [--cycles 20] [--preset 720p30]
//                    [--switch-every 4] [--midway 1] [--gap 2500]
//
// --switch-every N: every Nth share switches what is shared. It picks the next
// entry in "What to share", and the lab's synthetic screen (one portal source)
// is restarted at the next size in --switch-sizes, as a different window of a
// different size would be.
// --midway 1: halfway through, the viewer stops watching, misses two re-shares,
// and presses Watch again while the share runs (a viewer joining mid-way).
// Results: <run dir>/reshare.json, plus marks in marks.log.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const OUT = arg('out');
const PORT = Number(arg('port', '1477'));
const CYCLES = Number(arg('cycles', '20'));
const PRESET = arg('preset', '720p30');
// --presets a,b,c: change Share quality (while not sharing) before each share,
// cycling through the list, as the audit's fresh shares did.
const PRESETS = arg('presets', '').split(',').filter(Boolean);
const SWITCH_EVERY = Number(arg('switch-every', '4'));
const MIDWAY = arg('midway', '1') === '1';
const GAP = Number(arg('gap', '2500'));
const SWITCH_SIZES = arg('switch-sizes', '1920x1080,2560x1440,5120x1440').split(',').map((s) => s.split('x').map(Number));
const here = dirname(fileURLToPath(import.meta.url));
const GRAPH_A = arg('graph-a', process.env.SA_GRAPH_A ?? 'sa-pwA');
const RECOVER_WITHIN = Number(arg('recover-within', '15000'));
const LABEL = {
  '720p30': '720p 30fps', '1080p60': '1080p 60fps', '1440p60': '1440p 60fps', '4k60': '4K 60fps',
  'movie-50': 'Movie 4K (50 Mbps)', 'movie-100': 'Movie 4K (100 Mbps)',
};
const marks = join(OUT, 'marks.log');
const mono = () => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mark = (event, info = {}) => appendFileSync(marks, `${mono()} ${event} ${JSON.stringify(info)}\n`);

async function run(role, body, timeout = 60000) {
  const r = await fetch(`http://127.0.0.1:${PORT}/__drive/run?role=${role}&timeout=${timeout}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (j.error) throw new Error(`${role}: ${j.error}`);
  return j.result;
}

const VIEW_STATE = `
  const s = $('.ix-call-stream');
  return {
    call: !!$('[data-testid=ix-call]'),
    live: s?.dataset.underlay === 'live', picture: s?.dataset.picture ?? null,
    notice: $('.ix-call-notice')?.textContent ?? null,
  };`;
const viewerState = () => run('viewer', VIEW_STATE).catch((e) => ({ error: e.message }));

function dinCount() {
  try { return (readFileSync(join(OUT, 'viewer', 'probe.log'), 'utf8').match(/^DIN /gm) || []).length; } catch { return 0; }
}

async function senderOpenCall() {
  await run('sender', `
    if (!$('[data-testid=ix-card-leave]')) { await click($('[data-testid=ix-card-join]') ?? $('[data-testid=ix-room-row]')); await waitFor(() => $('[data-testid=ix-card-leave]'), 30000); }
    if (!$('[data-testid=ix-call]')) { await click($('[data-testid=ix-card-open-call]')); await waitFor(() => $('[data-testid=ix-call]'), 15000); }
    return true;`, 60000);
}

async function senderQuality(preset = PRESET) {
  return run('sender', `
    await click(await waitFor(() => btn('More call actions'), 15000)); await sleep(500);
    const item = $$('[role=menuitem]').find((b) => /^Share quality/.test(text(b)));
    await click(item); await sleep(500);
    const opt = $$('[aria-label="Share quality"] button').find((b) => text(b) === ${JSON.stringify(LABEL[preset])});
    if (!opt) throw new Error('no option');
    await click(opt); await sleep(1500);
    if ($('[aria-label="Share quality"]')) { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await sleep(300); }
    return true;`, 30000);
}

/** Share; `pick` is the index of the "What to share" entry. Returns the entries and the one picked. */
async function senderStart(pick) {
  return run('sender', `
    await click(btn('Share your screen'));
    await waitFor(() => $('[role=radiogroup][aria-label="What to share"] [role=radio]'), 15000);
    const radios = $$('[role=radiogroup][aria-label="What to share"] [role=radio]');
    const chosen = radios[${pick} % radios.length];
    await click(chosen); await sleep(300);
    await click($$('button').filter((b) => text(b) === 'Share').pop());
    await waitFor(() => btn('Stop sharing your screen'), 40000);
    return { sources: radios.map((r) => text(r)), picked: text(chosen) };`, 60000);
}

async function senderStop() {
  return run('sender', `
    const b = btn('Stop sharing your screen'); if (b) { await click(b); await waitFor(() => btn('Share your screen'), 15000); }
    return true;`, 30000);
}

/** Restart the synthetic screen at another size: what a switch to another window shares. */
async function switchSource(index) {
  const [w, h] = SWITCH_SIZES[index % SWITCH_SIZES.length];
  const pidFile = join(OUT, 'pattern.pid');
  try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* not running */ }
  await sleep(800);
  const runtime = process.env.XDG_RUNTIME_DIR;
  const child = spawn('python3', [join(here, '..', 'pattern.py'), '--w', String(w), '--h', String(h), '--fps', '60',
    '--log', join(OUT, 'src.log'), '--audio'], {
    env: { ...process.env, PIPEWIRE_REMOTE: GRAPH_A, PULSE_SERVER: `unix:${runtime}/${GRAPH_A}.pulse` },
    stdio: 'ignore', detached: true,
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  await sleep(1500);
  return `${w}x${h}`;
}

async function viewerWatch() {
  return run('viewer', `
    if ($('[data-testid=ix-call]')) return 'already';
    const w = await waitFor(() => btn(/^Watch vincent/i), 20000);
    await click(w);
    await waitFor(() => $('[data-testid=ix-call]'), 15000);
    return 'watching';`, 45000);
}

async function viewerLeave() {
  return run('viewer', `
    if ($('[data-testid=ix-call]')) { await click($('[data-testid=ix-call-back]') ?? btn('Back to chat')); await sleep(1200); }
    return !$('[data-testid=ix-call]');`, 20000);
}

/** Wait until frames reach the viewer's decoder and its picture is live. */
async function waitForFrames(withinMs) {
  const t0 = Date.now();
  const base = dinCount();
  let flowingAt = null;
  while (Date.now() - t0 < withinMs) {
    await sleep(250);
    if (flowingAt === null && dinCount() - base > 3) flowingAt = Date.now() - t0;
    if (flowingAt !== null) {
      const st = await viewerState();
      if (st.live && st.picture === 'true' && !st.notice) return { ms: Date.now() - t0, decoderMs: flowingAt, state: st };
    }
  }
  return { ms: null, decoderMs: flowingAt, state: await viewerState() };
}

const results = { preset: PRESET, cycles: [], startedAt: new Date().toISOString() };
const save = () => writeFileSync(join(OUT, 'reshare.json'), JSON.stringify(results, null, 2));

await senderOpenCall();
if (await run('sender', `return !!btn('Stop sharing your screen');`)) { await senderStop(); await sleep(GAP); }
await senderQuality(PRESET);
let started = await senderStart(0);
log('first share', JSON.stringify(started));
results.sources = started.sources;
await sleep(3000);
await viewerWatch();
const first = await waitForFrames(30000);
log('first watch', JSON.stringify(first));
results.firstWatch = first;
mark('reshare-begin', { cycles: CYCLES, preset: PRESET });

let watching = true;
const midStop = MIDWAY ? Math.floor(CYCLES / 2) : -1;
for (let cycle = 1; cycle <= CYCLES; cycle++) {
  const entry = { cycle };
  if (cycle === midStop) {
    await viewerLeave();
    watching = false;
    entry.viewerLeft = true;
  }
  mark('reshare-stop', { cycle });
  await senderStop();
  await sleep(GAP);
  entry.afterStop = await viewerState();
  // Nothing may keep flowing after a stop, and the viewer must say so.
  entry.stoppedNotice = watching ? /stopped sharing/i.test(entry.afterStop.notice ?? '') : null;
  // And the box no longer claims a picture (the last frame is not live).
  entry.stoppedPictureCleared = watching ? entry.afterStop.picture !== 'true' : null;
  if (PRESETS.length) {
    entry.preset = PRESETS[cycle % PRESETS.length];
    await senderQuality(entry.preset);
  }
  const pick = SWITCH_EVERY > 0 && cycle % SWITCH_EVERY === 0 ? cycle / SWITCH_EVERY : 0;
  if (pick > 0) entry.source = await switchSource(pick);
  mark('reshare-start', { cycle, pick, source: entry.source ?? null });
  started = await senderStart(pick);
  entry.picked = started.picked;
  entry.pickerEntries = started.sources.length;
  if (!watching && cycle === midStop + 2) {
    // Joining mid-way: Watch while the share runs.
    await sleep(1500);
    await viewerWatch();
    watching = true;
    entry.viewerJoined = true;
  }
  if (watching) {
    const got = await waitForFrames(RECOVER_WITHIN);
    entry.recovered = got.ms !== null;
    entry.recoverMs = got.ms;
    entry.decoderMs = got.decoderMs;
    entry.state = got.state;
  } else {
    entry.recovered = null;
    await sleep(3000);
  }
  log(`cycle ${cycle}`, JSON.stringify(entry));
  results.cycles.push(entry);
  save();
  await sleep(1500);
}
mark('reshare-end', {});
const watched = results.cycles.filter((c) => c.recovered !== null);
results.summary = {
  cycles: results.cycles.length,
  watchedCycles: watched.length,
  recovered: watched.filter((c) => c.recovered).length,
  stoppedNoticeShown: results.cycles.filter((c) => c.stoppedNotice === true).length,
  stoppedNoticeChecked: results.cycles.filter((c) => c.stoppedNotice !== null).length,
  stoppedPictureCleared: results.cycles.filter((c) => c.stoppedPictureCleared === true).length,
  switched: results.cycles.filter((c) => c.source).length,
  switchedRecovered: results.cycles.filter((c) => c.source && c.recovered).length,
  midwayJoin: results.cycles.filter((c) => c.viewerJoined).map((c) => ({ cycle: c.cycle, recovered: c.recovered, recoverMs: c.recoverMs })),
  recoverMs: watched.filter((c) => c.recovered).map((c) => c.recoverMs).sort((a, b) => a - b),
};
save();
log('summary', JSON.stringify(results.summary));
