/**
 * Renders the approved first-run prototype (output/design-reference/setup/
 * paracord-first-run.html) at exactly 1280x800, one PNG per named state, so the
 * first-run UI (S13) holds its own screenshots against the same geometry.
 *
 *   cd client
 *   node e2e/setup-reference.mjs                    # every state
 *   node e2e/setup-reference.mjs welcome host-name-empty   # just these
 *   → output/design-reference/setup/ref/<state>.png (1280x800 each)
 *   → output/design-reference/setup/ref/manifest.json
 *
 * The stage element (#st) is shot with `transform:none`, so the PNG is the
 * 1280x800 window itself, not the review page around it.
 *
 * Determinism. Nothing here depends on how long a screenshot takes:
 *  - launch frames (launch-*ms) run the prototype's boot() on a fake clock
 *    (page.clock) and set every CSS animation/transition to the elapsed time
 *    since it started, paused, so "450ms" is 450ms;
 *  - every other state is shot after the motion has settled, with looping
 *    animations (the working mark, the loading marks) held at 700ms;
 *  - the prototype's own timers (setup rows, invite check) are never waited
 *    for: the rows are painted with the prototype's own complete() function.
 *
 * Where the prototype has a state, the shot is the prototype's. Where the spec
 * (docs/setup-spec.md) has a state the prototype never drew, the state is
 * DERIVED: the prototype's own components (.found, .srv, .trust, .task, .sheet,
 * .inp ...) filled with the spec's exact copy, nothing new styled except where
 * said. manifest.json says which is which (`source: "prototype" | "derived"`);
 * the compare script reports them separately, and the checkpoint lists them.
 *
 * Fails loudly: if Instrument Sans did not load, or the stage is not 1280x800,
 * nothing is written.
 */
/* global $, S, TASKS, bootT, checkInvite, chkT, complete, cordMark, finish, flow, render, resetTasks, sheet, st --
   the prototype's own globals, used inside page.evaluate() callbacks */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'output', 'design-reference', 'setup', 'paracord-first-run.html');
const OUT = join(ROOT, 'output', 'design-reference', 'setup', 'ref');
/** Where looping animations (the working mark, the loading marks) are held. */
const LOOP_HOLD_MS = 700;
/** The prototype's launch timers (boot()): word, out, gone. */
const BOOT_EDGES = [900, 1700, 2280];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
const context = await browser.newContext({ viewport: { width: 1312, height: 1200 }, deviceScaleFactor: 1, locale: 'en-US' });
const only = new Set(process.argv.slice(2));
const manifest = [];

/** Page helpers installed in every document. */
const HELPERS = () => {
  const t0 = new WeakMap();
  window.__tag = (t) => {
    for (const a of document.getAnimations()) if (!t0.has(a)) t0.set(a, t);
  };
  /** Hold every animation at (ms since the clock said it began). */
  window.__holdAt = (now) => {
    for (const a of document.getAnimations()) {
      const began = t0.has(a) ? t0.get(a) : now;
      a.pause();
      a.currentTime = Math.max(0, now - began);
    }
  };
  /** Looping animations hold at a fixed time; finite ones run to their end first. */
  window.__holdLoops = (ms) => {
    for (const a of document.getAnimations()) {
      const iterations = a.effect?.getComputedTiming().iterations;
      if (iterations === Infinity) {
        a.pause();
        a.currentTime = ms;
      }
    }
  };
};

async function open(clock = false) {
  const page = await context.newPage();
  await page.addInitScript(HELPERS);
  if (clock) await page.clock.install({ time: 0 });
  await page.goto(pathToFileURL(SRC).href);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '#st{transform:none!important}' });
  const box = await page.$eval('#st', (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  });
  if (box[0] !== 1280 || box[1] !== 800) throw new Error(`stage is ${box.join('x')}, expected 1280x800`);
  const font = await page.evaluate(() => document.fonts.check('16px "Instrument Sans"'));
  if (!font) throw new Error('Instrument Sans did not load (the prototype takes it from Google Fonts): the shots would be in a fallback face');
  return page;
}

/** Skips the launch: the exact end state of the prototype's boot(). */
async function skipLaunch(page) {
  await page.evaluate(() => {
    bootT.forEach(clearTimeout);
    $('#boot').className = 'boot gone';
    st.classList.remove('booting');
    $('#welMark').innerHTML = cordMark(96);
  });
}

async function settle(page) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await page.evaluate(async () => {
    // Finite motion plays out; looping motion is held.
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
  await page.waitForTimeout(150);
  await page.evaluate((ms) => window.__holdLoops(ms), LOOP_HOLD_MS);
}

async function shoot(page, name, source, note) {
  const file = join(OUT, `${name}.png`);
  // The stage can sit on a fractional offset; clip an exact 1280x800 box.
  const at = await page.$eval('#st', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  });
  await page.screenshot({ path: file, fullPage: true, animations: 'allow', caret: 'hide', clip: { x: Math.round(at.x), y: Math.round(at.y), width: 1280, height: 800 } });
  manifest.push({ state: name, source, note: note ?? null });
  console.log(`  ${name}.png${source === 'derived' ? '  (derived)' : ''}`);
  await page.close();
}

const wanted = (name) => only.size === 0 || only.has(name);

/** The prototype's own steps, driven without its timers. */
const go = {
  /** Show step `id` of a path, with the prototype's own render(). */
  async step(page, path, id) {
    await skipLaunch(page);
    await page.evaluate(
      ({ path, id }) => {
        S.path = path;
        resetTasks();
        S.setup = 'manual';
        S.i = flow().indexOf(id);
        st.classList.remove('done');
        render();
      },
      { path, id },
    );
  },
  /** Sets a field the way typing would (including fields on a step that is not showing). */
  async type(page, selector, text) {
    await page.evaluate(
      ({ selector, text }) => {
        const el = document.querySelector(selector);
        el.value = text;
        el.dispatchEvent(new Event('input'));
      },
      { selector, text },
    );
  },
  /** Paints the setup rows: the first `ok` are done, the next one runs (or none). */
  async rows(page, { ok, running = null, router = 'allows' }) {
    await page.evaluate(
      ({ ok, running, router }) => {
        S.routerOk = router === 'allows';
        resetTasks();
        S.setup = 'manual';
        const list = TASKS[S.path];
        for (let k = 0; k < ok; k += 1) complete(k, list[k], list);
        if (running !== null) {
          $(`.task[data-k="${running}"]`).className = 'task run';
          if (S.path === 'host' && running === 0) $('#pStat').textContent = 'Starting…';
          $('#setMark').innerHTML = cordMark(56, 'working');
        }
        render();
      },
      { ok, running, router },
    );
  },
};

/** Derived-state helpers: the prototype's components with the spec's copy. */
const derive = {
  /** Replaces a row's text and class (the prototype's .task states). */
  taskText: (page, k, cls, text, chips = []) =>
    page.evaluate(
      ({ k, cls, text, chips }) => {
        const el = $(`.task[data-k="${k}"]`);
        el.className = `task ${cls}`;
        el.querySelector('small').textContent = text;
        el.querySelector('.fix')?.remove();
        if (chips.length) el.insertAdjacentHTML('beforeend', `<div class="fix">${chips.map((c) => `<button class="chip${c.ghost ? ' ghost' : ''}">${c.label}</button>`).join('')}</div>`);
      },
      { k, cls, text, chips },
    ),
  /** The danger tint of the "fail" row (spec 1.7), in the prototype's own weak-password red. */
  failStyle: (page) =>
    page.addStyleTag({
      content: `.task.fail{opacity:1}.task.fail .st{background:rgba(255,155,138,.14);box-shadow:inset 0 0 0 1.5px rgba(255,155,138,.5);color:#ff9b8a;font-weight:700;font-size:15px}.task.fail small{color:var(--ink2)}.fielderr{margin-top:2px;font-size:12.5px;line-height:1.45;color:#ff9b8a}.notice{margin-top:22px;display:flex;gap:12px;padding:14px 15px;border-radius:14px;background:rgba(255,207,138,.07);box-shadow:inset 0 0 0 1px rgba(255,207,138,.22);font-size:14px;line-height:1.5;color:var(--ink2)}.notice .ico{color:var(--warn);margin-top:1px}.notice .chip{margin-top:10px;background:var(--cream);color:#141414}.cantreach{margin-top:16px;font-size:13.5px;line-height:1.5;color:var(--ink2)}.cantreach .chip{margin-top:10px}`,
    }),
  /** Puts HTML into the active step, after its sub line. */
  into: (page, html, { replaceFrom = null } = {}) =>
    page.evaluate(
      ({ html, replaceFrom }) => {
        const scr = $('.scr.on');
        if (replaceFrom) {
          const first = scr.querySelector(replaceFrom);
          let n = first;
          while (n && !n.classList.contains('foot')) {
            const next = n.nextElementSibling;
            n.remove();
            n = next;
          }
          scr.querySelector('.foot').insertAdjacentHTML('beforebegin', html);
        } else scr.querySelector('.foot').insertAdjacentHTML('beforebegin', html);
      },
      { html, replaceFrom },
    ),
};

const SHIELD = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';
const WARN = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

console.log(`First-run reference → ${OUT}`);

// ---- launch: the prototype's boot() with its clock replaced by ours ----
// boot() (called by the page on load) arms three real timers and starts CSS
// animations in real time. We cancel the timers and run their three actions
// ourselves at exact virtual times; before each one every animation is held at
// the virtual time, so the style the action starts transitions from is the style
// at that moment. Every animation is tagged with the virtual time it began.
const LAUNCH = [
  ['launch-450ms', 450],
  ['launch-1150ms', 1150],
  ['launch-1800ms', 1800],
  ['launch-1950ms', 1950],
];
const LAUNCH_ACTIONS = {
  900: () => $('#boot').classList.add('word'),
  1700: () => {
    $('#boot').classList.add('out');
    st.classList.remove('booting');
  },
  2280: () => {
    $('#welMark').innerHTML = cordMark(96);
    $('#boot').classList.add('gone');
  },
};
for (const [name, target] of LAUNCH) {
  if (!wanted(name)) continue;
  const page = await open();
  await page.evaluate(() => {
    bootT.forEach(clearTimeout);
    window.__tag(0);
  });
  for (const edge of BOOT_EDGES) {
    if (edge > target) break;
    await page.evaluate(
      ({ edge, action }) => {
        window.__holdAt(edge);
        new Function(`(${action})()`)();
        window.__tag(edge); // reading the animations also flushes style: the transitions exist now
      },
      { edge, action: LAUNCH_ACTIONS[edge].toString() },
    );
  }
  await page.evaluate((t) => window.__holdAt(t), target);
  await shoot(page, name, 'prototype', `boot() ${target}ms after it starts`);
}

// ---- welcome ----
async function welcome() {
  const page = await open();
  await skipLaunch(page);
  await page.waitForTimeout(600);
  return page;
}
if (wanted('welcome')) {
  const page = await welcome();
  await settle(page);
  await shoot(page, 'welcome', 'prototype', 'the split welcome at rest');
}
for (const side of ['host', 'join']) {
  if (!wanted(`welcome-hover-${side}`)) continue;
  const page = await welcome();
  await page.hover(`.half.${side} .hin`);
  await page.waitForTimeout(1100);
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
  await page.evaluate((ms) => window.__holdLoops(ms), LOOP_HOLD_MS);
  await shoot(page, `welcome-hover-${side}`, 'prototype', `pointer on the ${side} half`);
}
// The choose transition: the prototype's choose() adds the classes, then after 430ms starts the step.
for (const side of ['host', 'join']) {
  for (const ms of [140, 280]) {
    const name = `welcome-choose-${side}-${ms}ms`;
    if (!wanted(name)) continue;
    const page = await welcome();
    await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await page.evaluate(
      ({ side, ms }) => {
        const w = $('#wel');
        S.path = side;
        st.style.setProperty('--hue', side === 'host' ? S.hue : 200);
        w.classList.add('chose', `chose-${side}`);
        window.__tag(0);
        document.getAnimations(); // flush: the transitions start now
        window.__tag(0);
        window.__holdAt(ms);
      },
      { side, ms },
    );
    await shoot(page, name, 'prototype', `choose(${side}) ${ms}ms in: the chosen half opens to the window`);
  }
}

// ---- host: name ----
if (wanted('host-name-empty')) {
  const page = await open();
  await go.step(page, 'host', 'h-name');
  await settle(page);
  await shoot(page, 'host-name-empty', 'prototype');
}
if (wanted('host-name-typed')) {
  const page = await open();
  await go.step(page, 'host', 'h-name');
  await go.type(page, '#fName', 'Friday Night Crew');
  await page.click('#hues button[data-h="150"]');
  await settle(page);
  await shoot(page, 'host-name-typed', 'prototype', 'name typed, hue 150');
}
const BLOCKED = {
  no_user_services: { copy: "Hosting from this computer needs systemd user services, which this system doesn't run. You can still host with the server installer: paracord.chat/docs/host." },
  no_keychain: { copy: "Paracord keeps the key that encrypts your server in your system keychain, and this computer doesn't have one running. Install or turn on GNOME Keyring or KWallet, then try again." },
  existing_server: { copy: 'Paracord is already running on this computer.', use: true },
  no_port: { copy: 'Every port Paracord could use (8443 to 8463) is taken.' },
  no_space: { copy: 'This computer needs at least 1 GB free to host a server.' },
};
for (const [reason, { copy, use }] of Object.entries(BLOCKED)) {
  const name = `host-name-blocked-${reason}`;
  if (!wanted(name)) continue;
  const page = await open();
  await go.step(page, 'host', 'h-name');
  await derive.failStyle(page);
  await derive.into(page, `<div class="notice">${WARN}<span>${copy}${use ? '<br><button class="chip">Use it</button>' : ''}</span></div>`, { replaceFrom: '.fl' });
  await page.evaluate(() => ($('#nName').disabled = true));
  await settle(page);
  await shoot(page, name, 'derived', 'spec 2.3: the blocking notice replaces the fields, Continue disabled');
}

// ---- account ----
async function account(path) {
  const page = await open();
  await go.step(page, path, 'account');
  if (path === 'host') {
    await go.type(page, '#fName', 'Friday Night Crew'); // the hidden host-name field feeds .sName
  }
  return page;
}
if (wanted('account-empty')) {
  const page = await account('host');
  await settle(page);
  await shoot(page, 'account-empty', 'prototype');
}
if (wanted('account-weak')) {
  const page = await account('host');
  await go.type(page, '#fDisp', 'Sam');
  await go.type(page, '#fPw', 'sunshine');
  await settle(page);
  await shoot(page, 'account-weak', 'prototype', 'eight characters: "2 more characters", meter at 1');
}
if (wanted('account-strong')) {
  const page = await account('host');
  await go.type(page, '#fDisp', 'Sam');
  await go.type(page, '#fPw', 'paper lantern orbit harbor');
  await settle(page);
  await shoot(page, 'account-strong', 'prototype');
}
if (wanted('account-email')) {
  const page = await account('join');
  await go.type(page, '#fDisp', 'Sam');
  await go.type(page, '#fPw', 'paper lantern orbit');
  await page.evaluate(() => {
    $('#fUser').closest('.row2').insertAdjacentHTML('afterend', '<div class="fl"><label for="fEmail">Email</label><input class="inp" id="fEmail" placeholder="sam@example.com" autocomplete="off" value="sam@example.com"></div>');
  });
  await settle(page);
  await shoot(page, 'account-email', 'derived', 'spec 1.6: the Email field when the server requires it (a join; the host never does)');
}

// ---- host setup ----
const HOST_ROWS = 5;
async function hostSetup(rows) {
  const page = await open();
  await go.step(page, 'host', 'setup');
  await go.type(page, '#fName', 'Friday Night Crew');
  await go.rows(page, rows);
  return page;
}
if (wanted('host-setup-running')) {
  const page = await hostSetup({ ok: 2, running: 2 });
  await settle(page);
  await shoot(page, 'host-setup-running', 'prototype', 'rows 1 and 2 done, row 3 running');
}
if (wanted('host-setup-done')) {
  const page = await hostSetup({ ok: HOST_ROWS });
  await settle(page);
  await shoot(page, 'host-setup-done', 'prototype', 'the router allowed it');
}
if (wanted('host-setup-refused')) {
  const page = await hostSetup({ ok: HOST_ROWS, router: 'refuses' });
  await settle(page);
  await shoot(page, 'host-setup-refused', 'prototype', 'Router refuses');
}
if (wanted('host-setup-no-answer')) {
  const page = await hostSetup({ ok: HOST_ROWS, router: 'refuses' });
  await derive.taskText(page, 3, 'warn', "Your router didn't answer, so for now only people on your home network can join.", [{ label: 'Show me how' }, { label: 'Try again', ghost: true }]);
  await settle(page);
  await shoot(page, 'host-setup-no-answer', 'derived', 'spec 5.4: the no_answer copy on the prototype warn row');
}
if (wanted('host-setup-shared')) {
  const page = await hostSetup({ ok: HOST_ROWS, router: 'refuses' });
  await derive.taskText(
    page,
    3,
    'warn',
    "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join.",
    [{ label: 'What can I do?' }, { label: 'Try again', ghost: true }],
  );
  await settle(page);
  await shoot(page, 'host-setup-shared', 'derived', 'spec 5.4: the shared_address copy, chip "What can I do?"');
}
if (wanted('host-setup-fail')) {
  const page = await hostSetup({ ok: 0, running: 0 });
  await derive.failStyle(page);
  await page.evaluate(() => {
    $('#setMark').innerHTML = cordMark(56);
    $('#pStat').textContent = 'Not running yet';
  });
  await derive.taskText(page, 0, 'fail', "Paracord on this computer didn't start.", [{ label: 'Try again' }, { label: 'Show details', ghost: true }]);
  await page.evaluate(() => ($('.task[data-k="0"] .st').innerHTML = '×'));
  await settle(page);
  await shoot(page, 'host-setup-fail', 'derived', 'spec 1.7: a failed row (danger tint, x), chips Try again and Show details');
}

// ---- sheets ----
async function sheetOver(path, stepId, sheetId, rows) {
  const page = await open();
  await go.step(page, path, stepId);
  if (path === 'host') await go.type(page, '#fName', 'Friday Night Crew');
  if (rows) await go.rows(page, rows);
  await page.evaluate((id) => sheet(id), sheetId);
  return page;
}
if (wanted('privacy-sheet-host')) {
  const page = await sheetOver('host', 'setup', 'privSheet', { ok: HOST_ROWS });
  await settle(page);
  await shoot(page, 'privacy-sheet-host', 'prototype');
}
if (wanted('privacy-sheet-join')) {
  const page = await sheetOver('join', 'setup', 'privSheet', { ok: 3 });
  await settle(page);
  await shoot(page, 'privacy-sheet-join', 'prototype');
}
if (wanted('router-sheet')) {
  const page = await sheetOver('host', 'setup', 'routerSheet', { ok: HOST_ROWS, router: 'refuses' });
  await settle(page);
  await shoot(page, 'router-sheet', 'prototype');
}
if (wanted('shared-sheet')) {
  const page = await sheetOver('host', 'setup', 'routerSheet', { ok: HOST_ROWS, router: 'refuses' });
  await page.evaluate(() => {
    const s = $('#routerSheet');
    s.querySelector('h3').textContent = 'Your connection shares its address';
    s.querySelector(':scope > p').textContent = "Friends outside your home network can't reach this computer, because your internet connection shares its public address with other customers.";
    s.querySelector('.howto').innerHTML =
      '<ol><li>Ask your internet provider for a <b>public IPv4 address</b>. Many give one for free if you ask.</li><li>If another router sits in front of yours, forward port <code>8443</code> (TCP and UDP) on that one too.</li></ol>';
    s.querySelector(':scope > p ~ p').textContent = 'Paracord checks again every minute and tells you when friends can get in. Until then, people on your home network can still join.';
  });
  await settle(page);
  await shoot(page, 'shared-sheet', 'derived', 'spec 5.4: the shared_address sheet, no port steps (copy is a stand-in to be fixed by S13)');
}

// ---- phrase ----
for (const [name, reveal] of [['phrase-blurred', false], ['phrase-revealed', true]]) {
  if (!wanted(name)) continue;
  const page = await open();
  await go.step(page, 'host', 'phrase');
  await go.type(page, '#fName', 'Friday Night Crew');
  if (reveal) await page.click('#reveal');
  await settle(page);
  await shoot(page, name, 'prototype');
}

// ---- host invite, done ----
for (const [name, router] of [['host-invite-internet', 'allows'], ['host-invite-lan', 'refuses']]) {
  if (!wanted(name)) continue;
  const page = await open();
  await go.step(page, 'host', 'h-invite');
  await go.type(page, '#fName', 'Friday Night Crew');
  await go.rows(page, { ok: HOST_ROWS, router });
  await settle(page);
  await shoot(page, name, 'prototype');
}
if (wanted('done-host')) {
  const page = await open();
  await go.step(page, 'host', 'h-invite');
  await go.type(page, '#fName', 'Friday Night Crew');
  await go.rows(page, { ok: HOST_ROWS });
  await page.evaluate(() => finish());
  await page.waitForTimeout(1500);
  await settle(page);
  await shoot(page, 'done-host', 'prototype', 'the preview has grown into the app; toast shown');
}

// ---- join: invite ----
async function inviteStep() {
  const page = await open();
  await go.step(page, 'join', 'j-invite');
  return page;
}
if (wanted('join-invite-empty')) {
  const page = await inviteStep();
  await page.evaluate(() => ($('#clip').style.display = 'none'));
  await settle(page);
  await shoot(page, 'join-invite-empty', 'derived', 'prototype j-invite with the clipboard banner hidden (the prototype always shows it)');
}
for (const name of ['join-invite-clipboard', 'welcome-clipboard']) {
  if (!wanted(name)) continue;
  const page = await inviteStep();
  await settle(page);
  await shoot(page, name, 'prototype', name === 'welcome-clipboard' ? 'spec 1.3: a clipboard invite at Welcome opens straight into the Join step: this is that screen' : undefined);
}
if (wanted('join-invite-checking')) {
  const page = await inviteStep();
  await page.evaluate(() => {
    $('#fInvite').value = 'https://kanto.home.arpa:8443/invite/Rf8kQ2';
    // checkInvite() arms a 900ms timer for the card; the page here never lets it fire before the shot.
    checkInvite();
  });
  await page.evaluate(() => {
    clearTimeout(chkT);
  });
  await settle(page);
  await shoot(page, 'join-invite-checking', 'prototype');
}
async function cardPage() {
  const page = await inviteStep();
  await page.evaluate(() => {
    $('#fInvite').value = 'https://kanto.home.arpa:8443/invite/Rf8kQ2';
    checkInvite();
  });
  await page.waitForTimeout(1500);
  return page;
}
if (wanted('join-invite-card')) {
  const page = await cardPage();
  await settle(page);
  await shoot(page, 'join-invite-card', 'prototype');
}
if (wanted('join-invite-ca-verified')) {
  const page = await cardPage();
  await page.evaluate(() => {
    const t = $('#srvCard .trust span');
    t.innerHTML = '<b>Connected securely to kanto.example.com.</b> Its certificate is issued by a public certificate authority.';
  });
  await settle(page);
  await shoot(page, 'join-invite-ca-verified', 'derived', 'spec 1.5: trust row without words');
}
const inviteProblem = async (name, html, why) => {
  if (!wanted(name)) return;
  const page = await inviteStep();
  await derive.failStyle(page);
  await page.evaluate((h) => {
    $('#clip').style.display = 'none';
    $('#fInvite').value = 'https://kanto.home.arpa:8443/invite/Rf8kQ2';
    $('#fInvite').closest('.fl').insertAdjacentHTML('beforeend', h);
  }, html);
  await settle(page);
  await shoot(page, name, 'derived', why);
};
await inviteProblem('join-invite-invalid', "<div class='fielderr'>This invite doesn't work anymore. Ask for a new link.</div>", 'spec 1.5: 404 from the preview');
await inviteProblem(
  'join-invite-unreachable',
  "<div class='cantreach'>Can't reach kanto.home.arpa. Check the link, or ask your friend whether their server is running.<br><button class='chip'>Try again</button></div>",
  "spec 1.5: can't reach",
);
await inviteProblem(
  'join-invite-old-server',
  "<div class='fielderr'>Kanto Friends runs an older version of Paracord. Ask the person who runs it to update, then try again.</div>",
  'spec 1.5 / 3.12: older server, Continue disabled',
);
if (wanted('identity-changed')) {
  const page = await cardPage();
  await page.evaluate(() => {
    $('#srvCard').classList.remove('show');
    $('#nInvite').disabled = true;
    const s = $('#routerSheet');
    s.id = 'idSheet';
    s.setAttribute('aria-label', 'Identity changed');
    s.querySelector('h3').textContent = 'Kanto Friends has a new identity';
    s.querySelector(':scope > p').innerHTML =
      "This server's words used to be <b>ember · quarry · lantern · osprey</b>. Now they're <b>velvet · harbor · tundra · copper</b>. That happens when the person who runs it reinstalls Paracord or replaces its certificate. It also happens when someone is trying to listen in. Ask them whether they changed something before you continue.";
    s.querySelector('.howto').remove();
    s.querySelector(':scope > p ~ p').remove();
    s.querySelector('button.go').outerHTML = '<div style="display:flex;gap:10px;margin-top:18px"><button class="go">Stay disconnected</button><button class="go" style="background:rgba(255,155,138,.16);color:#ff9b8a">Trust the new identity</button></div>';
    sheet('idSheet');
  });
  await settle(page);
  await shoot(page, 'identity-changed', 'derived', 'spec 7.4: IdentityChangedSheet over the Join step (sheet chrome is the prototype .sheet)');
}

// ---- join: account, setup, phrase, done ----
if (wanted('join-account')) {
  const page = await open();
  await go.step(page, 'join', 'account');
  await go.type(page, '#fDisp', 'Sam');
  await go.type(page, '#fPw', 'paper lantern orbit');
  await settle(page);
  await shoot(page, 'join-account', 'prototype');
}
if (wanted('join-setup-done')) {
  const page = await open();
  await go.step(page, 'join', 'setup');
  await go.rows(page, { ok: 3 });
  await settle(page);
  await shoot(page, 'join-setup-done', 'prototype');
}
if (wanted('join-phrase')) {
  const page = await open();
  await go.step(page, 'join', 'phrase');
  await page.click('#reveal');
  await page.check('#saved');
  await settle(page);
  await shoot(page, 'join-phrase', 'prototype', 'revealed and confirmed: the button reads "Open Kanto Friends"');
}
if (wanted('done-join')) {
  const page = await open();
  await go.step(page, 'join', 'phrase');
  await page.evaluate(() => finish());
  await page.waitForTimeout(1500);
  await settle(page);
  await shoot(page, 'done-join', 'prototype');
}

// ---- sign in (not in the prototype): the frame with the same components ----
async function signIn(variant) {
  const page = await open();
  await go.step(page, 'join', 'account'); // the frame, step column and preview of an account step
  await derive.failStyle(page);
  await page.evaluate(() => ($('#prog').innerHTML = ''));
  const body = {
    empty: `<div class="fl"><label>Server</label><input class="inp" placeholder="Server address or invite link"></div>
      <div class="fl"><label>Username or email</label><input class="inp"></div>
      <div class="fl"><label>Password</label><input class="inp" type="password"></div>`,
    probed: `<div class="fl"><label>Server</label><input class="inp" value="kanto.home.arpa:8443"></div>
      <div class="trust" style="margin-top:12px">${SHIELD}<span><b>Connected securely to kanto.home.arpa.</b> We remembered this server's identity and will warn you if it ever changes. <span class="fp">ember · quarry · lantern · osprey</span></span></div>
      <div class="fl"><label>Username or email</label><input class="inp" value="sam"></div>
      <div class="fl"><label>Password</label><input class="inp" type="password" value="paper lantern orbit"></div>
      <div class="help" style="margin-top:10px">Forgot your password? <b style="color:var(--ink)">Use your recovery phrase</b></div>`,
    mfa: `<div class="fl"><label>Server</label><input class="inp" value="kanto.home.arpa:8443"></div>
      <div class="fl"><label>Enter the code from your authenticator app.</label><input class="inp big" value="428 913" style="letter-spacing:.14em"></div>`,
    legacy: `<div class="fl"><label>Current sign-in password</label><input class="inp" type="password" value="password123"></div>
      <div class="onepw" style="margin-top:22px">${SHIELD}<span><b>Paracord now uses one password.</b> After this, your sign-in password and your encryption password become a single one.</span></div>`,
  }[variant];
  const title = variant === 'legacy' ? 'This account still uses two passwords' : 'Sign in';
  const sub = variant === 'legacy' ? 'Enter your current sign-in password.' : variant === 'mfa' ? 'One more step.' : 'Use the server address or an invite link from your server.';
  await page.evaluate(
    ({ title, sub, body }) => {
      const scr = $('.scr.on');
      scr.querySelector('h2').textContent = title;
      scr.querySelectorAll('.sub').forEach((e) => e.remove());
      scr.querySelector('h2').insertAdjacentHTML('afterend', `<p class="sub" style="display:block">${sub}</p>`);
      const first = scr.querySelector('.row2');
      let n = first;
      while (n && !n.classList.contains('foot')) {
        const nx = n.nextElementSibling;
        n.remove();
        n = nx;
      }
      scr.querySelector('.foot').insertAdjacentHTML('beforebegin', body);
      scr.querySelector('.foot .back').textContent = 'Back';
      scr.querySelector('#nAcct').disabled = false;
      scr.querySelector('#nAcct').firstChild.textContent = 'Sign in';
    },
    { title, sub, body },
  );
  return page;
}
for (const variant of ['empty', 'probed', 'mfa', 'legacy']) {
  const name = `sign-in-${variant}`;
  if (!wanted(name)) continue;
  const page = await signIn(variant);
  await settle(page);
  await shoot(page, name, 'derived', 'spec 1.12 / 3.11: not in the prototype; the same frame and components');
}

// ---- claim mode (headless install, web) ----
for (const [name, atRest] of [['claim-mode-setup-web', null], ['claim-mode-setup-at-rest-on', true], ['claim-mode-setup-at-rest-off', false]]) {
  if (!wanted(name)) continue;
  const page = await open();
  await go.step(page, 'host', 'setup');
  await go.type(page, '#fName', 'Friday Night Crew');
  await go.rows(page, { ok: HOST_ROWS });
  // Claim mode has no row 1 (spec 2.11): the server is already running. Rows come from /admin/host-status.
  await page.evaluate((atRest) => {
    const list = $('#tasks');
    list.querySelector('.task[data-k="0"]').remove();
    const storage = list.querySelector('.task[data-k="1"]');
    if (atRest === false) {
      storage.className = 'task warn';
      storage.querySelector('b').textContent = 'Encrypting everything it stores';
      storage.querySelector('small').textContent = "Stored messages and files are not encrypted on this server's disk.";
    }
    $('#setupTitle').textContent = 'Setting up your server';
    $('#pStat').textContent = 'Online · just you';
    $('#pDot').classList.add('on');
  }, atRest);
  await derive.failStyle(page);
  await settle(page);
  await shoot(page, name, 'derived', 'spec 2.11: no launch, welcome or row 1; the storage row follows the key source');
}

// ---- restore from a backup (S13b; not in the prototype): Host › Name's frame and components ----
const RESTORE_PHRASE = 'spot flush pizza wide dolphin bar surface again imitate learn sibling blue fee present remain zero frog chuckle budget high citizen sound cushion omit';
const CLOCK_ICO = '<svg class="ico" viewBox="0 0 24 24" style="flex-shrink:0;color:hsl(var(--hue) 70% 78%)"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const DOWN_ICO = '<svg class="ico" viewBox="0 0 24 24" style="flex-shrink:0;color:hsl(var(--hue) 70% 78%)"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
const RESTORE_CARD = (invalid) =>
  `<div class="srv show" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:16px;margin-top:0;${invalid ? 'box-shadow:inset 0 0 0 1.5px #ff9b8a' : ''}">${CLOCK_ICO}<div style="min-width:0"><b style="display:block;font-size:15px;font-weight:600;letter-spacing:0">paracord_backup_20261003_040000.tar.gz</b><small style="display:block;margin-top:3px;font-size:13px;color:var(--ink3)">Made Oct 3, 2026 · 4.1 MB · Paracord 3.4.0</small></div><button class="chip ghost" style="margin-left:auto">Choose another</button></div>`;
const RESTORE_PICK = `<button class="onepw" style="margin-top:0;width:100%;min-height:72px;align-items:center;text-align:left;border:0;cursor:pointer;color:var(--ink);background:rgba(255,255,255,.06);border-radius:16px;padding:14px 16px;gap:14px">${DOWN_ICO}<span><b style="display:block;font-size:15px">Choose a backup file</b><small style="display:block;margin-top:3px;font-size:13px;color:var(--ink3)">Paracord's backups end in .tar.gz. They're in the backups folder of the computer that ran the server.</small></span></button>`;
async function restoreBackup({ chosen, phrase, fileError, phraseError }) {
  const page = await open();
  await go.step(page, 'host', 'h-name');
  // The preview of a restore: the server's name comes with the backup, so it reads "Your server".
  await go.type(page, '#fName', '');
  await derive.failStyle(page);
  const err = (text) => `<div class="fielderr" style="margin-top:0">${text}</div>`;
  const body =
    `<div class="fl"><label>Backup</label>${chosen ? RESTORE_CARD(Boolean(fileError)) : RESTORE_PICK}${fileError ? err(fileError) : ''}</div>` +
    `<div class="fl"><label>Recovery phrase</label><textarea class="inp" rows="4" placeholder="24 words, in order" style="height:auto;min-height:112px;padding:13px 15px;line-height:1.55;resize:none;font-family:inherit"${phraseError ? ' aria-invalid="true"' : ''}>${phrase ? RESTORE_PHRASE : ''}</textarea>${
      phraseError ? err(phraseError) : '<div class="help">The 24 words you saved when you set up the server.</div>'
    }</div>`;
  await page.evaluate(
    ({ body, ready, invalid }) => {
      const scr = $('.scr.on');
      scr.querySelector('h2').textContent = 'Restore from a backup';
      scr.querySelector('.sub').textContent = 'Paracord puts your server back on this computer from a backup file. Your recovery phrase unlocks it.';
      scr.querySelectorAll('.fl').forEach((e) => e.remove());
      scr.querySelector('.foot').insertAdjacentHTML('beforebegin', body);
      if (invalid) scr.querySelector('textarea').style.boxShadow = 'inset 0 0 0 1.5px #ff9b8a';
      $('#nName').firstChild.textContent = 'Restore';
      $('#nName').disabled = !ready;
      $('#prog').innerHTML = '<i class="done"></i><i></i>';
    },
    { body, ready: chosen && phrase && !fileError, invalid: Boolean(phraseError) },
  );
  return page;
}
const RESTORE_STATES = [
  ['restore-backup-empty', { chosen: false, phrase: false }, 'spec 1.4 / 4.8: Restore › Backup, nothing chosen yet'],
  ['restore-backup-chosen', { chosen: true, phrase: true }, 'spec 4.8: the backup and the phrase, Restore enabled'],
  ['restore-wrong-phrase', { chosen: true, phrase: true, phraseError: "That recovery phrase doesn't unlock this backup. It needs the phrase of the account that set up the server." }, 'spec 4.8: the phrase is checked against the backup\'s owner before anything runs'],
  ['restore-no-escrow', { chosen: true, phrase: false, fileError: 'This backup was made before your recovery phrase protected its storage key, so no phrase can unlock it. Choose a newer backup.' }, 'spec 4.7: a backup without the key escrow'],
];
for (const [name, options, why] of RESTORE_STATES) {
  if (!wanted(name)) continue;
  const page = await restoreBackup(options);
  await settle(page);
  await shoot(page, name, 'derived', why);
}
if (wanted('host-name-restore-link')) {
  const page = await open();
  await go.step(page, 'host', 'h-name');
  await go.type(page, '#fName', 'Friday Night Crew');
  await page.evaluate(() => {
    $('#hues').closest('.fl').insertAdjacentHTML(
      'afterend',
      '<button style="margin:18px 0 0 -8px;align-self:flex-start;border:0;background:none;color:var(--ink3);font-size:13.5px;font-weight:600;padding:6px 8px;border-radius:9px;cursor:pointer;display:block">Restore from a backup instead</button>',
    );
  });
  await settle(page);
  await shoot(page, 'host-name-restore-link', 'derived', 'spec 1.4: the secondary link under the swatches (no host data on this computer)');
}
async function restoreSetup({ ok, running = null, fail = false }) {
  const page = await open();
  await go.step(page, 'host', 'setup');
  await go.type(page, '#fName', '');
  await go.rows(page, { ok: Math.max(0, ok - 1), running: running === null || running === 0 ? null : running - 1 });
  await derive.failStyle(page);
  await page.evaluate(
    ({ ok, running, fail }) => {
      const list = $('#tasks');
      const first = list.querySelector('.task');
      const restore = first.cloneNode(true);
      restore.dataset.k = 'r';
      restore.className = fail ? 'task fail' : ok >= 1 ? 'task ok' : running === 0 ? 'task run' : 'task';
      restore.querySelector('b').textContent = 'Restoring from your backup';
      restore.querySelector('small').textContent = fail
        ? "This computer already has a Paracord server's data, and Paracord never restores over it."
        : ok >= 1
          ? 'Restored from the backup of October 3, 2026.'
          : 'Unlocking its storage key with your recovery phrase and checking everything in it.';
      if (fail) restore.querySelector('.st').innerHTML = '×';
      list.insertBefore(restore, first);
      if (fail) {
        list.querySelectorAll('.task:not([data-k="r"])').forEach((t) => (t.className = 'task'));
        $('#setMark').innerHTML = cordMark(56);
        $('#pStat').textContent = 'Not running yet';
        $('#pDot').classList.remove('on');
      }
      const escrow = list.querySelector('.task[data-k="2"]');
      escrow.querySelector('b').textContent = 'Protecting its key with your recovery phrase';
      escrow.querySelector('small').textContent = 'So the same phrase can restore it again.';
      $('#setupTitle').textContent = 'Restoring your server';
      $('#privOpen').classList.remove('show');
      $('#prog').innerHTML = '<i class="done"></i><i class="done"></i>';
    },
    { ok, running, fail },
  );
  return page;
}
for (const [name, rows, why] of [
  ['restore-setup-running', { ok: 2, running: 2 }, 'spec 4.8: the restore done, rows 1 and 2 running; row 3 re-escrows under the same phrase'],
  ['restore-setup-done', { ok: 6 }, 'spec 4.8: every row done; no "See what\'s protected" (no session yet)'],
  ['restore-database-exists', { ok: 0, fail: true }, 'spec 4.8: a database already on this computer: refused up front, no Try again'],
]) {
  if (!wanted(name)) continue;
  const page = await restoreSetup(rows);
  await settle(page);
  await shoot(page, name, 'derived', why);
}

// ---- the launch banner over the app (S13b; spec 2.8, index-spec 6.8 strip): the done app with a strip on main ----
async function bannerOverApp(html) {
  const page = await open();
  await go.step(page, 'host', 'h-invite');
  await go.type(page, '#fName', 'Friday Night Crew');
  await go.rows(page, { ok: HOST_ROWS });
  await page.evaluate(() => finish());
  await page.waitForTimeout(1500);
  await page.evaluate((html) => {
    $('#toast').style.display = 'none';
    const main = document.querySelector('.main');
    main.insertAdjacentHTML('afterbegin', html);
  }, html);
  return page;
}
const STRIP = (text, actions, danger) =>
  `<div style="display:flex;align-items:center;justify-content:center;gap:12px;min-height:36px;padding:0 16px;margin:-1px -1px 0;background:#1c1d21;box-shadow:0 1px 0 var(--line);font-size:13px;font-weight:600;line-height:1.3"><span style="color:${danger ? '#ff9b8a' : 'var(--ink)'}">${text}${actions}</span><span style="width:24px;height:24px;display:grid;place-items:center;color:var(--ink2)">×</span></div>`;
const LINK = (label) => ` <button style="border:0;background:none;color:var(--ink);font:inherit;text-decoration:underline;text-underline-offset:3px;padding:4px 8px">${label}</button>`;
for (const [name, html, why] of [
  [
    'update-failed-banner',
    STRIP("Paracord on this computer didn't start after the update.", LINK('Show details') + LINK('Restore the backup from before the update'), true),
    'spec 2.8: the banner with Show details and the restore (index-spec 6.8 strip, danger ink)',
  ],
  [
    'update-rolled-back-banner',
    STRIP("Paracord on this computer is running 3.3.0 again, with the backup from before the update. 3.4.0 won't be installed again until a newer version comes out.", '', false),
    'spec 2.8: after the restore; the new version is held',
  ],
]) {
  if (!wanted(name)) continue;
  const page = await bannerOverApp(html);
  await settle(page);
  await shoot(page, name, 'derived', why);
}

// A subset run keeps the entries of the states it did not render.
const kept = [];
if (only.size > 0) {
  try {
    kept.push(...JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')).filter((m) => !only.has(m.state)));
  } catch {
    /* no manifest yet */
  }
}
const all = [...kept, ...manifest].sort((a, b) => a.state.localeCompare(b.state));
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(all, null, 2)}\n`);
await browser.close();
const derived = manifest.filter((m) => m.source === 'derived').length;
console.log(`${manifest.length} state(s) rendered (${manifest.length - derived} prototype, ${derived} derived)`);
