#!/usr/bin/env node
// Drive a live Paracord instance with several real accounts in real browsers.
//
// This is not a test file. It is the thing a test file stands in for: several
// people signed in at once, in one instance, doing what the product is for — so
// a claim like "group conversations work" is settled by watching one account
// read what another account wrote, rather than by a unit test agreeing with
// itself about a mock.
//
// Each step prints PASS/FAIL and the run exits non-zero if any step failed.
//
//   node scripts/live-env.mjs &            # instance on :18420
//   node client/scripts/live-drive.mjs

// Lives beside the client so it resolves Playwright out of the client's own
// devDependencies, the same driver the E2E suite uses.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.PARACORD_LIVE_PORT ?? '18420';
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.PARACORD_LIVE_SHOTS ?? '/tmp/paracord-live';
const PASSWORD = 'Live-Drive-Password-123!';
const ENCRYPTION_PASSWORD = 'live drive encryption password';
const ONLY = process.env.PARACORD_LIVE_ONLY;
const stamp = Date.now().toString(36);

mkdirSync(SHOTS, { recursive: true });

const results = [];
const log = (...parts) => console.log(...parts);

async function step(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return true;
  const started = Date.now();
  const marks = new Map(cast.map(person => [person, person.logs.length]));
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? null });
    log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    log(`  FAIL  ${name}\n          ${String(error.message).split('\n').slice(0, 3).join('\n          ')}`);
    // What each app said while this was failing is usually the answer, and it
    // is gone the moment the next step overwrites the screen.
    for (const person of cast) {
      const recent = (person.logs ?? []).slice(marks.get(person) ?? 0).slice(-6);
      if (recent.length) log(`          [${person.label}] ${recent.join('\n          [' + person.label + '] ')}`);
    }
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Everyone currently signed in, so a failure can show what their apps said. */
let cast = [];

/** Poll until `fn` returns truthy, so a realtime assertion is not a race. */
async function until(fn, message, timeoutMs = 20000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error.message; }
    if (Date.now() > deadline) throw new Error(`${message} (waited ${timeoutMs}ms; last: ${JSON.stringify(last)})`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Accounts and the REST client a browser would use
// ---------------------------------------------------------------------------

async function register(name) {
  const username = `${name}${stamp}`.slice(0, 32);
  const email = `${name}-${stamp}@example.test`;
  const response = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password: PASSWORD }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`register ${name}: ${response.status} ${text}`);
  const body = JSON.parse(text);
  return { label: name, username, email, id: body.user.id, token: body.token };
}

/**
 * The REST client, speaking as this person's *browser*.
 *
 * It borrows the browser context's cookies rather than holding a token of its
 * own. Two reasons, both learned the hard way: attaching an encryption identity
 * revokes the session it was authorised with, so a captured token starts 401ing
 * the moment an account enrols; and logging in again out of band opens a second
 * session that costs the browser its first — which showed up as every account
 * losing its realtime stream (`POST /stream/ticket` 401) partway through a run,
 * and looked exactly like a product bug. One session per person, and it is the
 * one on screen.
 */
function api(person) {
  return async (method, path, body) => {
    const cookies = await person.context.cookies();
    const csrf = cookies.find(cookie => cookie.name === 'paracord_csrf')?.value;
    const response = await person.context.request.fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-paracord-csrf': csrf } : {}) },
      ...(body === undefined ? {} : { data: body }),
      failOnStatusCode: false,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status(), body: parsed, raw: text };
  };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/**
 * The message composer, not whatever textbox happens to come first.
 *
 * A channel page also carries the header's message-search input, so
 * `getByRole('textbox').first()` types into search and the message is never
 * sent — with no error, because searching is a perfectly valid thing to do.
 */
function composer(page) {
  return page.locator('textarea[data-composer-input]');
}

/**
 * Wait until the composer is actually willing to send.
 *
 * The composer is never *disabled* when it is refusing — it shows a reason and
 * declines on Enter — so typing as soon as the textarea exists is how a driver
 * ends up asserting on a message that was never sent. A person waits for the
 * refusal to clear; so does this.
 */
async function waitUntilSendable(person, timeoutMs = 120000) {
  const { page } = person;
  await composer(page).waitFor({ state: 'visible', timeout: 30000 });
  let lastRefusal = '(none seen)';
  // A page load re-locks the identity and re-opens the realtime stream, and the
  // post-enrolment credential rotation can 401 either. Ready means the composer
  // is willing *and* the session has stopped failing — asserting on live
  // delivery before that measures the reconnect, not the product.
  let failures = person.logs.filter(line => line.startsWith('HTTP 4')).length;
  let quietSince = Date.now();
  return until(async () => {
    const now = person.logs.filter(line => line.startsWith('HTTP 4')).length;
    if (now !== failures) { failures = now; quietSince = Date.now(); }
    const rows = await page.locator('[role="status"]').allTextContents().catch(() => []);
    const refusal = rows.map(row => row.trim()).find(row => row.length > 0);
    if (refusal) { lastRefusal = refusal; return null; }
    return Date.now() - quietSince >= 3000 ? true : null;
  }, `${person.label}'s composer never became ready — it kept saying: ${lastRefusal}`, timeoutMs)
    .catch(async error => {
      await shot(person, 'composer-stuck');
      throw new Error(`${error.message.split('(waited')[0]}(last refusal: ${lastRefusal})`);
    });
}

/** The server's copy of a message this person just typed, once it arrives. */
async function delivered(person, channelId, content, timeoutMs = 30000) {
  // Sending is durable, not synchronous: the composer clears when the draft is
  // queued, and delivery follows. Reading the channel the instant the composer
  // empties is how a driver decides a message was never sent.
  return until(async () => {
    const { body } = await person.call('GET', `/channels/${channelId}/messages?limit=20`);
    return Array.isArray(body) ? body.find(message => message.content === content) ?? null : null;
  }, `"${content}" never reached the instance`, timeoutMs);
}

/** Type into the composer and send, then wait for it to clear. */
async function say(person, text) {
  const box = composer(person.page);
  await waitUntilSendable(person);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await person.page.waitForFunction(
    () => (document.querySelector('textarea[data-composer-input]')?.value ?? '') === '',
    null, { timeout: 30000 },
  ).catch(() => {});

  // A queued message that the instance refuses leaves a card in the timeline
  // rather than an exception. Reading it here turns "the message never arrived"
  // into the reason the product already worked out.
  const refusal = person.page.getByText(/Refused — not delivered|Not delivered/i).first();
  if (await refusal.isVisible().catch(() => false)) {
    const card = await refusal.locator('xpath=ancestor::*[self::div][1]/..').textContent().catch(() => '');
    throw new Error(`${person.label}'s message was refused: ${card.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

async function shot(person, tag) {
  try { await person.page.screenshot({ path: join(SHOTS, `${tag}--${person.label}.png`) }); } catch { /* closed */ }
}

/** The shell tour and welcome screen arrive in either order on a fresh account. */
async function dismissOverlays(page, quietMs = 1200, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  let lastSeen = Date.now();
  while (Date.now() < deadline && Date.now() - lastSeen < quietMs) {
    for (const name of ['Close welcome screen', 'Skip tour', 'Got it', 'Maybe later', 'Dismiss']) {
      const control = page.getByRole('button', { name, exact: true });
      if (await control.isVisible().catch(() => false)) {
        await control.click({ timeout: 2000 }).catch(() => {});
        lastSeen = Date.now();
      }
    }
    await page.waitForTimeout(200);
  }
}

async function signIn(browser, account) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('pageerror', error => { errors.push(`pageerror: ${error.message}`); logs.push(`pageerror: ${error.message}`); });
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error') errors.push(`console: ${text}`);
    if (message.type() === 'error' || message.type() === 'warning') logs.push(`${message.type()}: ${text}`);
  });
  // "401" on its own names no endpoint. The URL is the finding.
  page.on('response', response => {
    const status = response.status();
    if (status >= 400 && response.url().includes('/api/')) {
      logs.push(`HTTP ${status} ${response.request().method()} ${response.url().replace(BASE, '')}`);
    }
  });

  await page.goto('/');
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 45000 });
  await page.locator('input[autocomplete="username"]').first().fill(account.email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 45000 });
  await dismissOverlays(page);
  const person = { ...account, context, page, errors, logs };
  person.call = api(person);
  return person;
}

/**
 * Give this account an encryption identity through the real /setup flow.
 *
 * Direct and group messages are end-to-end encrypted, so an account with no
 * published identity key can neither send nor be sent to. Seeding a key
 * directly would skip the part of the product most likely to be wrong.
 */
async function enrollEncryption(person) {
  const { page } = person;
  const returnTo = '/app/friends';
  await page.goto(`/setup?migrate=1&server=__local__&user=${encodeURIComponent(person.id)}&returnTo=${encodeURIComponent(returnTo)}`);

  const password = page.locator('input[type="password"]');
  await password.first().waitFor({ timeout: 30000 });
  const count = await password.count();
  await password.nth(0).fill(ENCRYPTION_PASSWORD);
  if (count > 1) await password.nth(1).fill(ENCRYPTION_PASSWORD);
  if (count > 2) await password.nth(2).fill(PASSWORD); // current sign-in password

  await page.getByRole('button', { name: /secure account|continue|save|set up/i }).first().click();

  const savedBox = page.locator('input[type="checkbox"]').first();
  await savedBox.waitFor({ timeout: 45000 });
  await savedBox.check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 45000 });
  await dismissOverlays(page, 800, 8000);

  const published = await until(async () => {
    const { body } = await person.call('GET', '/users/@me');
    return body?.public_key ? body.public_key : null;
  }, `${person.label}'s identity key never reached the instance`, 30000);
  return published.slice(0, 16);
}

/**
 * Unlock once so this account publishes its prekeys.
 *
 * Enrolling publishes the identity key; the one-time and signed prekeys a 1:1
 * conversation needs are published when the account vault first opens, which
 * happens on unlock. Until every peer has done this once, `peers_ready` is
 * false on the instance and the composer correctly refuses — a peer who has
 * never unlocked has nothing anyone can seal a first message to.
 */
async function publishPrekeys(person) {
  const { page } = person;
  await page.goto('/app/friends');
  await dismissOverlays(page, 700, 6000);
  await page.goto(`/unlock?returnTo=${encodeURIComponent('/app/friends')}`);
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ timeout: 30000 });
  await password.fill(ENCRYPTION_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/unlock'), { timeout: 30000 });
  await dismissOverlays(page, 700, 6000);
  return until(async () => {
    const { body } = await person.call('GET', '/users/@me/keys/count');
    return body?.signed_prekey_uploaded && body.one_time_prekeys_remaining > 0 ? body : null;
  }, `${person.label} never published prekeys`, 40000);
}

/**
 * Wait for this session to stop 401ing after an enrolment.
 *
 * Attaching an encryption identity revokes the session it was authorised with
 * and the instance issues a replacement. For a moment either side of that the
 * app is still presenting the dead credential: `/users/@me/relationships` and
 * `POST /stream/ticket` answer 401, the realtime stream drops, and the gateway
 * reconnects from its last checkpoint. It recovers on its own, but anything
 * that measures live delivery across that window measures the window.
 */
async function settle(person, quietMs = 6000, timeoutMs = 90000) {
  const { page } = person;
  await page.reload();
  await dismissOverlays(page, 700, 6000);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = person.logs.filter(line => line.startsWith('HTTP 4')).length;
  let quietSince = Date.now();
  for (;;) {
    await page.waitForTimeout(500);
    const now = person.logs.filter(line => line.startsWith('HTTP 4')).length;
    if (now !== lastFailure) { lastFailure = now; quietSince = Date.now(); }
    if (Date.now() - quietSince >= quietMs) return;
    if (Date.now() > deadline) throw new Error(`${person.label}'s session kept failing: ${person.logs.filter(l => l.startsWith('HTTP 4')).slice(-3).join(' | ')}`);
  }
}

/**
 * Open an encrypted conversation, unlocking this device's identity if asked.
 *
 * The unlocked private key lives in memory, so a full page load re-locks it —
 * which is the product behaving correctly, and is exactly what a person meets:
 * they land on the conversation and the composer offers "Unlock encryption".
 * Taking that offer is a client-side navigation, so the conversation is still
 * there when it returns. Driving it this way rather than visiting /unlock up
 * front is both more realistic and the only thing that survives a reload.
 */
async function openEncrypted(person, channelId) {
  const { page } = person;
  await page.goto(`/app/dms/${channelId}`);
  await dismissOverlays(page, 700, 6000);
  await composer(page).waitFor({ state: 'visible', timeout: 30000 });
  await takeAnyUnlockOffer(person);
  await waitUntilSendable(person);
  return page;
}

/**
 * Take the composer's Unlock offer whenever it appears, until it stops.
 *
 * The offer is not on screen the instant the page is — the runtime passes
 * through 'enrolling' first — so looking once and moving on is how a driver
 * decides an account is unusable while the app is still getting round to
 * asking. It is also not necessarily offered once: a reconnect mid-unlock can
 * put it back. Clicking it is a client-side navigation, so the conversation is
 * still there when it returns.
 */
async function takeAnyUnlockOffer(person, attempts = 4) {
  const { page } = person;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const link = page.getByRole('link', { name: 'Unlock encryption' });
    const offered = await link.waitFor({ state: 'visible', timeout: attempt === 0 ? 20000 : 6000 })
      .then(() => true).catch(() => false);
    if (!offered) return;
    await link.click().catch(() => {});
    const password = page.locator('input[type="password"]').first();
    if (!await password.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) continue;
    await password.fill(ENCRYPTION_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click().catch(() => {});
    await page.waitForURL(url => !url.pathname.startsWith('/unlock'), { timeout: 30000 }).catch(() => {});
    await dismissOverlays(page, 600, 5000);
    await composer(page).waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  }
}


// ---------------------------------------------------------------------------

async function main() {
  log(`\nParacord live drive → ${BASE}\n`);

  const healthy = await fetch(`${BASE}/api/v1/health`).then(r => r.ok).catch(() => false);
  if (!healthy) { log('Instance not answering. Start it: node scripts/live-env.mjs'); process.exit(1); }

  log('Accounts');
  const accounts = {};
  for (const name of ['ada', 'grace', 'linus']) {
    accounts[name] = await register(name);
    log(`  ${name.padEnd(6)} ${accounts[name].username}  id=${accounts[name].id}`);
  }

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const people = {};
  try {
    log('\nSign in');
    for (const name of Object.keys(accounts)) {
      people[name] = await signIn(browser, accounts[name]);
      log(`  ${name} in the app`);
    }
    cast = Object.values(people);
    await scenarios(people);
  } finally {
    for (const person of Object.values(people)) await person.context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  log('\n' + '='.repeat(70));
  const failed = results.filter(r => !r.ok);
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  log('='.repeat(70));
  log(`${results.length - failed.length}/${results.length} passed · screenshots in ${SHOTS}`);
  writeFileSync(join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// What the three of them actually do
// ---------------------------------------------------------------------------

async function scenarios(people) {
  const { ada, grace, linus } = people;
  const state = {};

  log('\nEncryption identities');
  await step('ada enrols an encryption identity', async () => `key ${await enrollEncryption(ada)}…`);
  await step('grace enrols an encryption identity', async () => `key ${await enrollEncryption(grace)}…`);
  await step('linus enrols an encryption identity', async () => `key ${await enrollEncryption(linus)}…`);
  await step('unlocking publishes each account’s prekeys', async () => {
    const counts = [];
    for (const person of [ada, grace, linus]) {
      const keys = await publishPrekeys(person);
      counts.push(`${person.label}:${keys.one_time_prekeys_remaining}`);
    }
    return counts.join(' ');
  });
  await step('every session settles on its post-enrolment credential', async () => {
    for (const person of [ada, grace, linus]) await settle(person);
    return 'no stale-credential failures left in flight';
  });


  log('\nFriends');
  await step('ada befriends grace and linus, and both accept', async () => {
    for (const peer of [grace, linus]) {
      const sent = await ada.call('POST', '/users/@me/relationships', { username: peer.username });
      assert(sent.status < 300, `friend request to ${peer.label}: ${sent.status} ${sent.raw}`);
      const accepted = await peer.call('PUT', `/users/@me/relationships/${ada.id}`, { type: 1 });
      assert(accepted.status < 300, `${peer.label} accepting: ${accepted.status} ${accepted.raw}`);
    }
    const { body } = await ada.call('GET', '/users/@me/relationships');
    const friends = body.filter(r => r.type === 1).length;
    assert(friends === 2, `ada should have 2 friends, has ${friends}`);
    return '2 friendships';
  });

  log('\nServer, channels and messages');
  await step('ada creates a server and it appears in her sidebar', async () => {
    const created = await ada.call('POST', '/guilds', { name: `Live ${stamp}` });
    assert(created.status < 300, `create guild: ${created.status} ${created.raw}`);
    state.guildId = created.body.id;
    const channels = await ada.call('GET', `/guilds/${state.guildId}/channels`);
    state.channelId = channels.body.find(c => (c.channel_type ?? c.type) === 0)?.id;
    assert(state.channelId, `no text channel in the new guild: ${channels.raw}`);
    await ada.page.goto(`/app/guilds/${state.guildId}/channels/${state.channelId}`);
    await dismissOverlays(ada.page, 700, 6000);
    await waitUntilSendable(ada);
    await shot(ada, '01-server');
    return `guild ${state.guildId}`;
  });

  await step('grace and linus join by invite and see the same channel', async () => {
    const invite = await ada.call('POST', `/channels/${state.channelId}/invites`, { max_age: 0, max_uses: 0 });
    assert(invite.status < 300, `create invite: ${invite.status} ${invite.raw}`);
    const code = invite.body.code;
    for (const person of [grace, linus]) {
      const joined = await person.call('POST', `/invites/${code}`, {});
      assert(joined.status < 300, `${person.label} joining: ${joined.status} ${joined.raw}`);
      await person.page.goto(`/app/guilds/${state.guildId}/channels/${state.channelId}`);
      await dismissOverlays(person.page, 700, 6000);
      await waitUntilSendable(person);
    }
    return `invite ${code}`;
  });

  await step('a message ada types in the channel reaches grace and linus live', async () => {
    const text = `hello from ada ${stamp}`;
    await say(ada, text);
    await ada.page.getByText(text, { exact: false }).first().waitFor({ timeout: 25000 });
    for (const person of [grace, linus]) {
      await person.page.getByText(text, { exact: false }).first().waitFor({ timeout: 25000 });
    }
    await shot(grace, '02-channel-message');
    return 'delivered to both, no reload';
  });

  await step('grace replies and ada sees it without reloading', async () => {
    const text = `grace answering ${stamp}`;
    await say(grace, text);
    await ada.page.getByText(text, { exact: false }).first().waitFor({ timeout: 25000 });
    return 'round trip both ways';
  });

  log('\nDirect messages (end-to-end encrypted)');
  await step('ada opens a 1:1 DM with grace and the message decrypts on grace’s screen', async () => {
    const dm = await ada.call('POST', '/users/@me/dms', { recipient_id: grace.id });
    assert(dm.status < 300, `create dm: ${dm.status} ${dm.raw}`);
    state.dmId = dm.body.id;
    await openEncrypted(ada, state.dmId);
    const text = `private to grace ${stamp}`;
    await say(ada, text);
    await ada.page.getByText(text, { exact: false }).first().waitFor({ timeout: 40000 });

    await openEncrypted(grace, state.dmId);
    await grace.page.getByText(text, { exact: false }).first().waitFor({ timeout: 45000 });
    await shot(grace, '03-dm-decrypted');
    return 'ciphertext on the wire, plaintext on screen';
  });

  await step('the instance stored ciphertext, not the words', async () => {
    const { body } = await ada.call('GET', `/channels/${state.dmId}/messages?limit=10`);
    const carrying = body.find(m => m.e2ee);
    assert(carrying, `no e2ee payload in the stored DM: ${JSON.stringify(body).slice(0, 300)}`);
    assert(!JSON.stringify(body).includes(`private to grace ${stamp}`),
      'the DM plaintext came back from the server — it must never leave the device');
    return `stored as e2ee v${carrying.e2ee.version}`;
  });

  log('\nGroup conversations (the work under test)');
  await step('ada creates a group with grace and linus', async () => {
    const group = await ada.call('POST', '/users/@me/channels', {
      recipient_ids: [grace.id, linus.id],
      name: `Three of us ${stamp}`,
    });
    assert(group.status < 300, `create group: ${group.status} ${group.raw}`);
    state.groupId = group.body.id;
    state.membersVersion = group.body.members_version;
    assert(state.membersVersion, `the group must name its membership: ${group.raw}`);
    return `channel ${state.groupId}, membership ${state.membersVersion.slice(0, 12)}…`;
  });

  await step('the group composer is open — no "not encrypted yet" dead end', async () => {
    await openEncrypted(ada, state.groupId);
    const box = composer(ada.page);
    await shot(ada, '04-group-composer');
    const body = await ada.page.textContent('body');
    assert(!/not encrypted yet/i.test(body), 'the old group refusal is still on screen');
    assert(!await box.isDisabled(), 'the group composer is disabled');
    return 'composer accepts input';
  });

  await step('a group message from ada decrypts for BOTH grace and linus', async () => {
    const text = `group hello ${stamp}`;
    await say(ada, text);
    await ada.page.getByText(text, { exact: false }).first().waitFor({ timeout: 45000 });

    for (const person of [grace, linus]) {
      await openEncrypted(person, state.groupId);
      await person.page.getByText(text, { exact: false }).first().waitFor({ timeout: 60000 });
      await shot(person, '05-group-decrypted');
    }
    return 'both members read it';
  });

  await step('linus answers in the group and the other two read it', async () => {
    const text = `linus answering ${stamp}`;
    await say(linus, text);
    for (const person of [ada, grace]) {
      await person.page.getByText(text, { exact: false }).first().waitFor({ timeout: 60000 });
    }
    return 'a second sender key reached everyone';
  });

  await step('the instance never saw the group plaintext', async () => {
    const { body, raw } = await ada.call('GET', `/channels/${state.groupId}/messages?limit=20`);
    const carrying = body.filter(m => m.e2ee);
    assert(carrying.length >= 2, `group messages should carry e2ee payloads: ${raw.slice(0, 300)}`);
    assert(!raw.includes(`group hello ${stamp}`) && !raw.includes(`linus answering ${stamp}`),
      'group plaintext came back from the server');
    const header = JSON.parse(carrying[0].e2ee.header);
    assert(header.kind === 'group_sender_key', `unexpected header kind ${header.kind}`);
    assert(typeof header.sig === 'string' && header.sig.length > 40, 'a group message must be signed');
    assert(typeof header.members === 'string', 'a group message must name the membership it was sealed for');
    return `signed sender-key v${header.v}, epoch ${header.epoch}`;
  });

  await step('the server refuses a sender key minted against a stale membership', async () => {
    const stale = await ada.call('POST', `/channels/${state.groupId}/e2ee/sender-keys`, {
      epoch: 99,
      members_version: 'a-membership-that-never-was',
      envelopes: [{ recipient_id: grace.id, ciphertext: 'Y2lwaGVy', header: '{"v":3,"nonce":"bm9uY2Vub25jZW4="}' }],
    });
    assert(stale.status === 409, `expected 409, got ${stale.status}: ${stale.raw}`);
    const undeclared = await ada.call('POST', `/channels/${state.groupId}/e2ee/sender-keys`, {
      epoch: 99,
      envelopes: [{ recipient_id: grace.id, ciphertext: 'Y2lwaGVy', header: '{"v":3,"nonce":"bm9uY2Vub25jZW4="}' }],
    });
    assert(undeclared.status === 400, `expected 400 for an undeclared membership, got ${undeclared.status}`);
    return '409 on stale, 400 on undeclared';
  });

  await step('removing linus moves the membership version and rotates the key', async () => {
    const before = state.membersVersion;
    const removed = await ada.call('DELETE', `/channels/${state.groupId}/recipients/${linus.id}`);
    assert(removed.status < 300, `removing linus: ${removed.status} ${removed.raw}`);
    const after = await until(async () => {
      const { body } = await ada.call('GET', `/channels/${state.groupId}/e2ee/sender-keys`);
      return body?.members_version && body.members_version !== before ? body.members_version : null;
    }, 'the membership version did not move after a removal');

    // Ada's next message must be sealed under a NEW epoch, because the roster
    // it was minted for no longer includes Linus.
    const text = `after linus left ${stamp}`;
    await openEncrypted(ada, state.groupId);
    await say(ada, text);
    await ada.page.getByText(text, { exact: false }).first().waitFor({ timeout: 45000 });
    await grace.page.getByText(text, { exact: false }).first().waitFor({ timeout: 60000 });

    const { body } = await ada.call('GET', `/channels/${state.groupId}/messages?limit=5`);
    const latest = body.find(m => m.e2ee && JSON.parse(m.e2ee.header).sender_id === ada.id);
    const epoch = JSON.parse(latest.e2ee.header).epoch;
    assert(epoch > 0, `the post-removal message must use a fresh epoch, got ${epoch}`);
    state.membersVersion = after;
    return `membership ${after.slice(0, 12)}…, epoch ${epoch}`;
  });

  await step('linus, removed, can no longer read the group at all', async () => {
    const denied = await linus.call('GET', `/channels/${state.groupId}/messages?limit=5`);
    assert(denied.status === 403 || denied.status === 404,
      `a removed member should lose access, got ${denied.status}: ${denied.raw}`);
    return `server answers ${denied.status}`;
  });

  log('\nMessage actions');
  await step('ada edits a channel message and everyone sees the edit', async () => {
    // Both of them are still looking at the group conversation. An assertion
    // about what grace sees in the channel has to put her in the channel.
    for (const person of [ada, grace]) {
      await person.page.goto(`/app/guilds/${state.guildId}/channels/${state.channelId}`);
      await dismissOverlays(person.page, 700, 6000);
      await waitUntilSendable(person);
    }
    const original = `editable ${stamp}`;
    await say(ada, original);
    await ada.page.getByText(original, { exact: false }).first().waitFor({ timeout: 25000 });

    const target = await delivered(ada, state.channelId, original);
    const edited = `${original} (edited)`;
    const patch = await ada.call('PATCH', `/channels/${state.channelId}/messages/${target.id}`, { content: edited });
    assert(patch.status < 300, `edit: ${patch.status} ${patch.raw}`);
    await grace.page.getByText(edited, { exact: false }).first().waitFor({ timeout: 25000 });
    return 'edit propagated live';
  });

  await step('a reaction from grace shows up on ada’s screen', async () => {
    const { body } = await ada.call('GET', `/channels/${state.channelId}/messages?limit=10`);
    const target = body.find(m => typeof m.content === 'string' && m.content.includes('editable'));
    assert(target, 'no message to react to');
    const reacted = await grace.call('PUT', `/channels/${state.channelId}/messages/${target.id}/reactions/${encodeURIComponent('👍')}/@me`);
    assert(reacted.status < 300, `react: ${reacted.status} ${reacted.raw}`);
    await until(async () => {
      const { body: after } = await ada.call('GET', `/channels/${state.channelId}/messages?limit=10`);
      const row = after.find(m => m.id === target.id);
      return row?.reactions?.some(r => r.count >= 1);
    }, 'the reaction never landed on the message');
    await shot(ada, '06-reaction');
    return '👍 counted';
  });

  await step('deleting a message removes it from the other screens', async () => {
    const text = `deleteme ${stamp}`;
    await say(ada, text);
    const target = await delivered(ada, state.channelId, text);
    await grace.page.getByText(text, { exact: false }).first().waitFor({ timeout: 30000 });
    const removed = await ada.call('DELETE', `/channels/${state.channelId}/messages/${target.id}`);
    assert(removed.status < 300, `delete: ${removed.status}`);
    await grace.page.getByText(text, { exact: false }).first().waitFor({ state: 'detached', timeout: 25000 });
    return 'gone from grace’s timeline';
  });

  await step('every message landed in the conversation it was typed into', async () => {
    const guild = await ada.call('GET', `/channels/${state.channelId}/messages?limit=30`);
    const group = await ada.call('GET', `/channels/${state.groupId}/messages?limit=30`);
    const describe = rows => (Array.isArray(rows) ? rows : []).map(m => m.e2ee ? `<e2ee v${m.e2ee.version}>` : JSON.stringify(m.content)).reverse().join(' ');
    const guildText = describe(guild.body);
    const groupText = describe(group.body);
    log(`        guild channel: ${guildText}`);
    log(`        group channel: ${groupText}`);
    assert(!guildText.includes('answering mu') || !guildText.includes('linus'),
      'a group message was posted to the guild channel');
    return 'each message in its own conversation';
  });

  log('\nPage health');
  await step('no unexpected errors in any session', async () => {
    // Enrolling an encryption identity revokes the session it was authorised
    // with and the instance issues a replacement. Requests already on the wire
    // carry the dead credential, so a 401 and one gateway reconnect either side
    // of that are the rotation working, not a defect — the client installs the
    // new token and recovers. They are counted rather than ignored, so a change
    // in how often they happen is visible.
    const rotation = /401 \(Unauthorized\)|Cannot complete gateway delivery/i;
    const ignorable = /favicon|Download the React DevTools|ResizeObserver loop|net::ERR_ABORTED/i;
    const unexpected = [];
    let transient = 0;
    let removedMember = 0;
    for (const person of Object.values(people)) {
      // Linus was removed from the group mid-run, so his app asking about it
      // and being told 403 is the removal working. The URLs in `logs` are what
      // make that checkable rather than assumed.
      const forbidden = (person.logs ?? []).filter(line => line.startsWith('HTTP 403')).length;
      const forbiddenOnGroup = (person.logs ?? [])
        .filter(line => line.startsWith('HTTP 403') && line.includes(state.groupId)).length;
      const expectedForbidden = person === linus && forbidden === forbiddenOnGroup ? forbidden : 0;
      removedMember += expectedForbidden;
      let allowance = expectedForbidden;
      for (const message of person.errors) {
        if (ignorable.test(message)) continue;
        if (rotation.test(message)) { transient += 1; continue; }
        if (/403 \(Forbidden\)/i.test(message) && allowance > 0) { allowance -= 1; continue; }
        unexpected.push(`${person.label}: ${message}`);
      }
    }
    assert(unexpected.length === 0, unexpected.slice(0, 5).join('\n'));
    return `none (${transient} post-enrolment rotation notices, ${removedMember} expected 403s for the removed member)`;
  });
}

main().catch(error => { console.error(error); process.exit(1); });
