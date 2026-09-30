#!/usr/bin/env node
// Stand up the Glass reference scene on a real Paracord instance and hold it.
//
// Seven accounts (Sean is the viewer), three servers with icons and a banner,
// the reference conversations (an image, a reply, mentions of Sean, reactions,
// a poll), three events, and a live Lounge call: Vincent sharing a slowly moving
// warm/teal canvas scene, Brendan on camera and talking, Nick muted — each in
// their own Chromium, joined through the app's own controls. Real frames, real
// relay, so room light, watching and clips can be checked on the real thing.
//
//   cd client && npm run build
//   touch crates/paracord-server/src/embedded_ui.rs
//   cargo build --release --bin paracord-server
//   node scripts/live-env.mjs                          # instance on :18420
//   node client/scripts/glass-scene.mjs                # seed + call, hold (status every 30s)
//   node client/scripts/glass-scene.mjs --shot all     # seed + call, shoot Sean's view, exit
//
// While one process holds the call, another can shoot against it (a second
// process finds the live call and leaves it be):
//   node client/scripts/glass-scene.mjs --shot 01-conversation
//
// States live in glass-scene/shots.mjs; adding one is one small object there.
// A holder prints its pid; `kill -USR2 <pid>` makes the cast rejoin in fresh
// browsers (currently refused by the product, see docs/design/glass-g3-checkpoint.md).
//
// Options
//   --base <url>        instance (default http://127.0.0.1:$PARACORD_LIVE_PORT or :18420)
//   --shot <names|all>  capture Sean's view (comma-separated state names; see glass-scene/shots.mjs)
//   --hold              keep the scene up after the shots, printing status every 30s
//                       (the default when no --shot is given)
//   --no-call           never start the call (another glass-scene process holds it)
//   --reseed            delete the scene's servers and build them again
//   --seed-only         find or build the scene, print it, exit
//   --tag <suffix>      account suffix (sean<suffix>…) when the plain names are taken
//   --no-typing         do not keep Eric typing in General
//   --headed            show the browsers
//   --out <dir>         where shots go (default output/design-reference/glass-build/live)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi, holdRealtime } from './glass-scene/api.mjs';
import { createRenderer } from './glass-scene/assets.mjs';
import { callAlreadyHeld, mediaProbe, readRoom, startCall } from './glass-scene/call.mjs';
import { AROUND, CALL, TYPING } from './glass-scene/scene.mjs';
import { deleteScene, findScene, resetUnread, seedScene, signInCast } from './glass-scene/seed.mjs';
import { resolveStates } from './glass-scene/shots.mjs';
import { channelPath, dismissOverlays, freshFrame, launchBrowser, openAs } from './glass-scene/ui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}
if (flag('help') || flag('h')) {
  console.log(`see the header of ${fileURLToPath(import.meta.url)}`);
  process.exit(0);
}
const BASE = option('base', `http://127.0.0.1:${process.env.PARACORD_LIVE_PORT ?? '18420'}`).replace(/\/+$/, '');
const SHOT = option('shot', null);
const HOLD = flag('hold') || (!SHOT && !flag('seed-only'));
const NO_CALL = flag('no-call') || flag('seed-only');
const RESEED = flag('reseed');
const TAG = option('tag', '');
const HEADLESS = !flag('headed');
const TYPING_ON = !flag('no-typing');
const OUT = resolve(option('out', join(repoRoot, 'output', 'design-reference', 'glass-build', 'live')));

const log = (...parts) => console.log(...parts);
const clock = () => new Date().toLocaleTimeString('en-US', { hour12: false });

// ------------------------------------------------------------- lifecycle
const cleanups = [];
let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* best effort on the way out */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => { log('\nleaving the call and closing the browsers…'); shutdown(130); });
process.on('SIGTERM', () => shutdown(143));

// ------------------------------------------------------------------- main
async function main() {
  const api = createApi(BASE);
  log(`\nGlass scene → ${BASE}`);
  if (!await api.health()) {
    throw new Error(`no instance answering at ${BASE}. Start one: node scripts/live-env.mjs`);
  }

  const browser = await launchBrowser({ headless: HEADLESS });
  cleanups.push(() => browser.close());
  const renderer = await createRenderer(browser);

  log('\nCast');
  const people = await signInCast(api, { tag: TAG, renderer, known: previousAccounts(), log });

  let { complete, found, ids } = await findScene(api, people);
  if (complete && !RESEED) {
    log('\nScene found on the instance; reusing it (--reseed to rebuild)');
  } else {
    if (found.length) {
      log(`\n${complete ? 'Rebuilding' : 'Found a partial scene; rebuilding'}`);
      await deleteScene(api, people, found, log);
    }
    ids = await seedScene(api, people, renderer, { log });
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'scene.json'), JSON.stringify({
    base: BASE,
    written: new Date().toISOString(),
    accounts: Object.fromEntries(Object.entries(people).map(([key, p]) => [key, { name: p.name, id: p.id, username: p.username, email: p.email, password: p.password }])),
    servers: ids.servers,
  }, null, 2));
  log(`\nScene ids and sign-ins: ${join(OUT, 'scene.json')}`);
  if (flag('seed-only')) return shutdown(0);

  // Jeremy, Luke and Eric are around: a realtime stream each. Jeremy's also
  // tells us what the server says about everyone's voice state.
  const voice = new Map();
  const online = new Set();
  for (const key of AROUND) {
    const person = people[key];
    const stream = holdRealtime(api, person.token, {
      onState: state => { if (state === 'open') online.add(key); else online.delete(key); },
      onEvent: key !== 'jeremy' ? undefined : (name, d) => {
        if (name === 'READY') {
          voice.clear();
          for (const guild of d?.guilds ?? []) for (const vs of guild.voice_states ?? []) voice.set(String(vs.user_id), vs);
        } else if (name === 'VOICE_STATE_UPDATE' && d?.user_id) {
          if (!d.channel_id) voice.delete(String(d.user_id));
          else voice.set(String(d.user_id), { ...voice.get(String(d.user_id)), ...d });
        }
      },
    });
    cleanups.push(() => stream.close());
  }

  // Give the streams a moment to attach so the first status line is true.
  for (const deadline = Date.now() + 10_000; online.size < AROUND.length && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  // Eric keeps typing in General.
  if (TYPING_ON) {
    const channelId = ids.servers[TYPING.server].channels[TYPING.channel];
    const type = () => api.request(people[TYPING.who].token, 'POST', `/channels/${channelId}/typing`, {}).catch(() => {});
    await type();
    const timer = setInterval(type, 8000);
    cleanups.push(() => clearInterval(timer));
  }

  let call = null;
  if (!NO_CALL) {
    if (await callAlreadyHeld(api, people, ids)) {
      log('\nLounge call is already held by another process; leaving it be');
    } else {
      call = await startCall({ api, base: BASE, people, ids, headless: HEADLESS, log });
      cleanups.push(() => call.close());
    }
  }

  const status = createStatus({ api, people, ids, voice, online, call });
  log(`\n${await status.line()}`);

  if (SHOT) {
    const results = await shoot({ api, browser, people, ids, renderer });
    const failed = results.filter(r => r.status === 'failed');
    if (!HOLD) return shutdown(failed.length ? 1 : 0);
  }

  log(`\nHolding the scene (pid ${process.pid}). Ctrl-C to leave the call and close everything; ` +
    `kill -USR2 ${process.pid} to have the call rejoin in fresh browsers.`);
  let recycling = false;
  process.on('SIGUSR2', async () => {
    if (!call || recycling) return;
    recycling = true;
    log(`[${clock()}] rejoining the call in fresh browsers`);
    try { await call.recycle(); log(`[${clock()}] call rejoined`); } catch (error) { log(`[${clock()}] rejoin failed: ${error.message}`); }
    recycling = false;
  });
  let absent = new Map();
  const timer = setInterval(async () => {
    try {
      log(await status.line());
      // Someone the relay has lost twice running is brought back.
      if (call) {
        const room = await readRoom(api, people.jeremy.token, call.channelId);
        const connected = new Set((room.participants ?? []).map(p => String(p.user_id)));
        const next = new Map();
        for (const m of call.members) {
          if (!connected.has(m.person.id)) next.set(m.person.id, (absent.get(m.person.id) ?? 0) + 1);
        }
        absent = next;
        if ([...absent.values()].some(n => n >= 2)) {
          await call.heal(connected);
          absent = new Map();
        }
      }
    } catch (error) {
      log(`[${clock()}] status failed: ${error.message}`);
    }
  }, 30_000);
  cleanups.push(() => clearInterval(timer));
}

/** The accounts the last run on this instance wrote down, if any. */
function previousAccounts() {
  try {
    const previous = JSON.parse(readFileSync(join(OUT, 'scene.json'), 'utf8'));
    if (previous.base !== BASE) return null;
    const sean = previous.accounts?.sean;
    return sean && sean.username === `sean${TAG}` ? previous.accounts : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ status
function createStatus({ api, people, ids, voice, online, call }) {
  const channelId = ids.servers[CALL.server].channels[CALL.channel];
  const nameOf = id => Object.values(people).find(p => p.id === String(id))?.name ?? String(id);
  let last = new Map();
  let lastAt = Date.now();
  return {
    async line() {
      const room = await readRoom(api, people.jeremy.token, channelId);
      const now = Date.now();
      const seconds = Math.max(1, (now - lastAt) / 1000);
      const parts = [];
      for (const p of room.participants ?? []) {
        const id = String(p.user_id);
        const vs = voice.get(id) ?? {};
        const video = (p.video_datagrams_received ?? 0);
        const rate = last.has(id) ? Math.round((video - last.get(id)) / seconds) : null;
        const member = call?.members.find(m => m.person.id === id);
        const probe = member ? await mediaProbe(member) : null;
        const tags = [];
        if (vs.self_stream) tags.push('streaming');
        if (vs.self_video) tags.push('camera');
        if (vs.self_mute) tags.push('muted');
        if (probe?.voiceLevel > 0.05) tags.push('talking');
        if (rate !== null && video > 0) tags.push(`${rate} video pkt/s`);
        parts.push(`${nameOf(id)}${tags.length ? ` (${tags.join(', ')})` : ''}`);
        last.set(id, video);
      }
      lastAt = now;
      const streaming = [...voice.values()].some(vs => vs.self_stream && String(vs.channel_id) === channelId);
      return `[${clock()}] Lounge: ${parts.length ? parts.join(', ') : 'empty'} · relay ${room.connected_participants} connected · ` +
        `streaming ${streaming ? 'yes' : 'no'} · around: ${[...online].map(k => people[k].name).join(', ') || 'nobody'}`;
    },
  };
}

// ------------------------------------------------------------------- shots
async function shoot({ api, browser, people, ids, renderer }) {
  const states = resolveStates(SHOT);
  mkdirSync(OUT, { recursive: true });
  log(`\nShots → ${OUT}`);
  // Sean's microphone is a quiet synthetic one, so joining a call (04) does not
  // put Chromium's test beep into the room.
  const sean = await openAs(browser, BASE, people.sean, { log, media: { voice: 'quiet' } });
  cleanups.push(() => sean.context.close());
  const { page } = sean;
  const go = async (serverKey, channelKey) => {
    await page.goto(channelPath(ids, serverKey, channelKey));
    await dismissOverlays(page, 700, 6000);
  };
  const results = [];
  for (const state of states) {
    if (state.pending) {
      log(`  ${state.name.padEnd(17)} pending — ${state.pending}`);
      results.push({ name: state.name, status: 'pending' });
      continue;
    }
    try {
      if (state.unread) {
        // Off every conversation first, so reposted messages arrive unread.
        await page.goto('/app/friends');
        await resetUnread(api, people, ids, renderer, { log: line => log(`  ${' '.repeat(17)} ${line.trim()}`) });
      }
      await page.setViewportSize(state.viewport);
      const outcome = await state.run({ page, go, ids, people, api, session: sean, log });
      const path = join(OUT, `${state.name}.png`);
      if (outcome?.png) {
        writeFileSync(path, outcome.png);
      } else {
        const lag = await freshFrame(page);
        if (lag > 1000) log(`  ${' '.repeat(17)} (waited ${lag}ms for a fresh frame)`);
        await page.screenshot({ path });
      }
      rmSync(join(OUT, `${state.name}--failed.png`), { force: true });
      results.push({ name: state.name, status: 'ok', path });
      log(`  ${state.name.padEnd(17)} ${path}`);
    } catch (error) {
      const path = join(OUT, `${state.name}--failed.png`);
      await page.screenshot({ path }).catch(() => {});
      results.push({ name: state.name, status: 'failed', error: error.message });
      log(`  ${state.name.padEnd(17)} FAILED: ${error.message.split('\n')[0]}  (${path})`);
    } finally {
      if (state.after) await state.after({ page, api, people, ids }).catch(() => {});
    }
  }
  writeFileSync(join(OUT, 'shots.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  return results;
}

main().catch(async error => {
  console.error(`\nglass-scene: ${error.stack ?? error.message}`);
  await shutdown(1);
});
