#!/usr/bin/env node
// A focused look at one encrypted conversation, for when the full drive says
// "the message never arrived" and the question is why.
//
// It stops at the composer and reports what the product is actually showing —
// the blocker row, the header state, the queued outbox — instead of timing out
// on an assertion.

import { chromium } from '@playwright/test';

const BASE = `http://127.0.0.1:${process.env.PARACORD_LIVE_PORT ?? '18420'}`;
const PASSWORD = 'Live-Drive-Password-123!';
const ENCRYPTION_PASSWORD = 'live drive encryption password';
const stamp = Date.now().toString(36);

async function register(name) {
  const username = `${name}${stamp}`.slice(0, 32);
  const email = `${name}-${stamp}@example.test`;
  const r = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password: PASSWORD }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body));
  return { label: name, username, email, id: body.user.id, token: body.token };
}

async function login(account) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: PASSWORD }),
  });
  account.token = (await r.json()).token;
}

const call = (a) => async (method, path, body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, raw: text };
};

async function dismiss(page) {
  for (let i = 0; i < 12; i++) {
    for (const name of ['Close welcome screen', 'Skip tour', 'Got it', 'Maybe later']) {
      const c = page.getByRole('button', { name, exact: true });
      if (await c.isVisible().catch(() => false)) await c.click().catch(() => {});
    }
    await page.waitForTimeout(200);
  }
}

const main = async () => {
  const browser = await chromium.launch({ headless: true });
  const ada = await register('probe-ada');
  const bob = await register('probe-bob');

  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', r => errors.push(`requestfailed: ${r.method()} ${r.url()}`));

  // Sign in
  await page.goto('/');
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 45000 });
  await page.locator('input[autocomplete="username"]').first().fill(ada.email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 45000 });
  await dismiss(page);

  // Enroll
  await page.goto(`/setup?migrate=1&server=__local__&user=${ada.id}&returnTo=${encodeURIComponent('/app/friends')}`);
  const pw = page.locator('input[type="password"]');
  await pw.first().waitFor({ timeout: 30000 });
  const n = await pw.count();
  await pw.nth(0).fill(ENCRYPTION_PASSWORD);
  if (n > 1) await pw.nth(1).fill(ENCRYPTION_PASSWORD);
  if (n > 2) await pw.nth(2).fill(PASSWORD);
  await page.getByRole('button', { name: /secure account|continue|save|set up/i }).first().click();
  const box = page.locator('input[type="checkbox"]').first();
  await box.waitFor({ timeout: 45000 });
  await box.check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 45000 });
  await dismiss(page);
  await login(ada);

  console.log('ada  public_key:', (await call(ada)('GET', '/users/@me')).body?.public_key?.slice(0, 20));

  // Bob gets a real browser and a real enrollment too: `peers_ready` is about
  // him, so a probe where he never enrolled only ever proves that.
  const bobContext = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const bobPage = await bobContext.newPage();
  const bobErrors = [];
  bobPage.on('pageerror', e => bobErrors.push(`pageerror: ${e.message}`));
  bobPage.on('console', m => { const t = m.text(); if (m.type() === 'error' || /\[probe\]|e2ee|encrypt|decrypt|group|sender.key/i.test(t)) bobErrors.push(`${m.type()}: ${t}`); });
  await bobPage.goto('/');
  await bobPage.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 45000 });
  await bobPage.locator('input[autocomplete="username"]').first().fill(bob.email);
  await bobPage.locator('input[type="password"]').first().fill(PASSWORD);
  await bobPage.getByRole('button', { name: 'Log in', exact: true }).click();
  await bobPage.waitForURL(/\/app(\/|$)/, { timeout: 45000 });
  await dismiss(bobPage);
  await bobPage.goto(`/setup?migrate=1&server=__local__&user=${bob.id}&returnTo=${encodeURIComponent('/app/friends')}`);
  const bpw = bobPage.locator('input[type="password"]');
  await bpw.first().waitFor({ timeout: 30000 });
  const bn = await bpw.count();
  await bpw.nth(0).fill(ENCRYPTION_PASSWORD);
  if (bn > 1) await bpw.nth(1).fill(ENCRYPTION_PASSWORD);
  if (bn > 2) await bpw.nth(2).fill(PASSWORD);
  await bobPage.getByRole('button', { name: /secure account|continue|save|set up/i }).first().click();
  const bbox = bobPage.locator('input[type="checkbox"]').first();
  await bbox.waitFor({ timeout: 45000 });
  await bbox.check();
  await bobPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await bobPage.waitForURL(/\/app(\/|$)/, { timeout: 45000 });
  await dismiss(bobPage);
  await login(bob);
  console.log('bob  public_key:', (await call(bob)('GET', '/users/@me')).body?.public_key?.slice(0, 20));

  await call(ada)('POST', '/users/@me/relationships', { username: bob.username });
  await call(bob)('PUT', `/users/@me/relationships/${ada.id}`, { type: 1 });

  // Prekeys are published when the account vault opens, which happens on
  // unlock — so let bob sit in the app with his identity unlocked for a moment.
  await bobPage.goto('/app/friends');
  await dismiss(bobPage);
  const bobUnlock = bobPage.getByRole('link', { name: 'Unlock encryption' });
  if (await bobUnlock.isVisible().catch(() => false)) await bobUnlock.click();
  const bobPw = bobPage.locator('input[type="password"]').first();
  if (await bobPw.isVisible().catch(() => false)) {
    await bobPw.fill(ENCRYPTION_PASSWORD);
    await bobPage.getByRole('button', { name: 'Unlock', exact: true }).click();
    await bobPage.waitForTimeout(3000);
  }
  const bobKeys = await call(bob)('GET', '/users/@me/keys/count');
  console.log('bob  prekeys:', bobKeys.status, bobKeys.raw.slice(0, 160));

  const target = process.env.PROBE_GROUP
    ? await call(ada)('POST', '/users/@me/channels', { recipient_ids: [bob.id], name: `Probe group ${stamp}` })
    : await call(ada)('POST', '/users/@me/dms', { recipient_id: bob.id });
  console.log('channel create:', target.status, JSON.stringify(target.body).slice(0, 220));
  const channelId = target.body.id;

  await page.goto(`/app/dms/${channelId}`);
  await dismiss(page);
  await page.waitForTimeout(3000);

  const unlock = page.getByRole('link', { name: 'Unlock encryption' });
  if (await unlock.isVisible().catch(() => false)) {
    console.log('composer offered Unlock — taking it');
    await unlock.click();
    const p2 = page.locator('input[type="password"]').first();
    await p2.waitFor({ timeout: 30000 });
    await p2.fill(ENCRYPTION_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.waitForURL(u => !u.pathname.startsWith('/unlock'), { timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  const composer = page.locator('textarea[data-composer-input]');
  const blocker = page.locator('[role="status"]');
  console.log('\n--- composer state ---');
  console.log('visible :', await composer.isVisible().catch(() => 'n/a'));
  console.log('disabled:', await composer.isDisabled().catch(() => 'n/a'));
  const blockers = await blocker.allTextContents().catch(() => []);
  console.log('status rows:', JSON.stringify(blockers, null, 2));
  console.log('header  :', (await page.locator('.chat-header').textContent().catch(() => '')).trim().slice(0, 160));

  // Capability probe, straight from the instance.
  const caps = await call(ada)('GET', `/channels/${channelId}/capabilities`);
  console.log('\n--- instance capabilities ---');
  console.log(JSON.stringify(caps.body, null, 2).slice(0, 900));

  // Try to send and see what happens.
  if (await composer.isVisible().catch(() => false)) {
    await composer.click();
    await composer.fill(`probe ${stamp}`);
    await composer.press('Enter');
    await page.waitForTimeout(6000);
    console.log('\n--- after pressing Enter ---');
    console.log('composer value:', JSON.stringify(await composer.inputValue().catch(() => 'n/a')));
    console.log('status rows  :', JSON.stringify(await blocker.allTextContents().catch(() => [])));
    const stored = await call(ada)('GET', `/channels/${channelId}/messages?limit=5`);
    console.log('stored count :', stored.status, Array.isArray(stored.body) ? stored.body.length : 'n/a');
    for (const m of stored.body ?? []) {
      console.log('  stored e2ee:', m.e2ee ? `v${m.e2ee.version} header=${String(m.e2ee.header).slice(0, 110)}` : '(none)',
        '| content:', JSON.stringify(m.content));
    }
    await page.waitForTimeout(6000);
    const timeline = await page.locator('[data-testid="message-list"], main').first().textContent().catch(() => '');
    console.log('\n--- what the sender sees ---');
    console.log(timeline.replace(/\s+/g, ' ').slice(0, 500));

    // The whole point: can the OTHER member read it?
    console.log('\n--- what the recipient sees ---');
    await bobPage.goto(`/app/dms/${channelId}`);
    await dismiss(bobPage);
    // The runtime passes through 'enrolling' before it settles on 'locked', so
    // the Unlock link is not on screen the instant the page is. Checking once,
    // immediately, is how a driver concludes "no unlock offered" about a
    // conversation that was about to offer one.
    const bobUnlock2 = bobPage.getByRole('link', { name: 'Unlock encryption' });
    await bobUnlock2.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    console.log('unlock offered to recipient:', await bobUnlock2.isVisible().catch(() => false));
    console.log('recipient blocker        :', JSON.stringify(await bobPage.locator('[role="status"]').allTextContents().catch(() => [])));
    if (await bobUnlock2.isVisible().catch(() => false)) {
      await bobUnlock2.click();
      const p3 = bobPage.locator('input[type="password"]').first();
      await p3.waitFor({ timeout: 30000 });
      await p3.fill(ENCRYPTION_PASSWORD);
      await bobPage.getByRole('button', { name: 'Unlock', exact: true }).click();
      await bobPage.waitForURL(u => !u.pathname.startsWith('/unlock'), { timeout: 30000 });
    }
    await bobPage.waitForTimeout(25000);
    const bobTimeline = await bobPage.locator('[data-testid="message-list"], main').first().textContent().catch(() => '');
    console.log(bobTimeline.replace(/\s+/g, ' ').slice(0, 600));
    console.log('recipient can read it:', bobTimeline.includes(`probe ${stamp}`));
    const bobKeysSeen = await call(bob)('GET', `/channels/${channelId}/e2ee/sender-keys`);
    console.log('sender keys bob can fetch:', bobKeysSeen.status, bobKeysSeen.raw.slice(0, 200));
    const bobDms = await call(bob)('GET', '/users/@me/dms');
    console.log('recipient channel view:', bobDms.status, JSON.stringify(
      (bobDms.body ?? []).map(c => ({ id: c.id, type: c.channel_type, members_version: c.members_version,
        recipients: (c.recipients ?? []).map(r => ({ id: r.id, key: r.public_key ? 'yes' : 'NO' })) }))));
    console.log('\n--- recipient console ---');
    console.log(bobErrors.slice(-30).join('\n') || '(none)');
    await bobPage.screenshot({ path: '/tmp/paracord-live/probe-recipient.png' });
  }

  await page.screenshot({ path: '/tmp/paracord-live/probe-composer.png' });
  console.log('\n--- page errors ---');
  console.log(errors.slice(0, 25).join('\n') || '(none)');

  await browser.close();
};

main().catch(e => { console.error(e); process.exit(1); });
