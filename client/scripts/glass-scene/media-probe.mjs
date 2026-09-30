#!/usr/bin/env node
// Live proof of the Glass media contract (WP-G6), from Sean's own client, against
// the Lounge call a `glass-scene.mjs` holder keeps running (Vincent sharing,
// Brendan on camera and talking, Nick muted).
//
//   node scripts/live-env.mjs --port 18520 --data <dir>
//   node client/scripts/glass-scene.mjs --base http://127.0.0.1:18520 --out <dir>   # holds the call
//   node client/scripts/glass-scene/media-probe.mjs --base http://127.0.0.1:18520 --scene <dir>/scene.json
//
// There is no Glass control for listen, watch or ambient yet (the pill and the
// stage are WP-G12/G14), so the probe drives the voice store itself. It serves
// the app from a Vite dev server proxied to the instance, signs Sean (and Luke,
// the onlooker) in through the login page, and imports the very store module
// the app runs (`/src/stores/voiceStore.ts`: same URL, same instance). Every
// check reads either that store, the engine behind it, or the relay's own
// counters (`GET /voice/{id}/media-stats`, `GET /api/v2/voice/{id}/watchers`).
// Nothing is mocked. PASS/FAIL per step; exits non-zero on any FAIL.
//
// Options
//   --base <url>     instance (default http://127.0.0.1:18520)
//   --scene <file>   scene.json a glass-scene run wrote (ids and sign-ins)
//   --vite-port <n>  dev server port (default 1522)
//   --headed         show the browsers

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
const BASE = arg('base', 'http://127.0.0.1:18520');
const SCENE = arg('scene', join(clientRoot, '..', 'output', 'design-reference', 'glass-build', 'live', 'scene.json'));
const VITE_PORT = Number(arg('vite-port', '1522'));
const HEADLESS = !process.argv.includes('--headed');
const APP = `http://127.0.0.1:${VITE_PORT}`;

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

// Counts what the page does behind the store's back: microphone opens and
// WebTransport connections. Installed before the app loads.
const INSTRUMENT = `(() => {
  const probe = window.__probe = { getUserMedia: 0, webTransports: [] };
  const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (original) navigator.mediaDevices.getUserMedia = (constraints) => {
    if (constraints && constraints.audio) probe.getUserMedia += 1;
    return original(constraints);
  };
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
    env: { ...process.env, VITE_DEV_PROXY_TARGET: BASE, BROWSER: 'none' },
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
  const person = { ...accounts[key], name: accounts[key].name };
  const session = await openAs(browser, APP, person, { log: () => {} });
  await session.context.addInitScript({ content: INSTRUMENT });
  await session.page.reload();
  await session.page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  session.page.on('console', (message) => {
    const text = message.text();
    if (/\[vite\]|reload|optimiz/i.test(text)) log(`  (${key} console) ${text.slice(0, 200)}`);
  });
  session.page.on('framenavigated', (frame) => {
    if (frame === session.page.mainFrame()) log(`  (${key} navigated) ${frame.url()}`);
  });
  return session;
}

/** Open a route and reach the very store modules the app runs there. */
async function openRoute(page, path) {
  await page.goto(path);
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  await page.waitForFunction(async () => {
    window.__voice = await import('/src/stores/voiceStore.ts');
    window.__frames = await import('/src/stores/voice/viewFrames.ts');
    return true;
  }, null, { timeout: 60_000 });
}

async function relayRoom(token) {
  return api.request(token, 'GET', `/voice/${lounge}/media-stats`);
}

async function until(page, fn, arg, timeoutMs = 30_000) {
  return page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 200 }).then((handle) => handle.jsonValue());
}

async function main() {
  const tokens = {};
  for (const key of ['jeremy', 'sean']) {
    tokens[key] = (await api.account({ username: accounts[key].username, email: accounts[key].email, password: accounts[key].password }, { likelyExists: true })).token;
  }
  const ids = { sean: accounts.sean.id, vincent: accounts.vincent.id, brendan: accounts.brendan.id };
  const room = await relayRoom(tokens.jeremy);
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
    // Luke looks at Game Night, so his store holds its voice states and counts.
    await openRoute(luke.page, `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`);
    await openRoute(page, `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`);
    await sleep(3000);

    // ── 1. Listen in ─────────────────────────────────────────────────────
    log('listen: Sean listens in to Lounge');
    const listen = await page.evaluate(async ({ lounge, guild }) => {
      const { useVoiceStore } = window.__voice;
      await useVoiceStore.getState().listen(lounge, guild);
      const s = useVoiceStore.getState();
      window.__listenEngine = s.mediaEngine;
      return { mode: s.callMode, connected: s.connected, error: s.connectionError,
        getUserMedia: window.__probe.getUserMedia, transports: window.__probe.webTransports.length };
    }, { lounge, guild: gameNight.id });
    check('listen connects in listen mode', listen.connected && listen.mode === 'listen', JSON.stringify(listen));
    check('listening never opens the microphone', listen.getUserMedia === 0, `getUserMedia(audio) calls: ${listen.getUserMedia}`);
    const heard = await until(page, (brendan) => {
      const engine = window.__listenEngine;
      const participant = [...engine.participants.values()].find((p) => p.userId === brendan);
      const speaking = window.__voice.useVoiceStore.getState().speakingUsers.has(brendan);
      return participant && performance.now() - participant.lastAudioAt < 2000 && speaking
        ? { lastAudioMsAgo: Math.round(performance.now() - participant.lastAudioAt), speaking } : false;
    }, ids.brendan, 30_000).catch(() => null);
    check('a listener hears Brendan (his audio arrives and is decoded)', !!heard, heard ? JSON.stringify(heard) : 'no audio from Brendan within 30s');
    await sleep(4000);
    const listening = await relayRoom(tokens.jeremy);
    const seanAtRelay = listening.participants.find((p) => p.user_id === ids.sean);
    check('the relay received no media from the listener', !!seanAtRelay && seanAtRelay.audio_datagrams_received === 0 && seanAtRelay.video_datagrams_received === 0,
      seanAtRelay ? `audio ${seanAtRelay.audio_datagrams_received}, video ${seanAtRelay.video_datagrams_received}` : 'Sean is not at the relay');
    const seenByLuke = await until(luke.page, (sean) => window.__voice.useVoiceStore.getState().participants.get(sean)?.mode ?? false, ids.sean, 15_000).catch(() => null);
    check('others see Sean "Listening in"', seenByLuke === 'listen', `Luke's store: mode ${seenByLuke}`);

    // ── 2. Upgrade in place ───────────────────────────────────────────────
    log('upgrade: Sean joins from listening');
    const upgrade = await page.evaluate(async () => {
      const { useVoiceStore } = window.__voice;
      const before = { transports: window.__probe.webTransports.length, engine: useVoiceStore.getState().mediaEngine };
      await useVoiceStore.getState().joinFromListen();
      const s = useVoiceStore.getState();
      return { mode: s.callMode, sameEngine: s.mediaEngine === before.engine,
        newTransports: window.__probe.webTransports.length - before.transports,
        getUserMedia: window.__probe.getUserMedia, error: s.modeError };
    });
    check('the upgrade keeps the same engine and opens no new connection',
      upgrade.mode === 'joined' && upgrade.sameEngine && upgrade.newTransports === 0, JSON.stringify(upgrade));
    check('the microphone opens only now', upgrade.getUserMedia === 1, `getUserMedia(audio) calls: ${upgrade.getUserMedia}`);
    await sleep(4000);
    const joined = await relayRoom(tokens.jeremy);
    const seanJoined = joined.participants.find((p) => p.user_id === ids.sean);
    check('after the upgrade the relay receives Sean’s audio', (seanJoined?.audio_datagrams_received ?? 0) > 0,
      `audio datagrams from Sean: ${seanJoined?.audio_datagrams_received}`);
    check('the relay still has one Sean connection (no reconnect)', joined.participants.filter((p) => p.user_id === ids.sean).length === 1
      && seanJoined?.session_id === seanAtRelay?.session_id, `receipt ${seanJoined?.session_id}`);
    const lukeSeesJoined = await until(luke.page, (sean) => window.__voice.useVoiceStore.getState().participants.get(sean)?.mode === 'joined', ids.sean, 15_000).catch(() => false);
    check('others see Sean joined', !!lukeSeesJoined);
    await page.evaluate(() => window.__voice.useVoiceStore.getState().leaveChannel());
    await sleep(3000);

    // ── 3. Watch without joining ──────────────────────────────────────────
    log('watch: Sean watches Vincent without joining');
    const watch = await page.evaluate(async ({ guild, lounge, vincent }) => {
      const { useVoiceStore } = window.__voice;
      const transports = window.__probe.webTransports.length;
      await useVoiceStore.getState().startWatch({ guildId: guild, channelId: lounge, streamerId: vincent });
      const s = useVoiceStore.getState();
      window.__watchEngine = s.watchView.engine;
      window.__watchFrames = [];
      window.__stopWatchFrames = window.__frames.subscribeViewFrames('watch', (frame) => {
        window.__watchFrames.push({ at: performance.now(), width: frame.width, height: frame.height });
        frame.bitmap.close();
      }, { fps: 4 });
      return { phase: s.watchView.phase, route: s.watchView.route, inCall: s.connected,
        newTransports: window.__probe.webTransports.length - transports };
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    check('watching is a live view session of its own, without joining', watch.phase === 'live' && watch.route === 'session'
      && !watch.inCall && watch.newTransports === 1, JSON.stringify(watch));
    await sleep(6000);
    const watched = await page.evaluate(() => {
      const engine = window.__watchEngine;
      return { frames: window.__watchFrames.length, sizes: [...new Set(window.__watchFrames.map((f) => `${f.width}x${f.height}`))],
        voiceDecoders: engine.participants.size, voicePackets: [...engine.orphanAudioPackets.values()].reduce((n, q) => n + q.length, 0) };
    });
    check('Vincent’s frames decode on the watch session', watched.frames >= 10 && watched.sizes.every((size) => size !== '0x0'),
      `${watched.frames} sampled frames in 6s at ≤4 Hz, sizes ${watched.sizes.join(', ')}`);
    check('a watch carries no voices', watched.voiceDecoders === 0 && watched.voicePackets === 0,
      `voice decoders ${watched.voiceDecoders}, voice packets ${watched.voicePackets}`);
    const counts = await api.request(tokens.jeremy, 'GET', `/api/v2/voice/${lounge}/watchers`);
    const vincentCount = counts.streams.find((s) => s.user_id === ids.vincent)?.watchers ?? 0;
    check('the server counts one watcher', vincentCount === 1, JSON.stringify(counts.streams));
    const lukeCount = await until(luke.page, ({ lounge, vincent }) => {
      const { useVoiceStore, selectWatcherCount } = window.__voice;
      const scope = useVoiceStore.getState().watchers.size ? JSON.parse([...useVoiceStore.getState().watchers.keys()][0]) : null;
      const count = scope ? selectWatcherCount(useVoiceStore.getState(), { serverId: scope[0], userId: scope[1] }, lounge, vincent) : 0;
      return count || false;
    }, { lounge, vincent: ids.vincent }, 15_000).catch(() => 0);
    check('others see "1 watching" (VOICE_WATCHERS_UPDATE)', lukeCount === 1, `Luke's store: ${lukeCount}`);
    const relayDuringWatch = await relayRoom(tokens.jeremy);
    check('the watcher is not in the call', !relayDuringWatch.participants.some((p) => p.user_id === ids.sean)
      || relayDuringWatch.participants.filter((p) => p.user_id === ids.sean).every((p) => p.audio_datagrams_received === 0),
      `relay rows for Sean: ${relayDuringWatch.participants.filter((p) => p.user_id === ids.sean).length}`);
    await page.evaluate(async () => { window.__stopWatchFrames(); await window.__voice.useVoiceStore.getState().stopWatch(); });
    await sleep(2000);

    // ── 4. Ambient ────────────────────────────────────────────────────────
    log('ambient: the room light views Vincent’s stream');
    const ambient = await page.evaluate(async ({ guild, lounge, vincent }) => {
      const { useVoiceStore } = window.__voice;
      useVoiceStore.getState().startAmbient({ guildId: guild, channelId: lounge, streamerId: vincent });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && useVoiceStore.getState().ambientView?.phase !== 'live') {
        await new Promise((done) => setTimeout(done, 200));
      }
      const view = useVoiceStore.getState().ambientView;
      window.__ambientDecoded = [];
      // What the engine decodes (not what a sampler asks for): the relay's rate.
      window.__ambientTap = view?.engine?.tapVideoFrames(vincent, 'screen', (frame) => {
        window.__ambientDecoded.push({ at: performance.now(), width: frame.displayWidth, height: frame.displayHeight });
        frame.close();
      });
      return { phase: view?.phase, route: view?.route, pause: view?.pauseReason, error: view?.error };
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    check('the ambient view goes live on a session of its own', ambient.phase === 'live' && ambient.route === 'session', JSON.stringify(ambient));
    await sleep(12_000);
    const ambientFrames = await page.evaluate(() => {
      const frames = window.__ambientDecoded;
      const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at);
      return { count: frames.length, sizes: [...new Set(frames.map((f) => `${f.width}x${f.height}`))],
        minGapMs: gaps.length ? Math.round(Math.min(...gaps)) : null,
        spanS: frames.length > 1 ? (frames[frames.length - 1].at - frames[0].at) / 1000 : 0 };
    });
    const rate = ambientFrames.spanS > 0 ? (ambientFrames.count - 1) / ambientFrames.spanS : 0;
    check('ambient frames arrive', ambientFrames.count >= 4, `${ambientFrames.count} frames in 12s, sizes ${ambientFrames.sizes.join(', ')}`);
    check('ambient frames arrive at no more than 1 fps', rate <= 1.1 && (ambientFrames.minGapMs ?? 1000) >= 800,
      `${rate.toFixed(2)} fps, smallest gap ${ambientFrames.minGapMs}ms`);
    const ambientCounts = await api.request(tokens.jeremy, 'GET', `/api/v2/voice/${lounge}/watchers`);
    check('an ambient view is never counted', !ambientCounts.streams.some((s) => s.user_id === ids.vincent && s.watchers > 0),
      JSON.stringify(ambientCounts.streams));
    const hidden = await page.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((done) => setTimeout(done, 300));
      const view = window.__voice.useVoiceStore.getState().ambientView;
      return { phase: view?.phase, pause: view?.pauseReason, engine: !!view?.engine };
    });
    check('ambient closes while the window is hidden', hidden.phase === 'paused' && hidden.pause === 'hidden' && !hidden.engine, JSON.stringify(hidden));
    await page.evaluate(() => { window.__ambientTap?.release(); window.__voice.useVoiceStore.getState().stopAmbient(); });
    await sleep(1500);

    // ── 5. A view replaced from elsewhere stays down ─────────────────────
    log('supersede: another device of Sean’s opens a view; this client’s watch must end, not retry');
    await page.evaluate(async ({ guild, lounge, vincent }) => {
      await window.__voice.useVoiceStore.getState().startWatch({ guildId: guild, channelId: lounge, streamerId: vincent });
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    const replacedAt = Date.now();
    const elsewhere = await api.request(tokens.sean, 'POST', `/api/v2/voice/${lounge}/view`, { kind: 'watch', user_id: ids.vincent });
    const ended = await until(page, () => {
      const view = window.__voice.useVoiceStore.getState().watchView;
      return view && (view.phase === 'ended' || view.phase === 'failed')
        ? { phase: view.phase, endReason: view.endReason, error: view.error } : false;
    }, null, 30_000).catch(() => null);
    log(`  the watch settled ${((Date.now() - replacedAt) / 1000).toFixed(1)}s after the replacement`);
    // The relay's close reason does not reach a browser (Chromium reports a
    // plain loss); the refused readmission that follows is the answer, so the
    // watch reads "ended" rather than "superseded". Either is not retried.
    check('a replaced watch ends (not "failed") and is not retried', ended?.phase === 'ended'
      && (ended.endReason === 'superseded' || ended.endReason === 'ended'), JSON.stringify(ended));
    const transportsBefore = await page.evaluate(() => window.__probe.webTransports.length);
    await sleep(8000);
    const transportsAfter = await page.evaluate(() => window.__probe.webTransports.length);
    check('and is not dialed back', transportsAfter === transportsBefore, `${transportsAfter - transportsBefore} new connections in 8s`);
    await api.request(tokens.sean, 'DELETE', `/api/v2/voice/${lounge}/view?session_id=${encodeURIComponent(elsewhere.session_id)}`);
    await page.evaluate(() => window.__voice.useVoiceStore.getState().stopWatch());
    await sleep(1500);

    // ── 6. Watching, then joining that call, then leaving it ─────────────
    log('carry-over: Sean watches, joins Lounge, leaves again; the watch never stops');
    const framesOn = async (seconds) => {
      await page.evaluate(() => { window.__carryFrames = 0; });
      await sleep(seconds * 1000);
      return page.evaluate(() => window.__carryFrames);
    };
    await page.evaluate(async ({ guild, lounge, vincent }) => {
      const { useVoiceStore } = window.__voice;
      await useVoiceStore.getState().startWatch({ guildId: guild, channelId: lounge, streamerId: vincent });
      window.__carryFrames = 0;
      window.__stopCarry = window.__frames.subscribeViewFrames('watch', (frame) => { window.__carryFrames += 1; frame.bitmap.close(); }, { fps: 4 });
    }, { guild: gameNight.id, lounge, vincent: ids.vincent });
    const beforeJoin = await framesOn(3);
    await page.evaluate(async ({ guild, lounge }) => {
      await window.__voice.useVoiceStore.getState().joinChannel(lounge, guild);
    }, { guild: gameNight.id, lounge });
    const riding = await until(page, () => {
      const s = window.__voice.useVoiceStore.getState();
      return s.watchView?.phase === 'live' && s.watchView.route === 'call' && s.watchView.engine === s.mediaEngine
        ? { route: s.watchView.route } : false;
    }, null, 20_000).catch(() => null);
    const inCallFrames = await framesOn(4);
    const countInCall = (await api.request(tokens.jeremy, 'GET', `/api/v2/voice/${lounge}/watchers`))
      .streams.find((stream) => stream.user_id === ids.vincent)?.watchers ?? 0;
    check('joining the watched call moves the watch onto the call, frames keep coming, still counted once',
      !!riding && beforeJoin > 0 && inCallFrames > 0 && countInCall === 1,
      `before ${beforeJoin} frames/3s, in call ${inCallFrames} frames/4s, watchers ${countInCall}`);
    await page.evaluate(() => window.__voice.useVoiceStore.getState().leaveChannel());
    const back = await until(page, () => {
      const s = window.__voice.useVoiceStore.getState();
      return !s.connected && s.watchView?.phase === 'live' && s.watchView.route === 'session' ? true : false;
    }, null, 30_000).catch(() => false);
    const afterLeave = await framesOn(4);
    const countAfter = (await api.request(tokens.jeremy, 'GET', `/api/v2/voice/${lounge}/watchers`))
      .streams.find((stream) => stream.user_id === ids.vincent)?.watchers ?? 0;
    check('leaving the call keeps watching on a session of its own', back && afterLeave > 0 && countAfter === 1,
      `after leave ${afterLeave} frames/4s, watchers ${countAfter}`);
    await page.evaluate(async () => { window.__stopCarry(); await window.__voice.useVoiceStore.getState().stopWatch(); });
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
