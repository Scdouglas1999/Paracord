#!/usr/bin/env node
// The fresh-machine gate (setup-plan §5.4, package S15).
//
// From nothing: a person hosts a server from the desktop app on a "computer"
// behind a home router, a friend outside the router joins from a second
// desktop app, they exchange an encrypted DM, and everything survives an app
// relaunch and a sign-out/sign-in of the host's computer session. Then: a
// second device for the friend, a server certificate change, a restore on a
// new computer, a router that refuses and later allows, and carrier-grade NAT.
//
//   node client/e2e/fresh-machine/run.mjs --bin <dir> [--shots <dir>] [--out <dir>] [--keep] [--no-build-images]
//
// <dir> holds paracord-desktop, paracord-host and tauri-driver
// (scripts/fresh-machine/build.sh makes it). Every container, network and
// volume is labeled paracord-fresh=1 and removed at the end unless --keep.
// Exit status is non-zero when any check fails.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as L from './lab.mjs';
import { Session, sleep, until } from './wd.mjs';
import { Ui } from './ui.mjs';

const { values: args } = parseArgs({
  options: {
    bin: { type: 'string' },
    shots: { type: 'string' },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'no-build-images': { type: 'boolean', default: false },
  },
});
if (!args.bin) {
  console.error('usage: run.mjs --bin <dir with paracord-desktop, paracord-host, tauri-driver> [--shots dir] [--out dir] [--keep]');
  process.exit(2);
}
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = args.out ?? `/tmp/paracord-fresh/${RUN}`;
const SHOTS = args.shots ?? join(OUT, 'shots');
mkdirSync(OUT, { recursive: true });
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const APP = '/opt/paracord/paracord-desktop';
const HOST_ROOT = '/home/sam/.local/share/com.paracord.desktop/host';
const T0 = Date.now();
const stamp = Date.now().toString(36).slice(-5);

// People and computers.
const SAM = { display: 'Sam', username: 'sam', password: 'correct horse battery staple 42' };
const ALEX = { display: 'Alex', username: 'alex', password: 'maple river lantern 7 quiet' };
const RILEY = { display: 'Riley', username: 'riley', password: 'quartz meadow 51 sailboat' };
const JO = { display: 'Jo', username: 'jo', password: 'orchid tram velvet 93 lake' };
const KIM = { display: 'Kim', username: 'kim', password: 'harbor ginger 6 pocket lamp' };
const SERVER = 'Friday Night Crew';
const PUBLIC_IP = '203.0.113.1';

const results = { run: RUN, started: new Date().toISOString(), scenarios: [], findings: [], dialogs: [] };
let current = null;

function log(...a) {
  console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
}

function scenario(id, title) {
  current = { id, title, checks: [], shots: [] };
  results.scenarios.push(current);
  log(`\n=== ${id}: ${title}`);
}

function check(name, ok, detail = '') {
  current.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 2000) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  return !!ok;
}

async function attempt(name, fn) {
  try {
    const r = await fn();
    return check(name, r !== false, typeof r === 'string' ? r : '');
  } catch (e) {
    return check(name, false, e.message);
  }
}

function save() {
  results.finished = new Date().toISOString();
  results.seconds = Math.round((Date.now() - T0) / 1000);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
}

// ── Computers ────────────────────────────────────────────────────────────

const computers = new Map();

function computer({ name, hostname, net, ip, router }) {
  L.startComputer({ name, hostname, network: net, ip, router, binDir: args.bin });
  const c = { name, ip, net, session: null, ui: null, dialogsSeen: 0 };
  computers.set(name, c);
  watchDialogs(c);
  return c;
}

/**
 * The native "Trust new Paracord instance?" dialog. A person at this
 * computer accepts it (it is about their own server or one they chose), so
 * the watcher clicks "Trust instance" — and records every time it appeared,
 * because on the host's own loopback server it should not appear at all.
 */
function watchDialogs(c) {
  c.watch = setInterval(async () => {
    if (c.busy) return;
    c.busy = true;
    try {
      const out = await L.execQuiet(c.name, ['pc', 'windows']);
      for (const line of out.split('\n')) {
        const [, x, y, w, h, title] = line.split('\t');
        if (title !== 'Trust new Paracord instance?') continue;
        c.dialogsSeen += 1;
        const file = join(SHOTS, `dialog-${c.name}-${c.dialogsSeen}.png`);
        try { L.shotX(c.name, file); } catch { /* best effort */ }
        results.dialogs.push({ computer: c.name, scenario: current?.id, at: new Date().toISOString(), shot: file });
        log(`  ${c.name}: native "Trust new Paracord instance?" dialog — accepting it as the person would`);
        const cx = Number(x) + Math.round(Number(w) / 4);
        const cy = Number(y) + Number(h) - 18;
        await L.execQuiet(c.name, ['pc', 'click-at', String(cx), String(cy)]);
      }
    } finally {
      c.busy = false;
    }
  }, 700);
}

async function launch(c, label, appArgs = []) {
  // Right after a sign-in the driver may still be coming up: try a few times.
  for (let i = 0; ; i++) {
    try {
      c.session = await Session.start(L.driverUrl(c.ip), { application: APP, args: appArgs, label });
      break;
    } catch (e) {
      if (i >= 4) throw e;
      log(`  ${c.name}: starting the app failed (${e.message}); retrying`);
      await sleep(3000);
    }
  }
  c.ui = new Ui(c.session, { container: c.name, shotsDir: SHOTS, prefix: label });
  return c.ui;
}

async function quit(c) {
  if (c.session) await c.session.end();
  c.session = null;
  c.ui = null;
  // tauri-driver ends the app with the session; make sure nothing is left.
  await until(async () => !(await L.execQuiet(c.name, ['pgrep', '-x', 'paracord-deskto'])).trim(), `${c.name}: the app did not quit`, 15000);
}

async function shot(c, name) {
  const file = await c.ui.shot(name);
  current.shots.push(file);
  return file;
}

function shotScreen(c, name) {
  const file = c.ui ? c.ui.shotScreen(name) : join(SHOTS, `${String(++Ui.counter).padStart(3, '0')}-${c.name}-${name}.png`);
  if (!c.ui) L.shotX(c.name, file);
  current.shots.push(file);
  return file;
}

// ── In-container facts ──────────────────────────────────────────────────

const pc = (c, ...cmd) => L.exec(c.name, ['pc', ...cmd], { allowFail: true });

function hostJson(c) {
  return JSON.parse(L.exec(c.name, ['cat', '/home/sam/.local/share/com.paracord.desktop/host.json']).out);
}

function health(fromComputer, url) {
  const r = L.exec(fromComputer.name, ['curl', '-sk', '-m', '5', `${url}/health`], { allowFail: true });
  return r.status === 0 && r.out.includes('"paracord"');
}

/** Trust words of the certificate the host serves, computed here from the PEM (spec §7.1). */
function hostTrustWords(c) {
  const pem = L.exec(c.name, ['sh', '-c', `cat "$(dirname "$(pc db-path)")"/certs/cert.pem 2>/dev/null || cat ${HOST_ROOT}/data/certs/cert.pem`]).out;
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const fp = createHash('sha256').update(der).digest();
  const h = createHash('sha256').update(Buffer.concat([Buffer.from('paracord/trust-words/v1'), fp])).digest();
  const list = readFileSync(join(L.REPO, 'crates/paracord-server/data/bip39-english.txt'), 'utf8').split('\n').map((w) => w.trim()).filter(Boolean);
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(h[i]);
  const words = [];
  for (let i = 0; i < 4; i++) words.push(list[Number((bits >> BigInt(48 - 11 * (i + 1))) & 2047n)]);
  return { words, fingerprint: fp.toString('hex') };
}

async function invoke(c, command, payload = {}) {
  const r = await c.session.execAsync(
    'const d = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => d({ ok: v })).catch((e) => d({ err: String(e) }));',
    command,
    payload,
  );
  if (r.err) throw new Error(`${command}: ${r.err}`);
  return r.ok;
}

// ── First-run steps ─────────────────────────────────────────────────────

async function setupRows(c) {
  return c.session.exec(
    "return [...document.querySelectorAll('[data-testid=fr-setup-rows] > li')].map((li) => ({ state: li.dataset.state || '?', text: li.innerText.replace(/\\s+/g, ' ').trim() }))",
  );
}

/** Wait for the setup rows to settle; returns them. Logs every change. */
async function waitRows(c, timeoutMs = 150000) {
  const start = Date.now();
  let last = '';
  for (;;) {
    const rows = await setupRows(c);
    const sig = rows.map((r) => `${r.state} ${r.text}`).join('\n');
    if (sig !== last) {
      log(`  rows @${((Date.now() - start) / 1000).toFixed(1)}s:\n    ${rows.map((r) => `${r.state.padEnd(7)} ${r.text.slice(0, 140)}`).join('\n    ')}`);
      last = sig;
    }
    const settled = rows.length > 0 && rows.every((r) => ['ok', 'warn', 'fail'].includes(r.state));
    if (settled || rows.some((r) => r.state === 'fail')) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await sleep(300);
  }
}

async function hostFirstRun(c, label, person, serverName, hueLabel) {
  const ui = await launch(c, label);
  await ui.tid('fr-choose-host', 60000);
  await sleep(2500); // the launch sequence plays out
  await shot(c, 'welcome');
  await ui.clickTid('fr-choose-host');
  await ui.heading('What should we call your server?');
  await ui.fill('fr-server-name', serverName);
  if (hueLabel) await ui.click(hueLabel);
  await sleep(500);
  await shot(c, 'name');
  await ui.click('Continue');
  await ui.heading('Make your account');
  await ui.fill('fr-display-name', person.display);
  await ui.fill('fr-password', person.password);
  await sleep(400);
  await shot(c, 'account');
  await ui.click('Continue');
  await ui.heading('Setting up your server');
  await sleep(700);
  await shot(c, 'setup-running');
  const rows = await waitRows(c);
  await sleep(600);
  await shot(c, 'setup-done');
  return rows;
}

async function retryFailedRows(c, rows, label) {
  // A failed row offers Try again; a person presses it once.
  if (!rows.some((r) => r.state === 'fail')) return rows;
  check(`${label}: no setup row fails on the first attempt`, false, rows.filter((r) => r.state === 'fail').map((r) => r.text).join(' | '));
  await c.ui.click('Try again');
  const again = await waitRows(c);
  await shot(c, 'setup-after-try-again');
  return again;
}

async function savePhrase(c) {
  const ui = c.ui;
  await ui.heading('Save your recovery phrase', 60000);
  await sleep(500);
  await shot(c, 'phrase-blurred');
  await ui.clickTid('fr-show-words');
  await sleep(500);
  await shot(c, 'phrase-revealed');
  const words = await c.session.exec(
    "return [...document.querySelectorAll('[data-testid=fr-words] li')].map((li) => li.innerText.replace(/^\\s*\\d+\\.?\\s*/, '').trim())",
  );
  await ui.clickTid('fr-phrase-saved');
  await ui.clickTid('fr-phrase-continue');
  return words;
}

async function inviteLink(c) {
  return c.session.exec("return document.querySelector('[data-testid=fr-invite-link] code')?.textContent ?? null");
}

async function joinFirstRun(c, label, person, link, { viaDeepLink = false } = {}) {
  const ui = c.ui;
  if (!viaDeepLink) {
    await ui.tid('fr-choose-join', 60000);
    await sleep(2500);
    await shot(c, 'welcome');
    await ui.clickTid('fr-choose-join');
    await ui.heading('Paste your invite');
    await ui.fill('fr-invite-field', link);
  }
  await ui.tid('fr-server-card', 45000);
  await sleep(900);
  await shot(c, 'invite-card');
  const card = await c.session.text(await ui.tid('fr-server-card'));
  const trust = await c.session.text(await ui.tid('fr-trust-words'));
  await ui.clickTid('fr-invite-continue');
  await ui.heading('Make your account');
  await ui.fill('fr-display-name', person.display);
  await ui.fill('fr-password', person.password);
  await sleep(300);
  await shot(c, 'account');
  await ui.click('Continue');
  await ui.heading('Getting you in', 30000);
  const rows = await waitRows(c, 60000);
  await shot(c, 'setup-done');
  return { card, trust, rows };
}

// ── App steps ───────────────────────────────────────────────────────────

/** Settings › This computer (spec §2.9): what the page says, read from the page. */
async function hostSettings(c, name) {
  const ui = c.ui;
  await ui.press('Escape');
  await sleep(300);
  await ui.click('Your account');
  await sleep(500);
  await ui.click('Settings', { exact: false });
  await ui.click('This computer');
  await ui.tid('host-settings', 30000);
  await until(async () => (await c.session.exists('[data-testid=host-state]', { loose: true })), `${c.name}: no host status on the page`, 30000);
  await sleep(1500);
  const read = async (id) => {
    const el = await c.session.exists(`[data-testid=${id}]`, { loose: true });
    return el ? (await c.session.exec('return arguments[0].innerText', { 'element-6066-11e4-a52e-4f735466cecf': el })).replace(/\s+/g, ' ').trim() : null;
  };
  const view = { state: await read('host-state'), reach: (await read('host-row-reach')) ?? (await read('host-reach')), words: await read('host-words'), page: (await read('host-settings')) ?? '' };
  if (name) await shot(c, name);
  return view;
}

async function closeSettings(c) {
  await c.ui.press('Escape');
  await sleep(500);
}

async function ensureApp(c, label) {
  if (!c.ui) {
    await launch(c, label);
    await sleep(6000);
  }
}

async function openDmWith(c, name) {
  // The dock's People item (its label grows ", unread"), not "People in this conversation".
  const dock = await until(() => c.session.exists("[data-testid=ix-dock-item][aria-label^='People']", { loose: true }), `${c.name}: no People dock item`, 30000);
  await c.session.click(dock);
  await sleep(1000);
  const row = await until(
    () => c.session.exists(`//*[(self::a or self::button or @role='link' or @role='button')][.//*[normalize-space(.)='${name}']]`, { using: 'xpath', loose: true }),
    `${c.name}: no conversation with ${name}`,
    30000,
  );
  await c.session.click(row);
  await sleep(1500);
}

async function say(c, text) {
  const box = await until(() => c.session.exists('textarea[data-composer-input]'), `${c.name}: no composer`, 30000);
  await c.session.click(box);
  await c.session.type(box, text);
  await c.ui.press('Enter');
  await until(async () => (await c.session.prop(box, 'value')) === '', `${c.name}: the composer did not send`, 20000);
}

async function seesText(c, text, timeoutMs = 45000) {
  await c.ui.waitText(text, timeoutMs);
  return true;
}

// ── Scenarios ───────────────────────────────────────────────────────────

const st = {}; // what later scenarios need

async function s1() {
  scenario('S1', 'Fresh host: launch → split welcome → Host → name/color → account → automatic setup → phrase → invite');
  const host = computer({ name: 'pcfm-host', hostname: 'sams-pc', net: L.NETWORKS.lan, ip: '192.168.50.28', router: '192.168.50.1' });
  st.host = host;
  check('the computer boots with sam signed in (systemd user session, keyring unlocked, null audio)',
    pc(host, 'sam', 'systemctl', '--user', 'is-active', 'pc-keyring', 'pc-audio').out.split('\n').every((l) => l === 'active'),
    pc(host, 'sam', 'pactl', 'get-default-sink').out);

  const dialogsBefore = host.dialogsSeen;
  let rows = await hostFirstRun(host, 'host', SAM, SERVER, 'Green');
  rows = await retryFailedRows(host, rows, 'host');
  check('setup rows 1–5 all succeed', rows.length === 5 && rows.every((r) => r.state === 'ok'), rows.map((r) => `${r.state}: ${r.text}`).join(' | '));
  check(`row 4 says the router opened the way at ${PUBLIC_IP}`, /Your router opened the way\. Friends can reach you at 203\.0\.113\.1/.test(rows[3]?.text ?? ''), rows[3]?.text);
  check('no native trust prompt for the host\'s own server during setup', host.dialogsSeen === dialogsBefore,
    `${host.dialogsSeen - dialogsBefore} "Trust new Paracord instance?" dialog(s) for https://127.0.0.1:8443`);

  const info = hostJson(host);
  st.instanceId = info.instance_id;
  check('host.json: enabled, every setup step recorded', info.enabled && ['install', 'init', 'service', 'start', 'storage', 'claim', 'escrow', 'reach', 'backup'].every((s) => info.setup.completed_steps.includes(s)), JSON.stringify(info.setup.completed_steps));
  check('the service is a systemd user unit and running', pc(host, 'unit-active').out === 'active' &&
    pc(host, 'sam', 'systemctl', '--user', 'is-enabled', 'paracord-host.service').out === 'enabled', pc(host, 'sam', 'systemctl', '--user', 'status', 'paracord-host', '--no-pager').out.split('\n').slice(0, 3).join(' / '));
  const header = pc(host, 'db-header').out;
  check('the database is not plain SQLite (header is not "SQLite format 3")', header && !header.startsWith('53514c69746520666f726d6174203300'), header);
  check('sqlite3 cannot open the database without the key', pc(host, 'db-open-without-key').status === 0, pc(host, 'db-open-without-key').out);
  const items = JSON.parse(pc(host, 'keychain-list').out || '[]');
  check(`the keychain holds host-storage-key:${info.instance_id}`, items.some((i) => i.username === `host-storage-key:${info.instance_id}` && i.service === 'Paracord'), JSON.stringify(items));
  check('the storage key escrow file exists', L.exec(host.name, ['test', '-s', `${HOST_ROOT}/storage-key.escrow`], { allowFail: true }).status === 0);
  const backups = L.exec(host.name, ['sh', '-c', `ls ${HOST_ROOT}/data/backups`], { allowFail: true }).out.split('\n').filter(Boolean);
  check('the first backup exists', backups.length >= 1, backups.join(', '));
  const status = await invoke(host, 'host_status');
  check('the router mapping was made over UPnP IGD', status.reachability?.state === 'open' && status.reachability?.method === 'upnp', JSON.stringify(status.reachability));
  const mappings = L.routerMappings('pcfm-router');
  check('the router holds TCP and UDP 8443 → 192.168.50.28', (mappings.match(/dport 8443 dnat ip to 192\.168\.50\.28:8443/g) ?? []).length === 2, mappings.replace(/\s+/g, ' '));
  check('backups are on', status.backups?.enabled === true && !!status.backups?.last_backup_at, JSON.stringify(status.backups));

  await host.ui.clickTid('fr-setup-continue');
  st.samPhrase = await savePhrase(host);
  check('the recovery phrase has 24 words', st.samPhrase.length === 24, st.samPhrase.length);
  await host.ui.heading('Invite your friends', 60000);
  await sleep(1200);
  await shot(host, 'invite');
  st.invite = await inviteLink(host);
  check(`the invite is https://${PUBLIC_IP}:8443/invite/<code>`, /^https:\/\/203\.0\.113\.1:8443\/invite\/[A-Za-z0-9_-]+$/.test(st.invite ?? ''), st.invite);
  st.inviteCode = st.invite?.split('/').pop();
  await host.ui.clickTid('fr-open-server');
  await host.ui.waitText('Say hi to everyone', 60000);
  await sleep(1500);
  await shot(host, 'app');
  check('Open lands in the server\'s general channel', /\/app\/guilds\/\d+\/channels\/\d+/.test(await host.ui.path()), await host.ui.path());
  st.hostWords = hostTrustWords(host);
  log(`  host trust words: ${st.hostWords.words.join(' · ')}`);

  // Settings › This computer, through the real page.
  const v = await hostSettings(host, 'settings-this-computer');
  check('Settings › This computer says Running', /Running/.test(v.state ?? ''), v.state);
  check(`Settings says the router opened the way at ${PUBLIC_IP}`, /opened the way/.test(v.reach ?? '') && (v.reach ?? '').includes(PUBLIC_IP), v.reach);
  check('Settings shows this server\'s words, the same as its certificate\'s', (v.words ?? '').toLowerCase().includes(st.hostWords.words.join(' · ')), `${v.words} | ${st.hostWords.words.join(' · ')}`);
  check('Settings names the storage as encrypted with the key in the keychain', /keychain/i.test(v.page), v.page.slice(0, 400));
  const backupsBefore = L.exec(host.name, ['sh', '-c', `ls ${HOST_ROOT}/data/backups | wc -l`]).out;
  await host.ui.clickTid('host-backup-now');
  await attempt('Back up now in Settings makes a backup', () => until(() => L.exec(host.name, ['sh', '-c', `ls ${HOST_ROOT}/data/backups | wc -l`]).out !== backupsBefore, 'no new backup', 60000).then(() => true));
  await shot(host, 'settings-after-backup');
  await closeSettings(host);
}

async function s2() {
  scenario('S2', 'A friend outside the router joins with the invite (paste, and paracord:// deep links), sees the trust words, makes an account and sends an encrypted DM');
  const host = st.host;
  const friend = computer({ name: 'pcfm-friend', hostname: 'alex-laptop', net: L.NETWORKS.wan, ip: '203.0.113.77' });
  st.friend = friend;
  check('the friend reaches the host only through the router (direct LAN address unreachable)',
    !health(friend, 'https://192.168.50.28:8443') && health(friend, `https://${PUBLIC_IP}:8443`));

  await launch(friend, 'friend');
  const joined = await joinFirstRun(friend, 'friend', ALEX, st.invite);
  check(`the invite card shows "${SERVER}" and 1 online`, joined.card.includes(SERVER) && /1 online/.test(joined.card), joined.card.replace(/\s+/g, ' '));
  const shown = joined.trust.split('·').map((w) => w.trim().toLowerCase());
  check('the card\'s four trust words are the host certificate\'s words', shown.join(' ') === st.hostWords.words.join(' '), `card: ${shown.join(' ')} | host cert: ${st.hostWords.words.join(' ')}`);
  check('join rows all succeed', joined.rows.length === 3 && joined.rows.every((r) => r.state === 'ok'), joined.rows.map((r) => `${r.state}: ${r.text}`).join(' | '));
  await friend.ui.clickTid('fr-setup-continue');
  st.alexPhrase = await savePhrase(friend);
  await friend.ui.waitText('Say hi when you', 60000).catch(() => {});
  await sleep(1500);
  await shot(friend, 'app');
  check('the friend lands in the server', /\/app\/guilds\/\d+\/channels\/\d+/.test(await friend.ui.path()), await friend.ui.path());

  // The DM, through the real UI: member list → Sam → Message.
  await friend.ui.click('Members');
  await sleep(1000);
  const samRow = await until(() => friend.session.exists("//*[normalize-space(.)='Sam' and not(*)]", { using: 'xpath', loose: true }), 'Sam is not in the member list', 30000);
  await friend.session.click(samRow);
  await sleep(1000);
  await shot(friend, 'sam-profile');
  await friend.ui.click('Message');
  await friend.ui.waitText('End-to-end encrypted', 30000);
  st.dm1 = `pineapple-otter-${stamp} hi Sam, it is Alex from outside`;
  await say(friend, st.dm1);
  await until(async () => (await friend.ui.text()).includes('Delivered'), 'the DM was never delivered', 45000);
  await shot(friend, 'dm-sent');
  st.dmPath = await friend.ui.path();
  check('the DM is delivered', true, st.dmPath);

  const rows = JSON.parse(pc(host, 'db-messages', '5').out.replace(/^ok\s*/, '') || '[]');
  const top = rows[0] ?? {};
  check('the server stores the DM as ciphertext with an E2EE header (read with the keychain key)', top.has_e2ee_header === 1 && top.content_head && !top.content_head.includes('pineapple'), JSON.stringify(top));
  check('the plaintext appears nowhere in the database files', pc(host, 'db-grep', 'pineapple-otter').out === '0');
  check('the database is unreadable without the key', pc(host, 'db-open-without-key').status === 0);

  await openDmWith(host, 'Alex');
  await attempt('Sam reads the DM on the host computer', () => seesText(host, st.dm1));
  await shot(host, 'dm-read');
  st.reply1 = `walnut-heron-${stamp} welcome Alex`;
  await say(host, st.reply1);
  await attempt('Alex reads Sam\'s reply', () => seesText(friend, st.reply1));
  await shot(friend, 'reply-read');
  const sv = await hostSettings(host, 'settings-friend-connected');
  check('Settings says a friend connected from outside', /A friend connected from outside/.test(sv.reach ?? ''), sv.reach);
  await closeSettings(host);
  await openDmWith(host, 'Alex');

  // Deep links. Cold: a new friend (Riley) who never ran Paracord clicks the
  // paracord:// link; the desktop entry the package installs starts the app.
  const portable = `paracord://invite/${Buffer.from(`https://${PUBLIC_IP}:8443|${st.inviteCode}`).toString('base64url')}`;
  st.portable = portable;
  const riley = computer({ name: 'pcfm-friend-c', hostname: 'riley-pc', net: L.NETWORKS.wan, ip: '203.0.113.79' });
  st.riley = riley;
  pc(riley, 'sam', 'sh', '-c', `setsid gio open '${portable}' >/dev/null 2>&1 &`);
  await sleep(9000);
  const coldShot = join(SHOTS, `${String(++Ui.counter).padStart(3, '0')}-riley-cold-deeplink-gio.png`);
  L.shotX(riley.name, coldShot);
  current.shots.push(coldShot);
  const coldRunning = L.exec(riley.name, ['pgrep', '-x', 'paracord-deskto'], { allowFail: true }).status === 0;
  check('a paracord:// link starts the app cold through the desktop entry (gio open)', coldRunning, coldShot);
  pc(riley, 'sam', 'pkill', '-x', 'paracord-deskto');
  await sleep(1500);
  // The same cold start under the driver (the app gets the link as argv, as
  // the desktop entry's %u gives it), so the rest can be driven.
  await launch(riley, 'riley', [portable]);
  await attempt('a cold paracord:// link opens the first run on Join with the invite checked', async () => {
    await riley.ui.tid('fr-server-card', 60000);
    return true;
  });
  const rj = await joinFirstRun(riley, 'riley', RILEY, null, { viaDeepLink: true }).catch((e) => ({ error: e }));
  check('Riley joins from the deep link', !rj.error && rj.rows.every((r) => r.state === 'ok'), rj.error?.message ?? rj.rows.map((r) => r.state).join(','));
  if (!rj.error) {
    await riley.ui.clickTid('fr-setup-continue');
    await savePhrase(riley);
    await sleep(3000);
    await shot(riley, 'app');
  }
  // Warm: the app is running and has a server; a second launch with the link
  // goes to the running one (single instance) and opens Join with it.
  pc(friend, 'sam', 'sh', '-c', `gio open '${portable}' >/dev/null 2>&1`);
  await attempt('a warm paracord:// link reaches the running app (single instance) and opens Join with the link', async () => {
    await until(async () => (await friend.session.exec("return [...document.querySelectorAll('input')].some((i) => i.value.includes('/invite/'))")), 'no Join field filled with the link', 20000);
    return true;
  });
  await shot(friend, 'warm-deeplink');
  const count = L.exec(friend.name, ['sh', '-c', 'pgrep -c -x paracord-deskto'], { allowFail: true }).out;
  check('still one app process after the warm link', count === '1', count);
  await friend.ui.press('Escape');
  await sleep(800);
  // The scheme lives on the packaged entry (com.paracord.desktop.desktop); the app
  // writes no entry of its own beside it and no separate handler entry.
  const handler = pc(friend, 'sam', 'xdg-mime', 'query', 'default', 'x-scheme-handler/paracord').out.trim();
  check('paracord:// opens the app\'s own entry, com.paracord.desktop.desktop', handler === 'com.paracord.desktop.desktop', handler);
  const userEntries = L.exec(friend.name, ['sh', '-c', 'ls /home/sam/.local/share/applications 2>/dev/null | grep -i paracord'], { allowFail: true }).out.trim();
  check('no handler or duplicate entry in the user\'s applications', userEntries === '', userEntries);
  // A session that is not GNOME/KDE/XFCE (sway): xdg-open takes its generic path.
  const xdg = pc(friend, 'sam', 'env', 'XDG_CURRENT_DESKTOP=sway', 'XDG_SESSION_DESKTOP=sway', 'timeout', '10', 'xdg-open', portable);
  check('xdg-open on a non-GNOME session (generic path) hands the paracord:// link over', xdg.status === 0, (xdg.err || xdg.out).split('\n').filter((l) => !l.includes('command not found')).join(' / '));
  await attempt('the xdg-open link reaches the running app and opens Join with it', async () => {
    await until(async () => (await friend.session.exec("return [...document.querySelectorAll('input')].some((i) => i.value.includes('/invite/'))")), 'no Join field filled with the link', 20000);
    return true;
  });
  await shot(friend, 'xdg-open-deeplink');
  const count2 = L.exec(friend.name, ['sh', '-c', 'pgrep -c -x paracord-deskto'], { allowFail: true }).out;
  check('still one app process after xdg-open', count2 === '1', count2);
  await friend.ui.press('Escape');
}

async function s3() {
  scenario('S3', 'Relaunch the host app (no password asked) and sign the host user out and in: the service comes back and the DM is readable');
  const { host, friend } = st;
  await quit(host);
  check('the server keeps running with the app closed', pc(host, 'unit-active').out === 'active' && health(friend, `https://${PUBLIC_IP}:8443`));
  st.dm2 = `cedar-falcon-${stamp} sent while your app was closed`;
  await say(friend, st.dm2);
  await sleep(1500);
  await launch(host, 'host-relaunch');
  await sleep(6000);
  await shot(host, 'relaunched');
  const path = await host.ui.path();
  const pw = await host.session.exists('input[type=password]');
  check('the relaunch asks for no password', !path.startsWith('/unlock') && !path.startsWith('/login') && !pw, path);
  await openDmWith(host, 'Alex');
  await attempt('history decrypts after the relaunch', () => seesText(host, st.dm1));
  await attempt('the message sent while the app was closed arrives', () => seesText(host, st.dm2));
  await shot(host, 'relaunch-dm');
  const rv = await hostSettings(host, 'settings-after-relaunch');
  check('after the relaunch Settings says Running and the way is open', /Running/.test(rv.state ?? '') && /opened the way|connected from outside/.test(rv.reach ?? ''), `${rv.state} | ${rv.reach}`);
  await closeSettings(host);

  // Sign out of the computer, sign in again.
  await quit(host);
  L.signOut(host.name);
  check('signing out stops the service (lingering is off)', pc(host, 'unit-active').status !== 0 && !health(friend, `https://${PUBLIC_IP}:8443`));
  check('the router mapping was released on the way down', !/192\.168\.50\.28/.test(L.routerMappings('pcfm-router')));
  L.signIn(host.name);
  await until(() => health(host, 'https://127.0.0.1:8443'), 'the service did not come back after sign-in', 60000);
  check('after sign-in the service starts on its own and reads its key from the unlocked keychain', pc(host, 'unit-active').out === 'active');
  await until(() => health(friend, `https://${PUBLIC_IP}:8443`), 'the friend cannot reach the host after the session restart', 60000).then(
    () => check('the router mapping is back and the friend reaches the host', true),
    (e) => check('the router mapping is back and the friend reaches the host', false, e.message),
  );
  await launch(host, 'host-after-signin');
  await sleep(6000);
  const sv3 = await hostSettings(host, 'settings-after-signin');
  check('after sign-in Settings says Running, starts at sign-in, and the way is open', /Running/.test(sv3.state ?? '') && /opened the way|connected from outside/.test(sv3.reach ?? ''), `${sv3.state} | ${sv3.reach}`);
  await closeSettings(host);
  await openDmWith(host, 'Alex');
  await attempt('the DM is readable after signing out and in', () => seesText(host, st.dm1));
  await shot(host, 'after-signin-dm');
  st.dm3 = `birch-lynx-${stamp} back after a restart`;
  await say(host, st.dm3);
  await attempt('the friend reconnected and gets new messages', () => seesText(friend, st.dm3, 90000));
  await shot(friend, 'after-host-restart');
}

async function s4() {
  scenario('S4', 'Second device: the friend signs in with username and password, gets the identity from the key backup and reads the DM');
  const { host } = st;
  await ensureApp(host, 'host-s4');
  const second = computer({ name: 'pcfm-friend2', hostname: 'alex-desktop', net: L.NETWORKS.wan, ip: '203.0.113.78' });
  st.second = second;
  const ui = await launch(second, 'friend2');
  await ui.tid('fr-choose-join', 60000);
  await sleep(2500);
  await ui.click('Sign in');
  await ui.heading('Sign in');
  await ui.fill('fr-sign-in-server', `https://${PUBLIC_IP}:8443`);
  await until(() => second.session.exists('[data-testid=fr-trust-row]'), 'no trust row on sign-in', 30000);
  await sleep(800);
  await shot(second, 'sign-in-probed');
  const words = (await second.session.text(await ui.tid('fr-trust-row'))).toLowerCase();
  check('sign-in shows the same trust words', st.hostWords.words.every((w) => words.includes(w)), words);
  await ui.fill('fr-sign-in-user', ALEX.username);
  await ui.fill('fr-sign-in-password', ALEX.password);
  await ui.clickTid('fr-sign-in-submit');
  await until(async () => /\/app\//.test(await ui.path()), 'sign-in did not reach the app', 90000);
  await sleep(4000);
  await shot(second, 'signed-in');
  check('no recovery phrase screen on a second device (already confirmed)', !(await ui.text()).includes('Save your recovery phrase'));
  await openDmWith(second, 'Sam');
  await sleep(4000);
  await shot(second, 'dm-before-keys');
  const t = await ui.text();
  check('the device holds the account identity from the key backup (it offers fresh keys under that identity)', /restored the identity this account is enrolled under/.test(t), t.slice(-400));
  check('history from before this device is shown as unreadable (by design: per-device sessions)', t.includes('Encrypted message'));
  await ui.click('Publish new keys for this device');
  await sleep(4000);
  await shot(second, 'keys-published');
  // Sam's next message right after the new keys: does it reach the new device?
  st.dm4 = `spruce-otter-${stamp} first after your new device`;
  await say(host, st.dm4);
  const firstReached = await seesText(second, st.dm4, 30000).catch(() => false);
  check('Sam\'s next message after the new keys reaches the new device ("your contacts pick them up on their next message")', firstReached);
  await shot(second, 'after-sam-next');
  st.dm5 = `ember-wren-${stamp} hello from my desktop`;
  await say(second, st.dm5);
  await attempt('Sam reads the new device\'s message', () => seesText(host, st.dm5));
  st.dm6 = `delta-moth-${stamp} got it`;
  await say(host, st.dm6);
  await attempt('the second device reads Sam\'s reply', () => seesText(second, st.dm6));
  await shot(second, 'dm-second-device');
}

async function s7() {
  scenario('S7', 'Certificate change on the server: the friend\'s app shows identity-changed and stays disconnected until Trust');
  const { host, friend } = st;
  const before = JSON.parse(pc(host, 'db-messages', '50').out.replace(/^ok\s*/, '') || '[]').length;
  pc(host, 'sam', 'systemctl', '--user', 'stop', 'paracord-host');
  L.exec(host.name, ['sh', '-c', `rm -rf ${HOST_ROOT}/data/certs`]);
  pc(host, 'sam', 'systemctl', '--user', 'start', 'paracord-host');
  await until(() => health(host, 'https://127.0.0.1:8443'), 'the server did not come back', 60000);
  const after = hostTrustWords(host);
  check('the server came back with a new certificate', after.fingerprint !== st.hostWords.fingerprint, after.words.join(' '));
  st.newWords = after;
  const shownStrip = await friend.ui.waitText(/has a new identity/, 90000).then(() => true, () => false);
  await shot(friend, 'after-cert-change');
  check('the running friend app shows identity-changed', shownStrip, (await friend.ui.text()).slice(-300).replace(/\s+/g, ' '));
  check('no "instance is restarting" or "Connection lost" while held', !/instance is restarting|Connection lost/.test(await friend.ui.text()));
  let pending = null;
  try { pending = await invoke(friend, 'pending_identity_change', { host: PUBLIC_IP }); } catch { /* */ }
  check('the shell recorded the mismatch (old and new fingerprints)', pending?.pinned_fp === st.hostWords.fingerprint && pending?.presented_fp === after.fingerprint, JSON.stringify(pending));
  st.dm7 = `quiet-fern-${stamp} should not be sent`;
  await say(friend, st.dm7).catch(() => {});
  await sleep(8000);
  const nowCount = JSON.parse(pc(host, 'db-messages', '50').out.replace(/^ok\s*/, '') || '[]').length;
  check('the friend stays disconnected: nothing it sends reaches the server', nowCount === before, `${before} → ${nowCount}`);
  await attempt('Review opens the sheet with the old and the new words', async () => {
    await friend.ui.click('Review');
    await friend.ui.waitText(/Stay disconnected/, 20000);
    const both = async () => {
      const t = (await friend.ui.text()).toLowerCase();
      return st.hostWords.words.every((w) => t.includes(w)) && after.words.every((w) => t.includes(w));
    };
    const shown = await until(both, 'words', 15000).then(() => true, () => false);
    await shot(friend, 'identity-sheet');
    if (!shown) {
      const sheet = (await friend.ui.text()).match(/words used to be[^.]*\.[^.]*\./)?.[0] ?? '';
      throw new Error(`after 15 s the sheet says "${sheet}"; expected old ${st.hostWords.words.join(' · ')} and new ${after.words.join(' · ')}`);
    }
    return true;
  });
  await friend.ui.click('Stay disconnected').catch(() => {});
  await sleep(6000);
  check('"Stay disconnected" keeps it disconnected', JSON.parse(pc(host, 'db-messages', '50').out.replace(/^ok\s*/, '') || '[]').length === nowCount);
  await shot(friend, 'stayed-disconnected');

  // The second device, closed and opened again: the launch screen.
  const second = st.second;
  if (second) {
    await quit(second);
    await launch(second, 'friend2-relaunch');
    const held = await until(() => second.session.exists('[data-testid=home-identity-changed]', { loose: true }), 'no identity-changed launch screen', 60000).then(() => true, () => false);
    await sleep(800);
    await shot(second, 'relaunch-identity-changed');
    check('after a relaunch the app opens on the identity-changed screen', held, `${await second.ui.path()}: ${(await second.ui.text()).slice(0, 200).replace(/\s+/g, ' ')}`);
    if (held) {
      await second.ui.click('Review');
      await second.ui.waitText(/Stay disconnected/, 20000).catch(() => {});
      await sleep(3000);
      await shot(second, 'relaunch-identity-sheet');
      const t2 = (await second.ui.text()).toLowerCase();
      check('the launch-screen sheet shows the old and the new words', st.hostWords.words.every((w) => t2.includes(w)) && after.words.every((w) => t2.includes(w)),
        (await second.ui.text()).match(/words used to be[^.]*\.[^.]*\./)?.[0] ?? '');
      await second.ui.click('Trust the new identity');
      await attempt('Trust on the launch screen restores the session and opens the app', async () => {
        await until(async () => /\/app\//.test(await second.ui.path()), 'not in the app', 60000);
        return true;
      });
      await shot(second, 'relaunch-trusted');
    }
  }

  // Trust on the running app.
  if (await friend.ui.hasButton('Review')) await friend.ui.click('Review');
  await attempt('Trust the new identity reconnects the running app', async () => {
    await friend.ui.click('Trust the new identity');
    await until(async () => !/has a new identity/.test(await friend.ui.text()), 'the strip stayed', 60000);
    return true;
  });
  st.dm8 = `amber-kite-${stamp} after the new identity`;
  await say(friend, st.dm8).catch(() => {});
  await attempt('after Trust a message reaches the server', () => until(() => JSON.parse(pc(host, 'db-messages', '50').out.replace(/^ok\s*/, '') || '[]').length > nowCount, 'nothing arrived', 60000).then(() => true));
  await shot(friend, 'after-trust');
}

async function s8() {
  scenario('S8', 'Restore on a fresh host computer from a backup with the recovery phrase');
  const { host, friend } = st;
  // A backup after the DMs, made from the app (Admin › Backups › Create backup).
  await ensureApp(host, 'host-s8');
  await host.ui.press('Escape');
  await sleep(300);
  await host.ui.click('Your account');
  await sleep(500);
  await host.ui.click('Admin dashboard', { exact: false });
  await host.ui.click('Backups');
  await sleep(1000);
  const before = L.exec(host.name, ['sh', '-c', `ls ${HOST_ROOT}/data/backups`]).out.split('\n').filter(Boolean);
  await host.ui.click('Create backup');
  const archives = await until(() => {
    const now = L.exec(host.name, ['sh', '-c', `ls ${HOST_ROOT}/data/backups`]).out.split('\n').filter(Boolean);
    return now.length > before.length ? now : null;
  }, 'no new backup appeared', 60000);
  await shot(host, 'backup-created');
  const archive = archives.sort().pop();
  const local = join(OUT, 'backup.tar.gz');
  L.docker(['cp', `${host.name}:${HOST_ROOT}/data/backups/${archive}`, local]);
  check('a backup made from the app after the DMs', true, archive);
  const msgCount = JSON.parse(pc(host, 'db-messages', '50').out.replace(/^ok\s*/, '') || '[]').length;

  // The old computer is gone.
  await quit(host);
  L.signOut(host.name);
  clearInterval(host.watch);
  L.docker(['rm', '-f', host.name]);
  const fresh = computer({ name: 'pcfm-host', hostname: 'sams-new-pc', net: L.NETWORKS.lan, ip: '192.168.50.28', router: '192.168.50.1' });
  st.host = fresh;
  L.exec(fresh.name, ['mkdir', '-p', '/home/sam/Downloads']);
  L.docker(['cp', local, `${fresh.name}:/home/sam/Downloads/Paracord backup.tar.gz`]);
  L.exec(fresh.name, ['chown', '-R', 'sam:sam', '/home/sam/Downloads']);

  const restoreDialogs = fresh.dialogsSeen;
  const ui = await launch(fresh, 'restore');
  await ui.tid('fr-choose-host', 60000);
  await sleep(2500);
  await ui.clickTid('fr-choose-host');
  await ui.heading('What should we call your server?');
  await ui.clickTid('fr-restore-link');
  await ui.heading('Restore from a backup');
  await shot(fresh, 'restore-empty');
  await ui.clickTid('fr-pick-backup');
  await until(() => pc(fresh, 'windows').out.includes('Choose a Paracord backup'), 'the file chooser did not open', 20000);
  await sleep(800);
  shotScreen(fresh, 'file-chooser');
  pc(fresh, 'choose-file', 'Choose a Paracord backup', '/home/sam/Downloads/Paracord backup.tar.gz');
  await ui.tid('fr-backup-file', 20000);
  await until(async () => /Paracord \d/.test(await fresh.session.text(await ui.tid('fr-backup-file'))), 'the backup was not read', 20000);
  await ui.fill('fr-restore-phrase', st.samPhrase.join(' '));
  await sleep(500);
  await shot(fresh, 'restore-chosen');
  await ui.clickTid('fr-restore-continue');
  const rows = await waitRows(fresh);
  await shot(fresh, 'restore-rows');
  check('restore rows all succeed', rows.length === 6 && rows.every((r) => r.state === 'ok'), rows.map((r) => `${r.state}: ${r.text}`).join(' | '));
  await ui.clickTid('fr-setup-continue');
  await ui.heading('Sign in', 30000);
  await sleep(3000);
  const unreachable = (await ui.text()).includes("Can't reach 127.0.0.1");
  check('sign-in after the restore reaches this computer\'s server on the first try', !unreachable,
    unreachable ? '"Can\'t reach 127.0.0.1" while the native trust prompt for the loopback server was up' : '');
  if (unreachable) {
    await shot(fresh, 'restore-sign-in-cant-reach');
    // A person types the address again, which checks it again.
    await ui.fill('fr-sign-in-server', 'https://127.0.0.1:8443');
    await until(() => fresh.session.exists('[data-testid=fr-trust-row]'), 'this computer\'s server still unreachable after typing it again', 30000);
  }
  await ui.fill('fr-sign-in-user', SAM.username);
  await ui.fill('fr-sign-in-password', SAM.password);
  await shot(fresh, 'restore-sign-in');
  await ui.clickTid('fr-sign-in-submit');
  await until(async () => /\/app\//.test(await ui.path()), 'sign-in after restore did not reach the app', 90000);
  await sleep(4000);
  await shot(fresh, 'restored-app');
  check('no native trust prompt for this computer\'s own server during the restore', fresh.dialogsSeen === restoreDialogs, `${fresh.dialogsSeen - restoreDialogs} dialog(s)`);
  const t = await ui.text();
  check(`the restored server is "${SERVER}" with its channels and members`, t.includes(SERVER) && t.includes('clips') && t.includes('plans') && /3 members|members/.test(t), t.slice(0, 200).replace(/\s+/g, ' '));
  const info = hostJson(fresh);
  check('a new instance id, the service running, storage encrypted', info.instance_id && info.instance_id !== st.instanceId && pc(fresh, 'unit-active').out === 'active' && !pc(fresh, 'db-header').out.startsWith('53514c69746520666f726d6174'), JSON.stringify({ id: info.instance_id, config: info.config_path }));
  const restoredRows = JSON.parse(pc(fresh, 'db-messages', '50').out.replace(/^ok\s*/, '') || '[]');
  const dmId = st.dmPath?.split('/').pop();
  const dmRows = restoredRows.filter((r) => String(r.channel_id) === dmId);
  check('every stored message came back; the DM rows are still ciphertext', restoredRows.length === msgCount && dmRows.length > 0 && dmRows.every((r) => r.has_e2ee_header === 1), `${restoredRows.length} of ${msgCount}; ${dmRows.length} DM rows`);
  check('the plaintext is still nowhere on disk', pc(fresh, 'db-grep', 'pineapple-otter').out === '0');
  const items = JSON.parse(pc(fresh, 'keychain-list').out || '[]');
  check('the new computer\'s keychain holds the restored server\'s key', items.some((i) => i.username === `host-storage-key:${info.instance_id}`), JSON.stringify(items.map((i) => i.username)));
  check('friends reach the restored server through the router', health(friend, `https://${PUBLIC_IP}:8443`));
  await openDmWith(fresh, 'Alex');
  await sleep(3000);
  await shot(fresh, 'restored-dm');
}

async function s5() {
  scenario('S5', 'The router refuses: setup shows the refused state and the steps, keeps retrying, and flips to open when the router allows it');
  // The restored host leaves; its mapping goes with it.
  const old = st.host;
  await quit(old).catch(() => {});
  L.signOut(old.name);
  L.routerMode('pcfm-router', 'deny-noupnp');
  await sleep(1500);
  const hostb = computer({ name: 'pcfm-hostb', hostname: 'jo-pc', net: L.NETWORKS.lan, ip: '192.168.50.29', router: '192.168.50.1' });
  st.hostb = hostb;
  let rows = await hostFirstRun(hostb, 'hostb', JO, 'Board Game Club');
  rows = await retryFailedRows(hostb, rows, 'hostb');
  check('rows 1–3 and 5 succeed, row 4 warns', rows.length === 5 && [0, 1, 2, 4].every((i) => rows[i].state === 'ok') && rows[3].state === 'warn', rows.map((r) => r.state).join(','));
  check('row 4 says the router didn\'t allow it', /Your router didn.t allow it, so for now only people on your home network can join\./.test(rows[3]?.text), rows[3]?.text);
  await hostb.ui.click('Show me how');
  const sheet = await hostb.session.text(await hostb.ui.tid('fr-router-sheet'));
  await sleep(500);
  await shot(hostb, 'router-sheet');
  check('the sheet names the router\'s address: "Open your router\'s page at 192.168.50.1"', /router.s page at 192\.168\.50\.1/.test(sheet), sheet.replace(/\s+/g, ' '));
  check('the sheet names port 8443 and this computer 192.168.50.29', sheet.includes('8443') && sheet.includes('192.168.50.29'));
  await hostb.ui.click('Got it');
  await hostb.ui.click('Try again');
  await sleep(500);
  const again = await waitRows(hostb, 60000);
  check('Try again asks again and still warns', again[3]?.state === 'warn', again[3]?.text);
  await hostb.ui.clickTid('fr-setup-continue');
  await savePhrase(hostb);
  await hostb.ui.heading('Invite your friends', 60000);
  await sleep(1200);
  await shot(hostb, 'invite-lan');
  const lan = await inviteLink(hostb);
  check('the invite is the home-network link with the note', /^https:\/\/192\.168\.50\.29:8443\/invite\//.test(lan ?? '') && !!(await hostb.ui.maybeTid('fr-lan-note')), lan);
  check('nothing claims friends can reach this computer', !/Friends can reach you/.test(await hostb.ui.text()));

  // The router owner turns UPnP on and allows mappings.
  L.routerMode('pcfm-router', 'allow');
  const t0 = Date.now();
  const flipped = await until(async () => {
    const l = await inviteLink(hostb);
    return l && l.startsWith(`https://${PUBLIC_IP}:8443/invite/`) ? l : null;
  }, 'the invite never switched to the public address', 130000, 1000).catch(() => null);
  const secs = Math.round((Date.now() - t0) / 1000);
  await shot(hostb, 'invite-after-router-allows');
  check('within 70 s of the router allowing it the invite switches to the public address, live', !!flipped && secs <= 70, `${flipped} after ${secs} s`);
  const status = await invoke(hostb, 'host_status');
  check('reachability is open', status.reachability?.state === 'open', JSON.stringify(status.reachability));
  check('a friend outside reaches the host now', health(st.friend, `https://${PUBLIC_IP}:8443`));
  await hostb.ui.clickTid('fr-open-server');
  await hostb.ui.waitText('Say hi to everyone', 60000).catch(() => {});
  await sleep(2000);
  const v5 = await hostSettings(hostb, 'settings-open-after-router-allows');
  check(`Settings says the router opened the way at ${PUBLIC_IP}`, /opened the way/.test(v5.reach ?? '') && (v5.reach ?? '').includes(PUBLIC_IP), v5.reach);

  // A router that answers UPnP but refuses the mapping (miniupnpd answers 718).
  L.routerMode('pcfm-router', 'deny');
  await closeSettings(hostb);
  pc(hostb, 'sam', 'systemctl', '--user', 'restart', 'paracord-host');
  await until(() => health(hostb, 'https://127.0.0.1:8443'), 'hostb did not restart', 60000);
  await sleep(14000);
  const reachable = health(st.friend, `https://${PUBLIC_IP}:8443`);
  const vd = await hostSettings(hostb, 'settings-router-refuses-upnp');
  check('a router that answers UPnP and refuses the mapping is shown as refused in Settings', /didn.t allow it/.test(vd.reach ?? '') && /checks again every minute/.test(vd.page),
    `${vd.reach}; friend can reach it: ${reachable}; router mappings: ${L.routerMappings('pcfm-router').replace(/\s+/g, ' ')}`);
  check('nothing claims friends can reach it while refused', !/Friends can reach you/.test(vd.page) && !reachable);
  await attempt('Settings › Show me how names the router 192.168.50.1', async () => {
    await hostb.ui.clickTid('host-reach-howto');
    const t = await hostb.ui.waitText(/Forward port/, 15000);
    await shot(hostb, 'settings-router-sheet');
    if (!/router.s page at 192\.168\.50\.1/.test(t)) throw new Error(t.slice(t.indexOf('Let friends in'), t.indexOf('Let friends in') + 300));
    return true;
  });
  await hostb.ui.click('Got it').catch(() => {});
  L.routerMode('pcfm-router', 'allow');
}

async function s6() {
  scenario('S6', 'Carrier-grade NAT (router wan in 100.64.0.0/10): the shared-address state');
  L.createNetworks(['cgnLan', 'cgnWan']);
  L.startRouter({ name: 'pcfm-router-cgn', lan: L.NETWORKS.cgnLan, wan: L.NETWORKS.cgnWan, lanIp: '192.168.60.1', wanIp: '100.64.0.2', mode: 'allow' });
  const hostc = computer({ name: 'pcfm-hostc', hostname: 'kim-pc', net: L.NETWORKS.cgnLan, ip: '192.168.60.28', router: '192.168.60.1' });
  let rows = await hostFirstRun(hostc, 'hostc', KIM, 'Night Owls');
  rows = await retryFailedRows(hostc, rows, 'hostc');
  check('row 4 warns with the shared-address copy', rows[3]?.state === 'warn' && /shares its public address with others/.test(rows[3]?.text), rows[3]?.text);
  check('the other rows succeed', [0, 1, 2, 4].every((i) => rows[i]?.state === 'ok'), rows.map((r) => r.state).join(','));
  await hostc.ui.click('What can I do?');
  await sleep(800);
  await shot(hostc, 'shared-sheet');
  const sheet = await hostc.ui.text();
  check('the sheet suggests asking the provider or forwarding on the router in front', /provider/i.test(sheet), sheet.slice(0, 300).replace(/\s+/g, ' '));
  await hostc.ui.press('Escape');
  const status = await invoke(hostc, 'host_status');
  check('reachability is shared_address with the router\'s 100.64.0.2', status.reachability?.state === 'shared_address' && status.reachability?.external_ip === '100.64.0.2', JSON.stringify(status.reachability));
  await hostc.ui.clickTid('fr-setup-continue');
  await savePhrase(hostc);
  await hostc.ui.heading('Invite your friends', 60000);
  await sleep(1000);
  await shot(hostc, 'invite');
  const link = await inviteLink(hostc);
  check('the invite is the home-network link', /^https:\/\/192\.168\.60\.28:8443\//.test(link ?? ''), link);
  check('no "Friends can reach you" anywhere', !/Friends can reach you|reach you at/.test(await hostc.ui.text()));
  await hostc.ui.clickTid('fr-open-server');
  await hostc.ui.waitText('Say hi to everyone', 60000).catch(() => {});
  await sleep(2000);
  const v6 = await hostSettings(hostc, 'settings-shared-address');
  check('Settings shows the shared-address copy and What can I do?', /shares its public address/.test(v6.reach ?? '') && !!(await hostc.ui.maybeTid('host-reach-shared')), v6.reach);
  check('Settings makes no "reach you" claim', !/Friends can reach you|reach you at/.test(v6.page));
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const free = freeGb();
  log(`run ${RUN}; shots ${SHOTS}; out ${OUT}; ${free} GB free under /home`);
  if (free < 40) throw new Error(`only ${free} GB free under /home; stopping`);
  L.teardown();
  if (!args['no-build-images']) {
    log('building images');
    L.buildImages();
  }
  L.createNetworks(['lan', 'wan']);
  L.startRouter({});
  for (const fn of [s1, s2, s3, s4, s7, s8, s5, s6]) {
    try {
      await fn();
    } catch (e) {
      check(`${current?.id ?? fn.name} ran to the end`, false, e.stack?.split('\n').slice(0, 3).join(' | '));
      for (const c of computers.values()) {
        if (c.ui) await c.ui.shot('failure').catch(() => {});
      }
    }
    save();
  }
}

function freeGb() {
  const out = execFileSync('df', ['-BG', '--output=avail', '/home'], { encoding: 'utf8' });
  return Number(out.split('\n')[1].replace(/\D/g, ''));
}

try {
  await main();
} catch (e) {
  results.error = e.stack;
  console.error(e);
} finally {
  for (const c of computers.values()) {
    clearInterval(c.watch);
    const crashes = L.exec(c.name, ['sh', '-c', "journalctl --no-pager -b | grep -c 'pc-keyring.service: Main process exited, code=dumped' || true"], { allowFail: true }).out.trim();
    if (crashes && crashes !== '0') results.findings.push({ computer: c.name, note: `gnome-keyring-daemon crashed ${crashes} time(s) (SIGABRT); pc-keyring restarted it unlocked` });
    try {
      writeFileSync(join(OUT, `${c.name}.journal.txt`), L.exec(c.name, ['journalctl', '--no-pager', '-b', '-n', '3000'], { allowFail: true }).out);
      const log = L.exec(c.name, ['sh', '-c', `cat ${HOST_ROOT}/logs/server.log 2>/dev/null | tail -n 2000`], { allowFail: true }).out;
      if (log) writeFileSync(join(OUT, `${c.name}.server.log`), log);
    } catch { /* gone */ }
  }
  for (const r of ['pcfm-router', 'pcfm-router-cgn']) {
    const out = L.logs(r, 3000);
    if (out.trim()) writeFileSync(join(OUT, `${r}.log`), out);
  }
  save();
  if (!args.keep) L.teardown();
  const all = results.scenarios.flatMap((s) => s.checks);
  const failed = all.filter((c) => !c.ok);
  console.log(`\n${all.length - failed.length}/${all.length} checks passed in ${results.seconds} s; ${results.dialogs.length} native trust dialog(s); results in ${OUT}`);
  for (const s of results.scenarios) {
    const bad = s.checks.filter((c) => !c.ok);
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${s.id} ${s.title}`);
    for (const c of bad) console.log(`        ✗ ${c.name}: ${c.detail.slice(0, 240)}`);
  }
  process.exit(failed.length || results.error ? 1 : 0);
}
