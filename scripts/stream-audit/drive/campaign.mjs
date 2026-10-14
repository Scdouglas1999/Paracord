#!/usr/bin/env node
// campaign.mjs: drive a stream-audit environment (env.sh up) through the
// share presets, viewer layouts, UI motion and viewer quality settings, writing
// phase marks (CLOCK_MONOTONIC µs, the clock of every probe and trace) for
// analyze.py.
//
//   node campaign.mjs --out <run dir> [--presets 720p30,1080p60,...] [--plan full|quick|layers|midstream|sizes|audio]
//
// Everything is driven through the apps' own controls by the in-page agent
// (audit-serve.mjs); nothing calls a media command the UI would not.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signInOnePassword } from '../../../client/scripts/lib/credential-node.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const OUT = arg('out');
const PORT = Number(arg('port', '1477'));
const plan = arg('plan', 'full');
const PRESETS = arg('presets', '720p30,1080p60,1440p60,4k60,movie-50,movie-100').split(',');
const LABEL = {
  '720p30': '720p 30fps', '1080p60': '1080p 60fps', '1440p60': '1440p 60fps', '4k60': '4K 60fps',
  'movie-50': 'Movie (50 Mbps at 4K)', 'movie-100': 'Movie (100 Mbps at 4K)',
};
const scene = JSON.parse(readFileSync(join(OUT, 'scene.json'), 'utf8'));
const marks = join(OUT, 'marks.log');
const mono = () => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function mark(event, info = {}) {
  appendFileSync(marks, `${mono()} ${event} ${JSON.stringify(info)}\n`);
}

async function run(role, body, timeout = 60000) {
  const r = await fetch(`http://127.0.0.1:${PORT}/__drive/run?role=${role}&timeout=${timeout}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (j.error) throw new Error(`${role}: ${j.error}`);
  return j.result;
}

// ── background samplers: relay counters and GPU ──────────────────────────────
// The relay's counters are read as the sender's account, with a session of
// the driver's own (signed in again every 10 minutes; tokens last ~15).
let relayToken = null;
let relayTokenAt = 0;
async function relayAuth() {
  if (!relayToken || Date.now() - relayTokenAt > 600_000) {
    const r = await signInOnePassword(scene.base, scene.sender.email, scene.password);
    relayToken = r.token;
    relayTokenAt = Date.now();
  }
  return relayToken;
}
function startRelayPoll() {
  const file = join(OUT, 'relay.log');
  const timer = setInterval(async () => {
    try {
      const t = mono();
      const r = await fetch(`${scene.base}/api/v1/voice/${scene.voiceChannelId}/media-stats`, {
        headers: { Authorization: `Bearer ${await relayAuth()}` },
      });
      const body = await r.text();
      appendFileSync(file, `${t} ${r.status} ${body.replace(/\n/g, ' ')}\n`);
    } catch (e) { appendFileSync(file, `${mono()} ERR ${e.message}\n`); }
  }, 1000);
  return () => clearInterval(timer);
}

function startGpuPoll() {
  const file = join(OUT, 'gpu.log');
  const child = spawn('nvidia-smi', ['pmon', '-s', 'u', '-d', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      appendFileSync(file, `${mono()} ${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
  const dmon = spawn('nvidia-smi', ['dmon', '-s', 'u', '-d', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let b2 = '';
  dmon.stdout.on('data', (d) => {
    b2 += d;
    let i;
    while ((i = b2.indexOf('\n')) >= 0) {
      appendFileSync(join(OUT, 'gpu-dmon.log'), `${mono()} ${b2.slice(0, i)}\n`);
      b2 = b2.slice(i + 1);
    }
  });
  return () => { child.kill(); dmon.kill(); };
}

// ── sender ──────────────────────────────────────────────────────────────────
async function senderOpenCall() {
  await run('sender', `
    if (!$('[data-testid=ix-card-leave]')) { await click($('[data-testid=ix-card-join]') ?? $('[data-testid=ix-room-row]')); await waitFor(() => $('[data-testid=ix-card-leave]'), 30000); }
    if (!$('[data-testid=ix-call]')) { await click($('[data-testid=ix-card-open-call]')); await waitFor(() => $('[data-testid=ix-call]'), 15000); }
    return true;`, 60000);
}

async function senderQuality(preset) {
  return run('sender', `
    await click(await waitFor(() => btn('More call actions'), 15000)); await sleep(500);
    const item = $$('[role=menuitem]').find((b) => /^Share quality/.test(text(b)));
    await click(item); await sleep(500);
    const opt = $$('[aria-label="Share quality"] button').find((b) => text(b) === ${JSON.stringify(LABEL[preset])});
    if (!opt) throw new Error('no option ${LABEL[preset]}');
    await click(opt); await sleep(1500);
    // Close the menu the way a click elsewhere does (Escape would leave the call view).
    if ($('[aria-label="Share quality"]')) { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await sleep(300); }
    return !!$('[data-testid=ix-call]');`, 30000);
}

async function senderSharing() {
  return run('sender', `return !!btn('Stop sharing your screen');`);
}

async function senderStart() {
  return run('sender', `
    await click(btn('Share your screen'));
    await waitFor(() => $('[role=radiogroup][aria-label="What to share"] [role=radio]'), 15000);
    await click($('[role=radio]')); await sleep(300);
    await click($$('button').filter((b) => text(b) === 'Share').pop());
    await waitFor(() => btn('Stop sharing your screen'), 40000);
    return true;`, 60000);
}

async function senderStop() {
  return run('sender', `
    const b = btn('Stop sharing your screen'); if (b) { await click(b); await waitFor(() => btn('Share your screen'), 15000); }
    return true;`, 30000);
}

// ── viewer ──────────────────────────────────────────────────────────────────
const VIEW_STATE = `
  const call = $('[data-testid=ix-call]');
  const s = $('.ix-call-stream');
  const r = s ? s.getBoundingClientRect() : null;
  const hb = (re) => $$('[data-testid=ix-call] button').map((b) => text(b)).find((t) => re.test(t)) ?? null;
  return {
    live: s?.dataset.underlay === 'live', picture: s?.dataset.picture ?? null,
    box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    theater: hb(/^(Theater|Leave theater)$/), chat: hb(/^(Show chat|Hide chat)$/),
    full: !!document.fullscreenElement || hb(/^Exit full screen$/) !== null,
    page: [innerWidth, innerHeight], immersive: call?.dataset.immersive ?? null,
    notice: $('.ix-call-notice')?.textContent ?? null,
  };`;

async function viewerState() { return run('viewer', VIEW_STATE); }

// Frames reaching the viewer's decoder (the probe's DIN lines), not the DOM:
// a watch can say "live" over a frozen picture (see the audit's B1).
function dinCount() {
  try { return (readFileSync(join(OUT, 'viewer', 'probe.log'), 'utf8').match(/^DIN /gm) || []).length; } catch { return 0; }
}
async function framesFlowing(ms = 2500) {
  const a = dinCount();
  await sleep(ms);
  return dinCount() - a > 3;
}
async function viewerWatch() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const st = await viewerState().catch(() => null);
    if (st?.live && st.picture === 'true' && await framesFlowing()) return st;
    log('  viewer is not receiving frames; watching again', JSON.stringify(st));
    mark('rewatch', { attempt, state: st });
    await run('viewer', `
      const again = $$('button').find((b) => text(b) === 'Watch again');
      if (again) { await click(again); }
      else {
        if ($('[data-testid=ix-call]')) { await click($('[data-testid=ix-call-back]') ?? btn('Back to chat')); await sleep(1200); }
        const w = btn(/^Watch vincent$/i) ?? btn(/^Watch vincent/i);
        if (w) await click(w);
      }
      await waitFor(() => $('.ix-call-stream')?.dataset.underlay === 'live' && $('.ix-call-stream')?.dataset.picture === 'true', 30000, 200).catch(() => null);
      return true;`, 45000).catch((e) => log('watch attempt', e.message));
    await sleep(1500);
  }
  return viewerState();
}

async function viewerLayout(want) {
  // want: normal | theater | fullscreen | chat
  for (let i = 0; i < 4; i++) {
    const st = await viewerState();
    const isTheater = st.theater === 'Leave theater';
    const isChat = st.chat === 'Hide chat';
    let act = null;
    if (want === 'fullscreen') {
      if (!st.full) act = `await click($$('button').find((b) => text(b) === 'Full screen'));`;
    } else if (st.full) act = `await click($$('button').find((b) => text(b) === 'Exit full screen'));`;
    else if (want === 'theater' && !isTheater) act = `await click(btn('Theater'));`;
    else if (want !== 'theater' && isTheater) act = `await click(btn('Leave theater'));`;
    else if (want === 'chat' && !isChat) act = `await click(btn('Show chat'));`;
    else if (want !== 'chat' && isChat) act = `await click(btn('Hide chat'));`;
    if (!act) return st;
    // Full screen hides the call's chrome until the pointer moves; wake it first,
    // and wait for the control instead of failing on a frame where it is hidden.
    act = act.replace(/await click\((.*)\);$/, 'await click(await waitFor(() => $1, 6000));');
    await run('viewer', `document.querySelector('[data-testid=ix-call]')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
      await sleep(300); ${act} await sleep(1500); return true;`);
  }
  return viewerState();
}

// The column the probe reads: inside the video's drawn rect (contain fit of
// the stream's aspect in the stream box), in physical px (the windows run at
// scale 1). For a motion phase, inside the drawn rect of every state.
function contentRect(box, aspect) {
  const [x, y, w, h] = box;
  if (w / h > aspect) { const cw = h * aspect; return [x + (w - cw) / 2, y, cw, h]; }
  const ch = w / aspect; return [x, y + (h - ch) / 2, w, ch];
}
function aspectNow() {
  const lines = readFileSync(join(OUT, 'viewer', 'probe.log'), 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^UP .* w=(\d+) h=(\d+)/.exec(lines[i]);
    if (m) return Number(m[1]) / Number(m[2]);
  }
  return 16 / 9;
}
function setProbeX(boxes) {
  const aspect = aspectNow();
  const rects = boxes.filter(Boolean).map((b) => contentRect(b, aspect));
  let lo = Math.max(...rects.map((r) => r[0])), hi = Math.min(...rects.map((r) => r[0] + r[2]));
  if (hi - lo < 8) { lo = rects[0][0]; hi = rects[0][0] + rects[0][2]; }
  // Keep off the very center: the stream label/tools sit at the box edges, the
  // center is clear; a third of the way avoids the moving block's column.
  const x = Math.round(lo + (hi - lo) * 0.62);
  writeFileSync(join(OUT, 'viewer', 'probe.cfg'), `x=${x}\n`);
  return { x, aspect: Number(aspect.toFixed(3)), rects: rects.map((r) => r.map(Math.round)) };
}

async function phase(name, info, body, ms) {
  mark('start', { phase: name, ...info });
  if (body) await run('viewer', body, ms + 20000);
  else await sleep(ms);
  mark('end', { phase: name, ...info });
}

const TOGGLE = (label, every, ms) => `
  const until = Date.now() + ${ms}; let n = 0;
  while (Date.now() < until) {
    const b = $$('button').find((x) => ${label}.test(text(x)));
    if (b) { await click(b); n++; }
    await sleep(${every});
  }
  return n;`;

async function layoutPhases(tag, { rest = 10000, motion = 12000, phases } = {}) {
  await viewerWatch();
  const want = phases ?? ['normal', 'theater', 'fullscreen', 'theater-toggle', 'chat-toggle', 'sheet', 'scroll'];
  const boxes = {};
  for (const l of ['normal', 'theater', 'chat']) {
    if (!want.some((p) => p === l || p.startsWith(l === 'chat' ? 'chat' : l) || (l === 'chat' && p === 'scroll') || (l !== 'chat' && p.endsWith('toggle')))) continue;
    boxes[l] = (await viewerLayout(l)).box;
  }
  for (const p of want) {
    let st;
    if (p === 'normal' || p === 'theater' || p === 'fullscreen') {
      st = await viewerLayout(p);
      await sleep(1500);
      st = await viewerState();
      const px = setProbeX([st.box]);
      await sleep(400);
      await phase(`${tag}:${p}`, { layout: p, ...px, box: st.box, page: st.page }, null, rest);
    } else if (p === 'theater-toggle') {
      await viewerLayout('normal');
      const px = setProbeX([boxes.normal, boxes.theater]);
      await sleep(800);
      await phase(`${tag}:${p}`, { motion: 'theater toggle every 1.5 s', ...px }, TOGGLE(`/^(Theater|Leave theater)$/`, 1500, motion), motion);
    } else if (p === 'chat-toggle') {
      await viewerLayout('normal');
      const px = setProbeX([boxes.normal, boxes.chat]);
      await sleep(800);
      await phase(`${tag}:${p}`, { motion: 'chat sheet toggle every 1.5 s', ...px }, TOGGLE(`/^(Show chat|Hide chat)$/`, 1500, motion), motion);
    } else if (p === 'sheet') {
      await viewerLayout('normal');
      st = await viewerState();
      const px = setProbeX([st.box]);
      await sleep(800);
      await phase(`${tag}:${p}`, { motion: 'stream sound/quality popover toggle every 1.5 s', ...px },
        TOGGLE(`/^Stream sound and quality$/`, 1500, motion), motion);
      await run('viewer', `if ($('.glass-stage-popover')) await click(btn('Stream sound and quality')); return 1;`).catch(() => null);
    } else if (p === 'scroll') {
      st = await viewerLayout('chat');
      await sleep(1000);
      st = await viewerState();
      const px = setProbeX([st.box]);
      await sleep(600);
      await phase(`${tag}:${p}`, { motion: 'smooth scroll of the chat beside the stream, 600 px every 300 ms', ...px }, `
        const col = $('.ix-call-chat');
        const sc = col ? [col, ...col.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) : null;
        if (!sc) return 'no scroller';
        const until = Date.now() + ${motion}; let n = 0, dir = -1;
        while (Date.now() < until) { sc.scrollBy({ top: dir * 600, behavior: 'smooth' }); n++; if (n % 4 === 0) dir = -dir; await sleep(300); }
        return n;`, motion);
      await viewerLayout('normal');
    }
  }
}

async function viewerQuality(value) {
  return run('viewer', `
    if (!$('.glass-stage-popover__select')) { await click(btn('Stream sound and quality')); await sleep(500); }
    const sel = $('.glass-stage-popover__select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    if ($('.glass-stage-popover__select')) await click(btn('Stream sound and quality'));
    return ${JSON.stringify(value)};`);
}

// The capture sink the app creates for stream audio exists only while it
// shares, so its recorder starts again with every share.
function restartSenderAudioRecorder() {
  const pidFile = join(OUT, 'sender', 'audiorec.pid');
  try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* not running */ }
  const child = spawn('python3', [join(here, '..', 'audiorec.py'), 'paracord_stream_capture', join(OUT, 'sender', 'audio.log')], {
    env: { ...process.env, PIPEWIRE_REMOTE: arg('graph-a', 'sa-pwA') }, stdio: 'ignore', detached: true,
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

async function freshShare(preset) {
  log('preset', preset);
  await senderOpenCall();
  if (await senderSharing()) { await senderStop(); await sleep(2500); }
  await senderQuality(preset);
  mark('share-start', { preset });
  await senderStart();
  restartSenderAudioRecorder();
  await sleep(4000);
  const st = await viewerWatch();
  log('  viewer', JSON.stringify(st));
  await sleep(4000); // encoder and relay settle; the viewer's first keyframe
}

const stopRelay = startRelayPoll();
const stopGpu = startGpuPoll();
mark('campaign', { plan, presets: PRESETS });
try {
  if (plan === 'full' || plan === 'quick') {
    for (const preset of PRESETS) {
      await freshShare(preset);
      await layoutPhases(arg('tag', '') + preset, plan === 'quick' ? { phases: ['normal', 'theater', 'fullscreen', 'theater-toggle'] } : {});
    }
  }
  if (plan === 'sizes') {
    // The viewer's output was switched by the caller; rest and theater motion only.
    const size = arg('size', '1920x1080');
    for (const preset of PRESETS) {
      await freshShare(preset);
      await layoutPhases(`${preset}@${size}`, { phases: ['normal', 'theater', 'fullscreen', 'theater-toggle', 'scroll'] });
    }
  }
  if (plan === 'layers') {
    const preset = PRESETS[0];
    await freshShare(preset);
    await viewerLayout('normal');
    for (const q of ['auto', 'low', 'medium', 'high', 'source', 'auto']) {
      await viewerQuality(q);
      await sleep(3000);
      const st = await viewerState();
      const px = setProbeX([st.box]);
      await sleep(3000);
      await phase(`${preset}:quality-${q}`, { viewerQuality: q, ...px }, null, 8000);
    }
  }
  if (plan === 'audio') {
    // Stream audio (stream-fix V4): the A/V offset at rest, a tone the sharer's
    // own app plays (must not reach the viewer; the pattern's 1 kHz bursts, from
    // another application, must), and a share with its sound off (nothing).
    for (const preset of PRESETS) {
      await freshShare(preset);
      await viewerLayout('normal');
      const st = await viewerState();
      setProbeX([st.box]);
      await sleep(3000);
      await phase(`${preset}:audio-rest`, { preset }, null, 20000);
      mark('start', { phase: `${preset}:app-tone`, preset, appToneHz: 3000 });
      await run('sender', `
        const ctx = new AudioContext();
        await ctx.resume();
        const until = Date.now() + 12000; let n = 0;
        while (Date.now() < until) {
          const osc = ctx.createOscillator(); const gain = ctx.createGain();
          osc.frequency.value = 3000; gain.gain.value = 0.8;
          osc.connect(gain).connect(ctx.destination);
          osc.start(); osc.stop(ctx.currentTime + 0.3); n++;
          await sleep(1300);
        }
        await ctx.close();
        return { tones: n, state: ctx.state };`, 40000).then((r) => log('  app tone', JSON.stringify(r)));
      mark('end', { phase: `${preset}:app-tone`, preset });
    }
    // A share with its sound off. The desktop UI always asks for sound and
    // its IPC entry points are read-only, so the share starts as usual and the
    // engine's own switch then turns the sound off (the command a share
    // without sound sends: capture stopped, track withdrawn).
    await senderOpenCall();
    if (await senderSharing()) { await senderStop(); await sleep(2500); }
    mark('share-start', { preset: PRESETS[0], audio: false });
    await senderStart();
    restartSenderAudioRecorder();
    await sleep(4000);
    const off = await run('sender', `
      // The page's media engine, found through React's tree.
      const rootEl = document.getElementById('root') ?? document.body.firstElementChild;
      const containerKey = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$'));
      const seenObjects = new WeakSet(); const fibers = [rootEl[containerKey]]; let visited = 0;
      const findEngine = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 5 || seenObjects.has(v) || v instanceof Node) return null;
        seenObjects.add(v);
        if (typeof v.sessionOwnerId === 'string' && typeof v.disableNativeScreenAudio === 'function') return v;
        for (const k of Object.keys(v).slice(0, 80)) {
          if (['return', 'child', 'sibling', 'alternate', '_owner'].includes(k)) continue;
          try { const r = findEngine(v[k], depth + 1); if (r) return r; } catch { /* getters */ }
        }
        return null;
      };
      let engine = null;
      while (fibers.length && visited < 30000 && !engine) {
        const f = fibers.pop(); visited++; if (!f) continue;
        engine = findEngine(f.memoizedState, 0) || findEngine(f.memoizedProps, 0);
        if (f.child) fibers.push(f.child); if (f.sibling) fibers.push(f.sibling);
      }
      if (!engine) throw new Error('media engine not found');
      engine.disableNativeScreenAudio();
      await sleep(1500);
      return { active: engine.isScreenShareAudioActive(), revision: engine.screenRevision };`, 60000);
    log('  share sound off', JSON.stringify(off));
    await sleep(4000);
    await viewerWatch();
    await viewerLayout('normal');
    await phase('audio-off', { audio: false }, null, 20000);
    await senderStop();
  }
  if (plan === 'midstream') {
    const order = arg('order', '720p30,1080p60,4k60,movie-100,1440p60,720p30').split(',');
    await freshShare(order[0]);
    await viewerLayout('theater');
    let st = await viewerState();
    setProbeX([st.box]);
    for (const preset of order) {
      mark('change', { preset });
      const t0 = mono();
      await senderQuality(preset);
      mark('changed', { preset, uiMs: Math.round((mono() - t0) / 1000) });
      await sleep(1500);
      st = await viewerState();
      setProbeX([st.box]);
      await phase(`midstream:${preset}`, { preset }, null, 9000);
    }
  }
} finally {
  stopRelay();
  stopGpu();
  mark('campaign-end', {});
}
