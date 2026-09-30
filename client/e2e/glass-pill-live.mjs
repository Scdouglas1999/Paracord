#!/usr/bin/env node
// Live proof of the call pill (WP-G12), from Sean's own client, against the
// Lounge call a `glass-scene.mjs` holder keeps running (Vincent sharing,
// Brendan on camera and talking, Nick muted). Nothing is mocked: the pill's
// buttons are pressed, and every claim is read back from the store behind it,
// the relay's own counters, or Luke's client (the onlooker).
//
//   node scripts/live-env.mjs --port 18620 --data <dir>
//   node client/scripts/glass-scene.mjs --base http://127.0.0.1:18620 --out <dir>   # holds the call
//   node client/e2e/glass-pill-live.mjs --base http://127.0.0.1:18620 --scene <dir>/scene.json
//
// The app is served from a Vite dev server proxied to the instance (the same
// way `glass-scene/media-probe.mjs` does), so Sean runs this checkout's pill.
// PASS/FAIL per step; exits non-zero on any FAIL. Shots go to
// output/design-reference/glass-build/g12/live-*.png.
//
// Options
//   --base <url>       instance (default http://127.0.0.1:18620)
//   --scene <file>     scene.json a glass-scene run wrote (ids and sign-ins)
//   --vite-port <n>    dev server port (default 18730)
//   --out <dir>        where shots go
//   --headed           show the browsers

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../scripts/glass-scene/api.mjs';
import { dismissOverlays, freshFrame, launchBrowser, openAs, pictureIn } from '../scripts/glass-scene/ui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg('base', 'http://127.0.0.1:18620');
const SCENE = arg('scene', join(clientRoot, '..', 'output', 'design-reference', 'glass-build', 'live', 'scene.json'));
const VITE_PORT = Number(arg('vite-port', '18730'));
const OUT = resolve(arg('out', join(clientRoot, '..', 'output', 'design-reference', 'glass-build', 'g12')));
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
mkdirSync(OUT, { recursive: true });

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
    env: { ...process.env, VITE_DEV_PROXY_TARGET: BASE, BROWSER: 'none', VITE_DEV_HMR: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
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
  return session;
}

/** Open a route and reach the very store modules the app runs there. */
async function openRoute(page, path) {
  await page.goto(path);
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  await page.waitForFunction(async () => {
    window.__voice = await import('/src/stores/voiceStore.ts');
    window.__glass = await import('/src/stores/glassStore.ts');
    window.__actions = await import('/src/components/glass/pill/pillActions.ts');
    return true;
  }, null, { timeout: 60_000 });
}

const until = (page, fn, arg, timeoutMs = 30_000) =>
  page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 200 }).then((handle) => handle.jsonValue());

async function shoot(page, name) {
  await page.mouse.move(1435, 895);
  await freshFrame(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `live-${name}.png`) });
  log(`  shot live-${name}.png`);
}

const relayRoom = (token) => api.request(token, 'GET', `/voice/${lounge}/media-stats`);

async function main() {
  const tokens = {};
  for (const key of ['jeremy', 'sean', 'brendan']) {
    tokens[key] = (await api.account({ username: accounts[key].username, email: accounts[key].email, password: accounts[key].password }, { likelyExists: true })).token;
  }
  const ids = { sean: accounts.sean.id, vincent: accounts.vincent.id, brendan: accounts.brendan.id };
  const room = await relayRoom(tokens.jeremy);
  const present = room.participants.map((p) => p.user_id);
  if (!present.includes(ids.vincent) || !present.includes(ids.brendan)) {
    throw new Error(`the Lounge call is not held (relay has ${present.join(', ') || 'nobody'}); run glass-scene.mjs first`);
  }
  log(`relay: ${room.connected_participants} connected in Lounge before the run`);

  const vite = await startVite();
  log(`app served from ${APP} (proxied to ${BASE})`);
  const browser = await launchBrowser({ headless: HEADLESS });
  const cleanups = [async () => browser.close(), async () => vite.kill('SIGTERM')];
  const pageErrors = [];
  try {
    const sean = await signedIn(browser, 'sean');
    const luke = await signedIn(browser, 'luke');
    const { page } = sean;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openRoute(luke.page, `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`);
    await openRoute(page, `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`);
    // A first visit opens Game Night's welcome screen: a person closes it.
    await dismissOverlays(luke.page, 800, 8000);
    await dismissOverlays(page, 800, 8000);
    await sleep(2000);

    const pill = page.getByRole('region', { name: 'Lounge, live voice channel' });
    const press = async (name) => {
      await dismissOverlays(page, 300, 2000);
      await pill.getByRole('button', { name }).click({ timeout: 15_000 });
    };

    // ── 1. Not joined ───────────────────────────────────────────────────────
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    const compact = {
      faces: await pill.locator('.glass-pill__faces .glass-face').count(),
      listen: await pill.getByRole('button', { name: 'Listen in to Lounge' }).isVisible(),
      watch: await pill.getByRole('button', { name: "Watch Vincent's screen" }).isVisible(),
      join: await pill.getByRole('button', { name: 'Join Lounge' }).isVisible(),
      mutePressed: await pill.getByRole('button', { name: 'Microphone on when you join' }).getAttribute('aria-pressed'),
    };
    check('the pill shows the live Lounge with Listen, Watch, the mute preference and Join',
      compact.faces === 3 && compact.listen && compact.watch && compact.join && compact.mutePressed === 'false', JSON.stringify(compact));
    await shoot(page, '01-compact');

    // ── 1b. Watch (before any call: it never joins) ──────────────────────────
    log('watch: Sean presses Watch');
    try {
      await press("Watch Vincent's screen");
    } catch (error) {
      const seen = await page.evaluate(() => ({
        pill: document.querySelector('.glass-pill')?.outerHTML.slice(0, 1800) ?? null,
        states: [...window.__voice.useVoiceStore.getState().channelParticipants.entries()].map(([id, list]) => [id, list.map((x) => [x.user_id, x.mode, x.self_stream])]),
        call: window.__voice.useVoiceStore.getState().callId,
      }));
      log(`  Watch not offered: ${JSON.stringify(seen)}`);
      await shoot(page, '07-watch-missing');
      throw error;
    }
    const stage = await until(page, () => {
      const s = window.__glass.useGlassStore.getState().stage;
      return s.mode !== 'none' ? { ...s, inCall: window.__voice.useVoiceStore.getState().connected } : false;
    }, null, 10_000).catch(() => null);
    check('Watch opens the stage on Vincent and never joins the call',
      !!stage && stage.channelId === lounge && stage.streamerId === ids.vincent && stage.guildId === gameNight.id && stage.inCall === false, JSON.stringify(stage));
    await sleep(800);
    check('the pill becomes the stage: it is not drawn beside it', (await pill.count()) === 0);
    await page.evaluate(() => window.__glass.useGlassStore.getState().closeStage());
    await pill.waitFor({ state: 'visible', timeout: 10_000 });
    check('closing the stage brings the pill back', true);

    // ── 2. Listening in turned off ────────────────────────────────────────
    log('the moderator turns listening in off for Lounge');
    await api.request(tokens.brendan, 'PATCH', `/channels/${lounge}/features`, { listen_in_enabled: false });
    await press('Listen in to Lounge');
    const refused = await until(page, () => {
      const state = window.__voice.useVoiceStore.getState();
      return state.connectionErrorCode ? { code: state.connectionErrorCode, error: state.connectionError, call: state.callId } : false;
    }, null, 30_000).catch(() => null);
    check('a refused listen closes the call with LISTEN_IN_DISABLED and never becomes a join',
      refused?.code === 'LISTEN_IN_DISABLED' && !refused.call, JSON.stringify(refused));
    const blocked = pill.getByRole('button', { name: 'Listen in to Lounge' });
    await sleep(500);
    check('Listen is disabled with the server’s sentence as its tooltip',
      (await blocked.getAttribute('aria-disabled')) === 'true' && (await blocked.getAttribute('title')) === refused?.error,
      `title: ${await blocked.getAttribute('title')}`);
    check('Join is still offered', await pill.getByRole('button', { name: 'Join Lounge' }).isVisible());
    await shoot(page, '02-listen-off');
    // Turn it back on, and lift the pill's own two-minute block (it would ask the
    // server again on its own after that window; the run does not wait for it).
    await api.request(tokens.brendan, 'PATCH', `/channels/${lounge}/features`, { listen_in_enabled: true });
    const scopeId = await page.evaluate(async () => (await import('/src/stores/serverListStore.ts')).useServerListStore.getState().activeServerId ?? '__local__');
    await page.evaluate(({ serverId, channelId }) => window.__actions.useListenBlockStore.getState().clear(`${serverId}:${channelId}`), { serverId: scopeId, channelId: lounge });

    // ── 3. Listen in ────────────────────────────────────────────────────────
    log('listen: Sean presses Listen');
    await press('Listen in to Lounge');
    const listening = await until(page, () => {
      const s = window.__voice.useVoiceStore.getState();
      return s.connected && s.callMode === 'listen' ? {
        mode: s.callMode, getUserMedia: window.__probe.getUserMedia, transports: window.__probe.webTransports.length,
        muted: s.selfMute } : false;
    }, null, 60_000).catch(() => null);
    check('Listen connects in listen mode and never opens the microphone', !!listening && listening.getUserMedia === 0, JSON.stringify(listening));
    check('the mute preference travels into the call (default muted)', listening?.muted === true);
    const button = pill.getByRole('button', { name: 'Stop listening in to Lounge' });
    check('the button reads "Listening", pressed, amber',
      (await button.getAttribute('aria-pressed')) === 'true' && (await button.textContent())?.includes('Listening') && (await button.getAttribute('data-tone')) === 'amber');
    const seenByLuke = await until(luke.page, (sean) => window.__voice.useVoiceStore.getState().participants.get(sean)?.mode
      ?? [...window.__voice.useVoiceStore.getState().channelParticipants.values()].flat().find((s) => s.user_id === sean)?.mode ?? false,
    ids.sean, 20_000).catch(() => null);
    check('others see Sean "Listening in"', seenByLuke === 'listen', `Luke's store: mode ${seenByLuke}`);

    // The room light will start this view (WP-G8); the pill's preview draws it.
    await page.evaluate(({ guildId, channelId, streamerId }) => window.__voice.useVoiceStore.getState().startAmbient({ guildId, channelId, streamerId }),
      { guildId: gameNight.id, channelId: lounge, streamerId: ids.vincent });
    await press("Show who's in Lounge");
    await pill.getByText("Everyone in Lounge can see you're listening in.").waitFor({ state: 'visible', timeout: 10_000 });
    const roster = await pill.locator('.glass-pill__person').allTextContents();
    check('the roster lists Sean as "Listening in" last, with the sentence under it',
      roster.length === 4 && roster[3].includes('Listening in'), JSON.stringify(roster));
    const preview = pill.locator('.glass-pill__preview canvas');
    const drawn = await until(page, async () => {
      const canvas = document.querySelector('.glass-pill__preview canvas');
      const view = window.__voice.useVoiceStore.getState().ambientView;
      return canvas && view?.phase === 'live' ? { phase: view.phase, route: view.route } : false;
    }, null, 30_000).catch(() => null);
    await sleep(3500);
    const picture = await pictureIn(page, preview);
    check('the preview draws Vincent’s stream from the ambient view',
      !!drawn && picture.distinctColors > 40 && picture.litFraction > 0.2, `${JSON.stringify(drawn)} ${JSON.stringify(picture)}`);
    await shoot(page, '03-expanded-listening');

    // ── 4. Join from listening ────────────────────────────────────────────
    log('join: Sean presses Join while listening');
    await page.evaluate(() => { window.__before = { engine: window.__voice.useVoiceStore.getState().mediaEngine, transports: window.__probe.webTransports.length }; });
    await press('Join Lounge');
    const joined = await until(page, () => {
      const s = window.__voice.useVoiceStore.getState();
      return s.callMode === 'joined' && !s.modeSwitching ? {
        sameEngine: s.mediaEngine === window.__before.engine,
        newTransports: window.__probe.webTransports.length - window.__before.transports,
        getUserMedia: window.__probe.getUserMedia, muted: s.selfMute, error: s.modeError } : false;
    }, null, 60_000).catch(() => null);
    check('Join upgrades in place: the same engine, no new connection, the microphone opens now',
      !!joined && joined.sameEngine && joined.newTransports === 0 && joined.getUserMedia === 1, JSON.stringify(joined));
    check('the mute preference applies: Sean joined muted', joined?.muted === true);
    await pill.getByRole('button', { name: 'Leave Lounge' }).waitFor({ state: 'visible', timeout: 10_000 });
    check('the pill now offers the microphone, Watch and Leave, and no Join or Listen',
      (await pill.getByRole('button', { name: 'Join Lounge' }).count()) === 0
        && (await pill.getByRole('button', { name: /^Listen/ }).count()) === 0
        && (await pill.getByRole('button', { name: 'Microphone' }).getAttribute('aria-pressed')) === 'false');
    const lukeSeesJoined = await until(luke.page, (sean) => [...window.__voice.useVoiceStore.getState().channelParticipants.values()].flat()
      .find((s) => s.user_id === sean)?.mode !== 'listen', ids.sean, 15_000).catch(() => false);
    check('others see Sean joined', !!lukeSeesJoined);
    await sleep(1500);
    const rosterJoined = await pill.locator('.glass-pill__person').allTextContents();
    check('the roster says Sean is "Muted"', rosterJoined[3]?.includes('Muted'), JSON.stringify(rosterJoined));
    await shoot(page, '04-expanded-joined-muted');

    // ── 5. The microphone ───────────────────────────────────────────────────
    const seanAtRelayMuted = (await relayRoom(tokens.jeremy)).participants.find((p) => p.user_id === ids.sean);
    await press('Microphone');
    await sleep(4000);
    const seanAtRelayLive = (await relayRoom(tokens.jeremy)).participants.find((p) => p.user_id === ids.sean);
    check('unmuting from the pill sends audio to the relay',
      (seanAtRelayLive?.audio_datagrams_received ?? 0) > (seanAtRelayMuted?.audio_datagrams_received ?? 0) + 20,
      `audio datagrams ${seanAtRelayMuted?.audio_datagrams_received} → ${seanAtRelayLive?.audio_datagrams_received}`);
    check('the call microphone never rewrites the join preference',
      (await page.evaluate(() => localStorage.getItem('paracord:glass:join-muted'))) === null
        || JSON.parse(await page.evaluate(() => localStorage.getItem('paracord:glass:join-muted'))).state.joinMuted === true);
    await shoot(page, '05-joined-unmuted');

    // ── 6. Leave ───────────────────────────────────────────────────────────────
    await press('Leave Lounge');
    const left = await until(page, () => {
      const s = window.__voice.useVoiceStore.getState();
      return !s.callId && !s.connected ? { mode: s.callMode } : false;
    }, null, 30_000).catch(() => null);
    check('Leave leaves the call', !!left && left.mode === null, JSON.stringify(left));
    await pill.getByRole('button', { name: 'Join Lounge' }).waitFor({ state: 'visible', timeout: 15_000 });
    check('the pill goes back to Listen, Watch, the mute preference and Join',
      await pill.getByRole('button', { name: 'Listen in to Lounge' }).isVisible());
    const lukeSeesGone = await until(luke.page, (sean) => ![...window.__voice.useVoiceStore.getState().channelParticipants.values()].flat()
      .some((s) => s.user_id === sean), ids.sean, 15_000).catch(() => false);
    check('others no longer see Sean in the Lounge', !!lukeSeesGone);

    // ── 7. Join without listening first ──────────────────────────────────────
    log('join: Sean presses Join cold');
    await page.evaluate(() => { window.__probe.getUserMedia = 0; });
    await press('Join Lounge');
    const cold = await until(page, () => {
      const s = window.__voice.useVoiceStore.getState();
      return s.connected && s.callMode === 'joined' ? { muted: s.selfMute, getUserMedia: window.__probe.getUserMedia } : false;
    }, null, 60_000).catch(() => null);
    check('a cold Join joins muted by default', !!cold && cold.muted === true, JSON.stringify(cold));
    await shoot(page, '06-joined-cold');
    await press('Leave Lounge');
    await until(page, () => !window.__voice.useVoiceStore.getState().callId, null, 30_000).catch(() => null);
    await pill.getByRole('button', { name: 'Join Lounge' }).waitFor({ state: 'visible', timeout: 15_000 });

    // Not this package's to fix, but the pill shows it, so say so: after a leave
    // and a cold join the engine's participant events can replace the other
    // people's voice states with nameless placeholders (voiceStore.ts, the
    // onParticipantJoin handler, when `participants` was emptied by the leave).
    const nameless = await page.evaluate((channelId) =>
      (window.__voice.useVoiceStore.getState().channelParticipants.get(channelId) ?? [])
        .filter((state) => !state.display_name && !state.username).length, lounge);
    log(`  NOTE  after a leave and a cold join, ${nameless} of the Lounge's voice states are nameless placeholders (the pill then reads "Unknown user" and loses Watch)`);

    check('no page errors in Sean’s client', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    // Leave the instance as found: listening in on.
    await api.request(tokens.brendan, 'PATCH', `/channels/${lounge}/features`, { listen_in_enabled: true }).catch(() => {});
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  for (const r of failed) log(`  FAILED: ${r.name}: ${r.detail ?? ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
