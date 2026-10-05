#!/usr/bin/env node
// Stand the Index reference scene up on a real Paracord instance, hold it, and
// shoot the viewer's view of it.
//
// The scene (index-scene/scene.mjs) is the prototype's evening: you, Jeremy,
// Vincent, Brendan, Nick and Maya; Fuel (new, empty), Game Night (12 members,
// Lounge live with Vincent streaming) and Basecamp; three DMs; no icons and no
// avatars, so the monograms show. Real accounts, real channels and messages,
// real end-to-end encrypted DMs, and real calls: Vincent (sharing a canvas
// scene and talking), Brendan and Nick (muted) each hold Game Night's Lounge in
// their own Chromium, joined through the app's own controls, with the Glass
// scene's fake media (scene-lib/media-init.mjs).
//
//   node scripts/live-env.mjs                          # an instance, :18420
//   node client/scripts/index-scene.mjs                # seed, bring Lounge up, hold
//
// While a process holds the scene, another drives it:
//
//   node client/scripts/index-scene.mjs --step arrive  # Jeremy joins Fuel, talks, joins General
//   node client/scripts/index-scene.mjs --step join    # you join General
//   node client/scripts/index-scene.mjs --step busy    # five in General, the channel moves
//   node client/scripts/index-scene.mjs --step reset   # back to the quiet start
//   node client/scripts/index-scene.mjs --shot s1-someone-arrives
//
// Or in one process, which sets up, does it, and tears everything down:
//
//   node client/scripts/index-scene.mjs --shot all     # every state of output/design-reference/index/ref
//
// A shot names the story position it needs (index-scene/shots.mjs) and gets
// there: it steps forward, or resets first when the scene is already past it.
// The states are the reference renders: s0-quiet, s0-plan-a-night,
// s0-message-box-open, s1-someone-arrives, s2-joined, s3-call-open,
// s4-other-server, s5-busy, s5-busy-title-folded, s6-people.
//
// Options
//   --base <url>        the instance (default http://127.0.0.1:$PARACORD_LIVE_PORT or :18420)
//   --ui <url>          where the browsers load the app from (default: the instance's own
//                       embedded UI). Point it at a dev server to drive the working tree:
//                         VITE_DEV_PROXY_TARGET=<base> VITE_DEV_HMR=false npx vite --port <p>
//                       The one-time encryption setup of the DMs always uses the instance's
//                       own origin (the identity challenge is bound to it).
//   --step <names>      arrive | join | busy | reset (comma list, run in order)
//   --shot <names|all>  shoot the viewer's view of these states
//   --viewport <WxH>    size of the viewer's window for shots (default 1280x800, the reference's)
//   --out <dir>         where shots, scene.json, shots.json and the viewer's browser profile
//                       (viewer-profile/: your encryption identity, which only that browser
//                       can use) go; default output/design-reference/index-build/live.
//                       Deleting the instance's data means deleting this folder too.
//   --hold              keep the scene up and take commands (the default with no --step/--shot)
//   --status            print what a holder is doing and exit
//   --check             check the scene's own data for consistency (offline) and exit
//   --seed-only         find or build the scene, print it, exit
//   --reseed            delete the three servers and build them again
//   --lenient           a missing Index test id is listed on the shot instead of failing it (a build
//                       that is half Glass and half Index while the packages land)
//   --no-lounge         do not bring Game Night's Lounge up (a build whose sidebar has no room card yet
//                       cannot be joined through; shots of the places themselves still work)
//   --no-dms            skip the Direct messages (the one slow part of a first seed, ~2 min)
//   --existing          the accounts already exist on this instance: sign in before registering
//                       (a refused register counts against the instance's auth guard, five
//                       lock it out for a minute; scene.json normally tells the driver)
//   --tag <suffix>      account suffix (sean<suffix>, ...) when the plain names are taken
//   --headed            show the browsers
//
// A holder prints its pid; Ctrl-C (or SIGTERM) makes everyone leave and closes
// every browser. Nothing is left running on the instance's rooms.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi } from './scene-lib/api.mjs';
import { createRenderer } from './scene-lib/assets.mjs';
import { launchBrowser } from './scene-lib/ui.mjs';
import { Cast } from './index-scene/cast.mjs';
import { checkScene } from './index-scene/check.mjs';
import { controlFile, findHolder, sendCommand, serveControl } from './index-scene/control.mjs';
import { dmsComplete, readAllDms, seedDirectMessages } from './index-scene/dms.mjs';
import { deleteScene, ensureFuelHandles, findScene, seedScene, signInPeople } from './index-scene/seed.mjs';
import { resolveStates, shoot } from './index-scene/shots.mjs';
import { Story } from './index-scene/story.mjs';
import { Viewer } from './index-scene/viewer.mjs';

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
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}

const BASE = option('base', `http://127.0.0.1:${process.env.PARACORD_LIVE_PORT ?? '18420'}`).replace(/\/+$/, '');
const UI = option('ui', BASE).replace(/\/+$/, '');
const STEP = option('step', null);
const SHOT = option('shot', null);
const OUT = resolve(option('out', join(repoRoot, 'output', 'design-reference', 'index-build', 'live')));
const TAG = option('tag', '');
/** Sean's browser profile: his encryption identity lives in it (ui.mjs `openPersistentSession`). */
const PROFILE = join(OUT, 'viewer-profile');
const HEADLESS = !flag('headed');
const [VW, VH] = option('viewport', '1280x800').split('x').map(Number);
if (!VW || !VH) throw new Error('--viewport wants WIDTHxHEIGHT, e.g. 1280x800');
const HOLD = flag('hold') || (!STEP && !SHOT && !flag('seed-only') && !flag('status') && !flag('check'));

// --------------------------------------------------------------------- log
let sink = null;
const log = (...parts) => {
  const line = parts.join(' ');
  console.log(line);
  sink?.(line);
};
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
process.on('SIGINT', () => { log('\nleaving the calls and closing the browsers…'); shutdown(130); });
process.on('SIGTERM', () => shutdown(143));

// ------------------------------------------------------------ the scene
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

/** Accounts, servers, channels, messages and DMs: found on the instance, or built. */
async function prepare(api) {
  log('\nCast');
  const people = await signInPeople(api, { tag: TAG, known: previousAccounts() ?? (flag('existing') ? { sean: true } : null), log });
  // A new Sean is a new person: the old profile holds somebody else's identity.
  if (people.sean.created) rmSync(PROFILE, { recursive: true, force: true });
  // Written at once, so a run that dies half way still tells the next one the
  // accounts exist (a refused register counts against the instance's auth guard).
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'scene.json'), JSON.stringify({
    base: BASE,
    accounts: Object.fromEntries(Object.entries(people).map(([key, p]) => [key, { name: p.name, id: p.id, username: p.username, email: p.email, password: p.password }])),
  }, null, 2));

  let { complete, found, ids } = await findScene(api, people);
  if (complete && !flag('reseed')) {
    log('\nScene found on the instance; reusing it (--reseed to rebuild)');
  } else {
    if (found.length) {
      log(`\n${complete ? 'Rebuilding' : 'Found a partial scene; rebuilding'}`);
      await deleteScene(api, people, found, log);
    }
    const browser = await launchBrowser({ headless: true });
    try {
      ids = await seedScene(api, people, await createRenderer(browser), { log });
    } finally {
      await browser.close().catch(() => {});
    }
  }

  await ensureFuelHandles(api, people, ids);

  let dms = {};
  if (!flag('no-dms')) {
    const state = await dmsComplete(api, people);
    dms = state.complete ? state.dms : await seedDirectMessages({ api, uiBase: BASE, people, profileDir: PROFILE, log, headless: HEADLESS });
    await readAllDms(api, people);
    log(`  Direct messages: ${Object.keys(dms).map(key => people[key].name).join(', ')}`);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'scene.json'), JSON.stringify({
    base: BASE,
    ui: UI,
    written: new Date().toISOString(),
    accounts: Object.fromEntries(Object.entries(people).map(([key, p]) => [key, { name: p.name, id: p.id, username: p.username, email: p.email, password: p.password }])),
    servers: ids.servers,
    dms,
  }, null, 2));
  log(`\nScene ids and sign-ins: ${join(OUT, 'scene.json')}`);
  return { people, ids, dms };
}

// -------------------------------------------------------------------- shots
function recordShots(results) {
  const file = join(OUT, 'shots.json');
  let existing = {};
  try { existing = JSON.parse(readFileSync(file, 'utf8')).results ?? {}; } catch { /* first run */ }
  for (const result of results) existing[result.name] = { ...result, at_time: new Date().toISOString() };
  writeFileSync(file, JSON.stringify({ base: BASE, ui: UI, viewport: `${VW}x${VH}`, results: existing }, null, 2));
}

async function runShots({ story, viewer, ctx }, names, viewport) {
  const results = [];
  mkdirSync(OUT, { recursive: true });
  log(`\nShots → ${OUT}  (${viewport.width}x${viewport.height})`);
  for (const name of names) {
    const result = await story.run(() => shoot(ctx, name, { out: OUT, writeFile: writeFileSync, join, viewport }));
    results.push(result);
    if (result.stage === 'scene') {
      // A step that fails half way leaves the scene somewhere in between; going
      // on would shoot states of a scene nobody can describe.
      log(`  the scene could not reach "${result.at}"; stopping here (--step reset puts it back)`);
      break;
    }
  }
  recordShots(results);
  return results;
}

// --------------------------------------------------------------------- main
async function main() {
  if (flag('check')) {
    const problems = checkScene({ repoRoot });
    for (const problem of problems) console.error(`  ${problem}`);
    console.log(problems.length ? `scene data: ${problems.length} problem(s)` : 'scene data: consistent');
    return process.exit(problems.length ? 1 : 0);
  }
  // A second invocation drives the process that holds the scene.
  const holder = (STEP || SHOT || flag('status')) && !HOLD ? findHolder(OUT) : null;
  if (holder) {
    log(`\nindex-scene → holder pid ${holder.pid} (${holder.base})`);
    let failed = false;
    if (flag('status')) {
      const result = await sendCommand(holder, 'status', {});
      log(result.line);
      return process.exit(0);
    }
    for (const step of STEP ? STEP.split(',') : []) {
      const result = await sendCommand(holder, 'step', { name: step.trim() });
      if (!result.ok) { log(`step ${step} FAILED: ${result.error}`); failed = true; break; }
      log(`step ${step}: ${result.summary}`);
    }
    if (SHOT && !failed) {
      const result = await sendCommand(holder, 'shot', { states: SHOT, viewport: { width: VW, height: VH } });
      if (!result.ok || result.results?.some(r => r.status === 'failed')) failed = true;
    }
    return process.exit(failed ? 1 : 0);
  }
  if (flag('status')) throw new Error(`no holder is running for ${OUT} (start one: node client/scripts/index-scene.mjs)`);

  // Names are checked before anything is started.
  const wanted = SHOT ? resolveStates(SHOT) : null;
  const running = HOLD ? findHolder(OUT) : null;
  if (running) throw new Error(`a holder is already running for ${OUT} (pid ${running.pid}); drive it with --step / --shot / --status, or stop it first`);

  const api = createApi(BASE);
  log(`\nIndex scene → ${BASE}${UI !== BASE ? `  (app from ${UI})` : ''}`);
  if (!await api.health()) throw new Error(`no instance answering at ${BASE}. Start one: node scripts/live-env.mjs`);
  if (UI !== BASE) {
    const ui = await fetch(`${UI}/`).then(r => r.ok).catch(() => false);
    if (!ui) throw new Error(`nothing is serving the app at ${UI} (--ui)`);
  }

  const { people, ids, dms } = await prepare(api);
  if (flag('seed-only')) return shutdown(0);

  const cast = new Cast({ api, uiBase: UI, ids, people, headless: HEADLESS, log });
  const viewer = new Viewer({ uiBase: UI, ids, person: people.sean, dmId: dms.jeremy ?? null, profileDir: PROFILE, headless: HEADLESS, log, viewport: { width: VW, height: VH } });
  cleanups.push(() => viewer.close());
  cleanups.push(() => cast.stopAll());
  const story = new Story({ api, people, ids, cast, viewer, lounge: !flag('no-lounge'), log });
  await story.start();
  const ctx = { story, viewer, get page() { return viewer.page; }, ids, people, dms, api, log, lenient: flag('lenient'), missing: [] };
  log(`\n${await story.status()}`);

  let failed = false;
  for (const step of STEP ? STEP.split(',') : []) {
    try {
      log(`step ${step.trim()}: ${await story.run(() => story.step(step.trim()))}`);
    } catch (error) {
      log(`step ${step} FAILED: ${error.message}`);
      failed = true;
      break;
    }
  }
  if (SHOT && !failed) {
    const results = await runShots({ story, viewer, ctx }, wanted, { width: VW, height: VH });
    failed = results.some(r => r.status === 'failed');
  }
  if (!HOLD) return shutdown(failed ? 1 : 0);
  if (STEP && !SHOT) log('\n(--step on its own with --hold: the scene stays up)');

  // Hold, and take commands.
  const control = await serveControl({
    out: OUT,
    base: BASE,
    handlers: {
      async step({ name }, say) {
        sink = say;
        try { return { ok: true, summary: await story.run(() => story.step(name)) }; } finally { sink = null; }
      },
      async shot({ states, viewport }, say) {
        sink = say;
        try {
          const results = await runShots({ story, viewer, ctx }, resolveStates(states), viewport ?? { width: VW, height: VH });
          return { ok: true, results };
        } finally { sink = null; }
      },
      async status() { return { ok: true, line: await story.run(() => story.status()) }; },
    },
  });
  cleanups.push(() => control.close());
  log(`\nHolding the scene (pid ${process.pid}, control on 127.0.0.1:${control.port}, ${controlFile(OUT)}).`);
  log('Drive it:  --step arrive | join | busy | reset   --shot <state>   --status.  Ctrl-C leaves the calls and closes everything.');

  let absent = 0;
  const timer = setInterval(async () => {
    try {
      const line = await story.run(() => story.status());
      log(`[${clock()}] ${line}`);
      // Someone the relay has lost twice running is brought back.
      const missing = [];
      for (const member of cast.members.values()) {
        if (member.room && !(await cast.occupants(member.room.server, member.room.room)).has(member.person.id)) missing.push(member.key);
      }
      absent = missing.length ? absent + 1 : 0;
      if (absent >= 2) {
        absent = 0;
        await story.run(() => cast.heal());
      }
    } catch (error) {
      log(`[${clock()}] status failed: ${error.message}`);
    }
  }, 30_000);
  cleanups.push(() => clearInterval(timer));
}

main().catch(async error => {
  console.error(`\nindex-scene: ${error.stack ?? error.message}`);
  await shutdown(1);
});
