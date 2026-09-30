#!/usr/bin/env node
// Live proof of WP-G6b (viewer keys, roster marker, close reasons), from Sean's
// and Luke's own clients, against the Lounge call a `glass-scene.mjs` holder
// keeps running (Vincent sharing, Brendan on camera and talking, Nick muted).
// The cast runs the embedded build; Sean and Luke run the app from a Vite dev
// server proxied to the instance, and the probe reads their stores, their
// engines and every media control message their engines receive.
//
//   node scripts/live-env.mjs --port 18820 --data <dir>
//   node client/scripts/glass-scene.mjs --base http://127.0.0.1:18820 --hold --out <dir>
//   node client/scripts/glass-scene/g6b-probe.mjs --base http://127.0.0.1:18820 --scene <dir>/scene.json
//
// What it checks
//   - Sean watches Vincent without joining: frames decode, and his view session
//     is sent no voice key at all, only Vincent's screen keys.
//   - Luke, in the call, is sent no new voice key by anybody (Vincent, Brendan,
//     Nick) when Sean's view starts or stops; nothing rotates when it starts;
//     when it stops only Vincent's screen keys rotate, and Luke's picture of
//     Vincent's screen keeps coming.
//   - Sean's own view roster names only Vincent, marked `member` by the relay.
//   - Sean's view replaced from another context ends as "superseded".
//   - Sean's view ends as "revoked" once he may no longer see the channel.
//
// Options: --base <url>, --scene <file>, --vite-port <n> (default 1582), --headed

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { launchBrowser, openAs } from './ui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg('base', 'http://127.0.0.1:18820');
const SCENE = arg('scene', join(clientRoot, '..', 'output', 'design-reference', 'glass-build', 'live', 'scene.json'));
const VITE_PORT = Number(arg('vite-port', '1582'));
const HEADLESS = !process.argv.includes('--headed');
const APP = `http://127.0.0.1:${VITE_PORT}`;
const OVERWRITE_TARGET_MEMBER = 1;
const VIEW_CHANNEL = 1 << 10;

const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
const gameNight = scene.servers.gameNight;
const lounge = gameNight.channels.lounge;
const accounts = scene.accounts;
const api = createApi(BASE);
const results = [];
const t0 = Date.now();
const log = (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Counts WebTransport connections the page opens. Installed before the app loads.
const INSTRUMENT = `(() => {
  const probe = window.__probe = { webTransports: [] };
  const Native = window.WebTransport;
  if (Native) {
    window.WebTransport = class extends Native {
      constructor(url, options) { super(url, options); probe.webTransports.push(url); }
    };
  }
})();`;

async function startVite() {
  const child = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: clientRoot,
    // No hot replacement: other work edits the tree while the probe runs, and a
    // reload would drop the call and the view mid-check.
    env: { ...process.env, VITE_DEV_PROXY_TARGET: BASE, BROWSER: 'none', VITE_DEV_HMR: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(APP)).ok) return child; } catch { /* not yet */ }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`vite did not start on ${APP}:\n${output.slice(-2000)}`);
    }
    await sleep(500);
  }
}

async function signedIn(browser, key) {
  const session = await openAs(browser, APP, { ...accounts[key] }, { log: () => {} });
  await session.context.addInitScript({ content: INSTRUMENT });
  await session.page.reload();
  await session.page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  session.page.on('framenavigated', (frame) => {
    if (frame === session.page.mainFrame()) log(`  (${key} navigated) ${frame.url()}`);
  });
  return session;
}

/**
 * Open a route, reach the store modules the app runs there, and record every
 * media control message any browser engine on the page handles: its type,
 * sender, epoch and track, and the role of the engine that received it.
 */
async function openRoute(page, path) {
  await page.goto(path);
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  await page.waitForFunction(async () => {
    window.__voice = await import('/src/stores/voiceStore.ts');
    window.__frames = await import('/src/stores/voice/viewFrames.ts');
    const { BrowserMediaEngine } = await import('/src/lib/media/browserMediaEngine.ts');
    if (!window.__ctl) {
      window.__ctl = [];
      const original = BrowserMediaEngine.prototype.handleStreamControlMessage;
      BrowserMediaEngine.prototype.handleStreamControlMessage = function recorded(message) {
        const participants = message.type === 'session_state'
          ? (message.participants ?? []).map((p) => ({ userId: String(p.userId), kind: p.kind ?? null }))
          : message.type === 'session_participant_join'
            ? [{ userId: String(message.participant?.userId), kind: message.participant?.kind ?? null }]
            : undefined;
        window.__ctl.push({
          at: performance.now(), role: this.role, type: message.type,
          sender: message.sender_user_id != null ? String(message.sender_user_id) : undefined,
          epoch: message.epoch, stream: message.stream_id, track: message.track_id,
          participants,
        });
        return original.call(this, message);
      };
    }
    return true;
  }, null, { timeout: 60_000 });
}

async function until(page, fn, arg, timeoutMs = 30_000) {
  return page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 200 }).then((handle) => handle.jsonValue());
}

const since = (page, mark) => page.evaluate((mark) => window.__ctl.filter((m) => m.at >= mark), mark);
const now = (page) => page.evaluate(() => performance.now());
const describe = (messages) => messages.map((m) => `${m.type}${m.sender ? ` from ${m.sender}` : ''}${m.track ? ` ${m.track}` : ''}${m.epoch != null ? ` e${m.epoch}` : ''}`).join(', ') || 'none';

async function main() {
  const tokens = {};
  for (const key of ['jeremy', 'sean', 'brendan']) {
    tokens[key] = (await api.account({ username: accounts[key].username, email: accounts[key].email, password: accounts[key].password }, { likelyExists: true })).token;
  }
  const ids = Object.fromEntries(Object.entries(accounts).map(([key, account]) => [key, account.id]));
  const room = await api.request(tokens.jeremy, 'GET', `/voice/${lounge}/media-stats`);
  const present = room.participants.map((p) => p.user_id);
  if (!present.includes(ids.vincent) || !present.includes(ids.brendan)) {
    throw new Error(`the Lounge call is not held (relay has ${present.join(', ') || 'nobody'}); run glass-scene.mjs first`);
  }
  log(`relay: ${room.connected_participants} connected in Lounge before the probe`);

  const vite = await startVite();
  log(`app served from ${APP} (proxied to ${BASE})`);
  const browser = await launchBrowser({ headless: HEADLESS });
  const cleanups = [async () => browser.close(), async () => vite.kill('SIGTERM')];
  try {
    const sean = await signedIn(browser, 'sean');
    const luke = await signedIn(browser, 'luke');
    const { page } = sean;
    const general = `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`;
    await openRoute(luke.page, general);
    await openRoute(page, general);
    // A cold Vite dependency optimizer reloads the pages once; let it, then
    // open the route again so the hooks sit in the page that stays.
    await sleep(8000);
    await openRoute(luke.page, general);
    await openRoute(page, general);
    await sleep(2000);

    // ── Luke joins the call: the member who watches everybody's keys ─────
    log('Luke joins Lounge and taps Vincent’s screen');
    const lukeJoin = await luke.page.evaluate(async ({ lounge, guild, vincent }) => {
      const { useVoiceStore } = window.__voice;
      await useVoiceStore.getState().joinChannel(lounge, guild);
      const s = useVoiceStore.getState();
      window.__lukeFrames = [];
      window.__lukeTap = s.mediaEngine.tapVideoFrames(vincent, 'screen', (frame) => {
        window.__lukeFrames.push(performance.now());
        frame.close();
      });
      return { connected: s.connected, mode: s.callMode, error: s.connectionError };
    }, { lounge, guild: gameNight.id, vincent: ids.vincent });
    check('Luke joins the call', lukeJoin.connected && lukeJoin.mode === 'joined', JSON.stringify(lukeJoin));
    // Everybody rotated for Luke's arrival; let it settle.
    await sleep(8000);
    const lukeFramesBefore = await luke.page.evaluate(() => window.__lukeFrames.length);
    check('Luke decodes Vincent’s screen', lukeFramesBefore > 0, `${lukeFramesBefore} frames`);

    // ── The room light's ambient view leaving (G8 runs one for the server) ─
    // On Game Night the room light views the busiest stream (Vincent's) with
    // an ambient view of its own. Leaving for Home ends it: a viewer departs,
    // so Vincent rotates the keys it could open (the screen's), not the voice.
    const ambientBefore = await page.evaluate(() => {
      const view = window.__voice.useVoiceStore.getState().ambientView;
      return view ? { phase: view.phase, route: view.route, streamer: view.streamerId } : null;
    });
    log(`  Sean's room light before: ${JSON.stringify(ambientBefore)}`);
    const lukeMarkAmbient = await now(luke.page);
    await openRoute(page, '/app');
    await sleep(5000);
    const ambientAfter = await page.evaluate(() => window.__voice.useVoiceStore.getState().ambientView?.phase ?? null);
    const lukeAtAmbientEnd = await since(luke.page, lukeMarkAmbient);
    if (ambientBefore?.phase === 'live' && ambientBefore.route === 'session') {
      const rotated = lukeAtAmbientEnd.filter((m) => m.type === 'key_deliver' || m.type === 'stream_key_deliver');
      check('an ambient viewer leaving rotates Vincent’s screen keys only, never a voice key',
        ambientAfter !== 'live' && rotated.every((m) => m.type === 'stream_key_deliver' && m.sender === ids.vincent && /:screen$/.test(m.stream)),
        `ambient now ${ambientAfter}; Luke was sent ${describe(rotated)}`);
    } else {
      log(`  (no ambient view of Vincent was running on Game Night: ${JSON.stringify(ambientBefore)})`);
    }

    // ── Sean starts watching Vincent without joining ─────────────────────
    const lukeMarkStart = await now(luke.page);
    log('watch: Sean watches Vincent without joining');
    const watch = await page.evaluate(async ({ guild, lounge, vincent }) => {
      const { useVoiceStore } = window.__voice;
      window.__watchMark = performance.now();
      await useVoiceStore.getState().startWatch({ guildId: guild, channelId: lounge, streamerId: vincent });
      const s = useVoiceStore.getState();
      window.__watchFrames = [];
      window.__stopWatchFrames = window.__frames.subscribeViewFrames('watch', (frame) => {
        window.__watchFrames.push({ width: frame.width, height: frame.height });
        frame.bitmap.close();
      }, { fps: 4 });
      return { phase: s.watchView.phase, route: s.watchView.route, inCall: s.connected };
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    check('the watch is a live view session, not in the call', watch.phase === 'live' && watch.route === 'session' && !watch.inCall, JSON.stringify(watch));
    await sleep(6000);
    const watched = await page.evaluate(() => ({
      frames: window.__watchFrames.length,
      sizes: [...new Set(window.__watchFrames.map((f) => `${f.width}x${f.height}`))],
      view: window.__ctl.filter((m) => m.role === 'view' && m.at >= window.__watchMark),
    }));
    check('Vincent’s frames decode on Sean’s view session', watched.frames >= 10 && watched.sizes.every((size) => size !== '0x0'),
      `${watched.frames} sampled frames in 6s, sizes ${watched.sizes.join(', ')}`);
    const voiceKeysToView = watched.view.filter((m) => m.type === 'key_deliver');
    const streamKeysToView = watched.view.filter((m) => m.type === 'stream_key_deliver');
    check('no voice key reaches Sean’s view session', voiceKeysToView.length === 0, `voice keys: ${describe(voiceKeysToView)}`);
    check('the view session gets Vincent’s screen keys and nothing else',
      streamKeysToView.length > 0 && streamKeysToView.every((m) => m.sender === ids.vincent && /:screen$/.test(m.stream)),
      describe(streamKeysToView));
    const viewRoster = watched.view.find((m) => m.type === 'session_state')?.participants ?? [];
    check('Sean’s view roster is Vincent, marked member by the relay',
      viewRoster.some((p) => p.userId === ids.vincent && p.kind === 'member') && viewRoster.every((p) => p.userId === ids.vincent || p.userId === ids.sean),
      JSON.stringify(viewRoster));
    const lukeAtStart = await since(luke.page, lukeMarkStart);
    // Every epoch Luke held for each sender's key before Sean's view started.
    const knownEpochs = await luke.page.evaluate((mark) => {
      const known = {};
      for (const m of window.__ctl.filter((m) => m.at < mark && (m.type === 'key_deliver' || m.type === 'stream_key_deliver'))) {
        const slot = `${m.sender}|${m.stream ?? 'voice'}|${m.track ?? ''}`;
        known[slot] = Math.max(known[slot] ?? 0, m.epoch);
      }
      return known;
    }, lukeMarkStart);
    const slotOf = (m) => `${m.sender}|${m.stream ?? 'voice'}|${m.track ?? ''}`;
    const lukeKeysAtStart = lukeAtStart.filter((m) => m.type === 'key_deliver' || m.type === 'stream_key_deliver');
    const newEpochsAtStart = lukeKeysAtStart.filter((m) => m.epoch !== knownEpochs[slotOf(m)]);
    const lukeTrail = await luke.page.evaluate((mark) => window.__ctl
      .filter((m) => m.at >= mark - 12_000 && !['receiver_report', 'bandwidth_feedback'].includes(m.type))
      .map((m) => `${((m.at - mark) / 1000).toFixed(2)}s ${m.type}${m.sender ? ` from ${m.sender}` : ''}${m.track ? ` ${m.track}` : ''}${m.epoch != null ? ` e${m.epoch}` : ''}`), lukeMarkStart);
    log(`  Luke's control messages around the view start (0 = start):\n    ${lukeTrail.join('\n    ')}`);
    log(`  Luke's known epochs before: ${JSON.stringify(knownEpochs)}`);
    check('Sean’s view starting rotates nothing: no new key epoch from Vincent, Brendan or Nick reaches Luke',
      newEpochsAtStart.length === 0, `new epochs: ${describe(newEpochsAtStart)}`);
    check('and no key is even re-sent to Luke (an unchanged republish no longer re-subscribes)',
      lukeKeysAtStart.length === 0, describe(lukeKeysAtStart));
    check('and nobody in the call is told about Sean', !lukeAtStart.some((m) => m.type.startsWith('session_participant') && m.participants?.some((p) => p.userId === ids.sean)),
      describe(lukeAtStart.filter((m) => m.type.startsWith('session_'))));
    const counts = await api.request(tokens.jeremy, 'GET', `/api/v2/voice/${lounge}/watchers`);
    check('the server counts one watcher', (counts.streams.find((s) => s.user_id === ids.vincent)?.watchers ?? 0) === 1, JSON.stringify(counts.streams));

    // ── Sean stops watching ───────────────────────────────────────────────
    const lukeMarkStop = await now(luke.page);
    const lukeFramesAtStop = await luke.page.evaluate(() => window.__lukeFrames.length);
    await page.evaluate(async () => { window.__stopWatchFrames(); await window.__voice.useVoiceStore.getState().stopWatch(); });
    await sleep(5000);
    const lukeAtStop = await since(luke.page, lukeMarkStop);
    const voiceKeysAtStop = lukeAtStop.filter((m) => m.type === 'key_deliver');
    const streamKeysAtStop = lukeAtStop.filter((m) => m.type === 'stream_key_deliver');
    check('Sean’s view stopping sends Luke no new voice key from anybody', voiceKeysAtStop.length === 0, describe(voiceKeysAtStop));
    check('only Vincent’s screen keys rotate (for Luke), never Brendan’s or Nick’s, never a camera',
      streamKeysAtStop.every((m) => m.sender === ids.vincent && /:screen$/.test(m.stream)), describe(streamKeysAtStop));
    const lukeGap = await luke.page.evaluate((mark) => {
      const frames = window.__lukeFrames.filter((at) => at >= mark - 2000);
      const gaps = frames.slice(1).map((at, index) => at - frames[index]);
      return { frames: frames.length, maxGapMs: gaps.length ? Math.round(Math.max(...gaps)) : null };
    }, lukeMarkStop);
    const lukeFramesAfterStop = await luke.page.evaluate(() => window.__lukeFrames.length);
    check('Luke’s picture of Vincent’s screen keeps coming across the rotation',
      lukeFramesAfterStop > lukeFramesAtStop, `${lukeFramesAfterStop - lukeFramesAtStop} frames in 5s, longest gap ${lukeGap.maxGapMs}ms`);

    // ── A view replaced from another context ──────────────────────────────
    log('supersede: another device of Sean’s opens a view; this watch must end as superseded');
    await page.evaluate(async ({ guild, lounge, vincent }) => {
      await window.__voice.useVoiceStore.getState().startWatch({ guildId: guild, channelId: lounge, streamerId: vincent });
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    const replacedAt = Date.now();
    const elsewhere = await api.request(tokens.sean, 'POST', `/api/v2/voice/${lounge}/view`, { kind: 'watch', user_id: ids.vincent });
    const superseded = await until(page, () => {
      const view = window.__voice.useVoiceStore.getState().watchView;
      return view && (view.phase === 'ended' || view.phase === 'failed')
        ? { phase: view.phase, endReason: view.endReason, error: view.error } : false;
    }, null, 30_000).catch(() => null);
    log(`  settled ${((Date.now() - replacedAt) / 1000).toFixed(1)}s after the replacement`);
    check('a replaced watch reports "superseded" (the relay’s close capsule reaches the browser)',
      superseded?.phase === 'ended' && superseded.endReason === 'superseded', JSON.stringify(superseded));
    const transportsBefore = await page.evaluate(() => window.__probe.webTransports.length);
    await sleep(6000);
    const opened = await page.evaluate((before) => window.__probe.webTransports.slice(before), transportsBefore);
    const mediaRedials = opened.filter((url) => /\/media(\?|$)/.test(new URL(url).pathname + new URL(url).search));
    check('and is not dialed back', mediaRedials.length === 0, `${opened.length} new connections in 6s: ${opened.join(', ') || 'none'}`);
    await api.request(tokens.sean, 'DELETE', `/api/v2/voice/${lounge}/view?session_id=${encodeURIComponent(elsewhere.session_id)}`);
    await page.evaluate(() => window.__voice.useVoiceStore.getState().stopWatch());
    await sleep(1500);

    // ── Losing access mid-view ────────────────────────────────────────────
    log('revoke: Sean loses VIEW_CHANNEL on Lounge while watching');
    await page.evaluate(async ({ guild, lounge, vincent }) => {
      await window.__voice.useVoiceStore.getState().startWatch({ guildId: guild, channelId: lounge, streamerId: vincent });
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    const revokedAt = Date.now();
    await api.request(tokens.brendan, 'PUT', `/channels/${lounge}/overwrites/${ids.sean}`, {
      target_type: OVERWRITE_TARGET_MEMBER, allow_perms: 0, deny_perms: VIEW_CHANNEL,
    });
    try {
      const revoked = await until(page, () => {
        const view = window.__voice.useVoiceStore.getState().watchView;
        return view && (view.phase === 'ended' || view.phase === 'failed')
          ? { phase: view.phase, endReason: view.endReason, error: view.error } : false;
      }, null, 20_000).catch(() => null);
      log(`  settled ${((Date.now() - revokedAt) / 1000).toFixed(1)}s after the overwrite`);
      check('the view ends as "revoked" within one sweep', revoked?.phase === 'ended' && revoked.endReason === 'revoked', JSON.stringify(revoked));
      const afterRevoke = await api.request(tokens.jeremy, 'GET', `/api/v2/voice/${lounge}/watchers`);
      check('and is no longer counted', (afterRevoke.streams.find((s) => s.user_id === ids.vincent)?.watchers ?? 0) === 0, JSON.stringify(afterRevoke.streams));
    } finally {
      await api.request(tokens.brendan, 'DELETE', `/channels/${lounge}/overwrites/${ids.sean}`).catch((error) => log(`  could not remove the overwrite: ${error.message}`));
      await page.evaluate(() => window.__voice.useVoiceStore.getState().stopWatch()).catch(() => {});
    }

    await luke.page.evaluate(async () => { window.__lukeTap?.release(); await window.__voice.useVoiceStore.getState().leaveChannel(); });
    await sleep(1500);
  } finally {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  }
}

main()
  .catch((error) => { check('probe ran', false, error.message); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    log(`${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
