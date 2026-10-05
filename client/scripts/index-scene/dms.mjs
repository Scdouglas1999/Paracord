// Direct messages are end to end encrypted, so the scene's DMs cannot be posted
// through the REST API the way channel messages are: the client seals them. This
// drives the real pages, once, for the four people the DMs involve: sign in,
// enroll an encryption identity through /setup, unlock once so the prekeys are
// published, befriend, and type each line into its author's own composer.
// (client/scripts/live-drive.mjs does the same for its own accounts; the steps
// and the hard-won waits below are its.)
//
// Enrolling an identity revokes every other session of the account, so the REST
// tokens are renewed afterwards (`refreshTokens`).

import { launchBrowser, openAs, dismissOverlays } from '../scene-lib/ui.mjs';
import { openPersistentSession } from './ui.mjs';
import { DMS, ENCRYPTION_PASSWORD } from './scene.mjs';
import { refreshTokens } from './seed.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const composerOf = page => page.locator('textarea[data-composer-input]');

async function until(fn, message, timeoutMs = 30_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error.message; }
    if (Date.now() > deadline) throw new Error(`${message} (waited ${timeoutMs}ms; last: ${JSON.stringify(last)})`);
    await sleep(intervalMs);
  }
}

/** Give this account an encryption identity through the real /setup flow. */
async function enroll(session, uiPassword) {
  const { page, person } = session;
  const returnTo = '/app/friends';
  await page.goto(`/setup?migrate=1&server=__local__&user=${encodeURIComponent(person.id)}&returnTo=${encodeURIComponent(returnTo)}`);
  const password = page.locator('input[type="password"]');
  await password.first().waitFor({ timeout: 30_000 });
  const count = await password.count();
  await password.nth(0).fill(ENCRYPTION_PASSWORD);
  if (count > 1) await password.nth(1).fill(ENCRYPTION_PASSWORD);
  if (count > 2) await password.nth(2).fill(uiPassword); // the current sign-in password
  await page.getByRole('button', { name: /secure account|continue|save|set up/i }).first().click();
  const saved = page.locator('input[type="checkbox"]').first();
  await saved.waitFor({ timeout: 45_000 });
  await saved.check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 45_000 });
  await dismissOverlays(page, 800, 8000);
}

/** Unlock once so this account publishes its prekeys (a peer with none cannot be written to). */
async function publishPrekeys(session) {
  const { page } = session;
  await page.goto('/app/friends');
  await dismissOverlays(page, 700, 6000);
  await page.goto(`/unlock?returnTo=${encodeURIComponent('/app/friends')}`);
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ timeout: 30_000 });
  await password.fill(ENCRYPTION_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/unlock'), { timeout: 30_000 });
  await dismissOverlays(page, 700, 6000);
}

/** Take the composer's "Unlock encryption" offer whenever it appears, until it stops. */
export async function takeAnyUnlockOffer(page, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const link = page.getByRole('link', { name: 'Unlock encryption' });
    const offered = await link.waitFor({ state: 'visible', timeout: attempt === 0 ? 20_000 : 6000 }).then(() => true).catch(() => false);
    if (!offered) return;
    await link.click().catch(() => {});
    const password = page.locator('input[type="password"]').first();
    if (!await password.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) continue;
    await password.fill(ENCRYPTION_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click().catch(() => {});
    await page.waitForURL(url => !url.pathname.startsWith('/unlock'), { timeout: 30_000 }).catch(() => {});
    await dismissOverlays(page, 600, 5000);
    await composerOf(page).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  }
}

/** The composer is never disabled when it refuses; it shows a reason. Wait for it to stop. */
async function waitUntilSendable(session, timeoutMs = 120_000) {
  const { page, logs } = session;
  await composerOf(page).waitFor({ state: 'visible', timeout: 30_000 });
  let failures = logs.filter(line => line.includes('401')).length;
  let quietSince = Date.now();
  let lastRefusal = '(none seen)';
  await until(async () => {
    const now = logs.filter(line => line.includes('401')).length;
    if (now !== failures) { failures = now; quietSince = Date.now(); }
    const rows = await page.locator('[role="status"]').allTextContents().catch(() => []);
    const refusal = rows.map(row => row.trim()).find(row => row.length > 0);
    if (refusal) { lastRefusal = refusal; return null; }
    return Date.now() - quietSince >= 2000 ? true : null;
  }, `${session.person.name}'s composer never became ready (last refusal: ${lastRefusal})`, timeoutMs);
}

async function openDm(session, channelId) {
  const { page } = session;
  if (!page.url().endsWith(`/app/dms/${channelId}`)) await page.goto(`/app/dms/${channelId}`);
  await dismissOverlays(page, 700, 6000);
  await composerOf(page).waitFor({ state: 'visible', timeout: 30_000 });
  await takeAnyUnlockOffer(page);
  await waitUntilSendable(session);
}

async function say(api, session, channelId, text) {
  const before = (await api.request(session.person.token, 'GET', `/channels/${channelId}/messages?limit=50`)).length;
  await openDm(session, channelId);
  const box = composerOf(session.page);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await until(async () => {
    const rows = await api.request(session.person.token, 'GET', `/channels/${channelId}/messages?limit=50`);
    return rows.length > before;
  }, `"${text}" from ${session.person.name} never reached the instance`, 45_000);
}

/** Sean's DM channels, by the other person's key. */
export async function findDms(api, people) {
  const rows = await api.request(people.sean.token, 'GET', '/users/@me/dms');
  const byKey = {};
  for (const dm of Array.isArray(rows) ? rows : []) {
    const other = String(dm.recipient?.id ?? '');
    for (const entry of DMS) {
      if (other === people[entry.with].id) byKey[entry.with] = String(dm.id);
    }
  }
  return byKey;
}

/** All three conversations exist and hold every line. */
export async function dmsComplete(api, people) {
  const dms = await findDms(api, people);
  for (const entry of DMS) {
    const id = dms[entry.with];
    if (!id) return { complete: false, dms };
    const rows = await api.request(people.sean.token, 'GET', `/channels/${id}/messages?limit=50`);
    if ((Array.isArray(rows) ? rows.length : 0) < entry.lines.length) return { complete: false, dms };
  }
  return { complete: true, dms };
}

export async function seedDirectMessages({ api, uiBase, people, profileDir, log = () => {}, headless = true }) {
  const involved = ['sean', ...DMS.map(d => d.with)];
  const browser = await launchBrowser({ headless });
  const sessions = {};
  try {
    log('\nDirect messages (end to end encrypted: typed into each person’s own composer)');
    for (const key of involved) {
      // Sean is the viewer's device: his identity must outlive this browser.
      sessions[key] = key === 'sean'
        ? await openPersistentSession(uiBase, people[key], { profileDir, headless, viewport: { width: 1280, height: 800 } })
        : await openAs(browser, uiBase, people[key], { viewport: { width: 1280, height: 800 }, log: () => {} });
      const me = await api.request(people[key].token, 'GET', '/users/@me');
      if (!me.public_key) {
        await enroll(sessions[key], people[key].password);
        log(`  ${people[key].name} enrolled an encryption identity`);
      }
    }
    // Tokens from before enrollment are revoked.
    await refreshTokens(api, people, involved);
    for (const key of involved) {
      const keys = await api.request(people[key].token, 'GET', '/users/@me/keys/count').catch(() => null);
      if (!(keys?.signed_prekey_uploaded && keys.one_time_prekeys_remaining > 0)) {
        await publishPrekeys(sessions[key]);
        await until(async () => {
          const body = await api.request(people[key].token, 'GET', '/users/@me/keys/count');
          return body?.signed_prekey_uploaded && body.one_time_prekeys_remaining > 0;
        }, `${people[key].name} never published prekeys`, 40_000);
        log(`  ${people[key].name} published prekeys`);
      }
    }

    // Friends: the real way to be allowed to write.
    for (const entry of DMS) {
      const peer = people[entry.with];
      const existing = await api.request(people.sean.token, 'GET', '/users/@me/relationships');
      if (Array.isArray(existing) && existing.some(r => r.type === 1 && String(r.user?.id ?? r.id) === peer.id)) continue;
      await api.request(people.sean.token, 'POST', '/users/@me/relationships', { username: peer.username });
      await api.request(peer.token, 'PUT', `/users/@me/relationships/${people.sean.id}`, { type: 1 });
    }

    const have = await findDms(api, people);
    for (const entry of DMS) {
      let id = have[entry.with];
      if (!id) {
        const created = await api.request(people.sean.token, 'POST', '/users/@me/dms', { recipient_id: people[entry.with].id });
        id = String(created.id);
      }
      const existing = await api.request(people.sean.token, 'GET', `/channels/${id}/messages?limit=50`);
      for (const [index, [who, text]] of entry.lines.entries()) {
        if (index < existing.length) continue; // already said, on a run that was interrupted
        await say(api, sessions[who], id, text);
      }
      log(`  ${people[entry.with].name}: ${entry.lines.map(([who]) => people[who].name[0]).join('')} (${entry.lines.length} lines)`);
    }

    const dms = await findDms(api, people);
    return dms;
  } finally {
    for (const session of Object.values(sessions)) await session.context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Everything said is read, as in the reference (no unread dot on People). Idempotent. */
export async function readAllDms(api, people) {
  const dms = await findDms(api, people);
  for (const id of Object.values(dms)) {
    const [latest] = await api.request(people.sean.token, 'GET', `/channels/${id}/messages?limit=1`);
    if (latest) await api.request(people.sean.token, 'PUT', `/channels/${id}/read`, { last_message_id: String(latest.id) });
  }
  return dms;
}
