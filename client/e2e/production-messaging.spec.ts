import { expect, test, type Browser, type Page, type PlaywrightTestArgs } from '@playwright/test';

type Playwright = PlaywrightTestArgs['playwright'];
const server = 'http://127.0.0.1:18160';
const password = 'Durable-Server-Password-123!';
const encryptionPassword = 'Separate-Encryption-Password-123!';
let clients = 0;
/** Each account is a distinct client: one shared address would share the
 *  server's abuse-control bucket and rate-limit the later accounts. */
function clientAddress() { clients += 1; return `10.90.${Math.floor(clients / 250)}.${(clients % 250) + 1}`; }
async function account(browser: Browser, playwright: Playwright, name: string) {
  const address = clientAddress();
  const register = await playwright.request.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': address } });
  const email = `${name}-${Date.now()}@example.test`;
  const response = await register.post(`${server}/api/v1/auth/register`, { data: { email, username: `${name}${Date.now()}`, password } });
  expect(response.status(), await response.text()).toBe(201);
  const credentials = await response.json(); await register.dispose();
  const api = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${credentials.token}`, 'X-Forwarded-For': address } });
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': address } }); const page = await context.newPage();
  if (process.env.PARACORD_E2E_DEBUG) {
    page.on('console', message => console.log(`[${name}:${message.type()}]`, message.text()));
    page.on('response', response => { if (response.status() >= 400) console.log(`[${name}:http]`, response.status(), response.url()); });
    page.on('response', response => { if (/\/(rt\/events|rt\/session|stream\/ticket|messages\/recovery)/.test(response.url())) console.log(`[${name}:rt]`, new Date().toISOString(), response.status(), response.url().slice(0, 120)); });
  }
  await page.goto('http://127.0.0.1:4174/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
  return { context, page, api, user: credentials.user, email };
}
async function dismiss(page: Page) {
  for (const name of ['Skip tour', 'Jump in', 'Close welcome screen']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
  }
}
async function setup(page: Page, id: string, returnTo: string) {
  await page.goto(`http://127.0.0.1:4174/setup?${new URLSearchParams({ migrate: '1', server: '__local__', user: id, returnTo })}`);
  await page.getByLabel('New encryption password', { exact: false }).fill(encryptionPassword);
  await page.getByLabel('Confirm password', { exact: false }).fill(encryptionPassword);
  await page.getByLabel('Current sign-in password', { exact: false }).fill(password);
  await page.getByRole('button', { name: 'Secure account' }).click();
  await expect(page.getByRole('heading', { name: 'Recovery phrase' }).or(page.getByRole('alert'))).toBeVisible();
  if (await page.getByRole('alert').isVisible()) throw new Error(await page.getByRole('alert').innerText());
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(returnTo));
  await expect(page.getByRole('button', { name: 'Skip tour', exact: true })).toBeVisible(); await dismiss(page);

}
/** Attaching a device identity revokes earlier sessions, so read-back needs a fresh login. */
async function signIn(playwright: Playwright, email: string) {
  const address = clientAddress();
  const context = await playwright.request.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': address } });
  const response = await context.post(`${server}/api/v1/auth/login`, { data: { email, password } });
  expect(response.status(), await response.text()).toBe(200);
  const token = (await response.json()).token as string;
  await context.dispose();
  return playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': address } });
}
async function localStorageText(page: Page) { return page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage)))); }

test('ordinary production composer accepts encrypted local drafts without Signal enrollment and survives reload', async ({ browser, playwright }, testInfo) => {
  const owner = await account(browser, playwright, 'plain');
  try {
    const guildResponse = await owner.api.post(`${server}/api/v1/guilds`, { data: { name: 'Durable ordinary UI' } }); expect(guildResponse.status()).toBe(201);
    const guild = await guildResponse.json();
    const channelResponse = await owner.api.post(`${server}/api/v1/guilds/${guild.id}/channels`, { data: { name: 'ordinary', channel_type: 0 } }); expect(channelResponse.status()).toBe(201);
    const channel = await channelResponse.json();
    await owner.page.goto(`http://127.0.0.1:4174/app/guilds/${guild.id}/channels/${channel.id}`); await dismiss(owner.page);
    const composer = owner.page.getByPlaceholder('Say something in ordinary', { exact: true });
    await composer.fill('Saved ordinary draft without identity');
    await expect.poll(() => owner.page.evaluate(async () => {
      const module = await import('/src/lib/messages/accountMessagingRuntime.ts');
      const auth = await import('/src/stores/authStore.ts');
      return module.getAccountMessagingRuntime({ serverId: '__local__', userId: auth.useAuthStore.getState().user!.id }).store.getState().storage;
    })).toBe('ready');
    expect(await localStorageText(owner.page)).not.toContain('Saved ordinary draft without identity');
    await owner.page.reload(); await dismiss(owner.page);
    await expect(composer).toHaveValue('Saved ordinary draft without identity');
    const sent = owner.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/channels/${channel.id}/messages`));
    await composer.press('Enter'); expect((await sent).status()).toBe(201);
    await expect(owner.page.getByText('Saved ordinary draft without identity', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('');
    await owner.page.screenshot({ path: testInfo.outputPath('ordinary-device-draft.png'), fullPage: true });
  } finally { await owner.api.dispose(); await owner.context.close(); }
});

test('two fresh accounts send, receive, edit and delete the first encrypted DM through production UI', async ({ browser, playwright }, testInfo) => {
  const alice = await account(browser, playwright, 'alice'); const bob = await account(browser, playwright, 'bob');
  const encryptedRequests: Array<{ method: string; body: string }> = [];
  for (const page of [alice.page, bob.page]) page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && /\/channels\/\d+\/messages(?:\/\d+)?$/.test(new URL(request.url()).pathname)) encryptedRequests.push({ method: request.method(), body: request.postData() ?? '' });
  });
  try {
    const requested = await alice.api.post(`${server}/api/v1/users/@me/relationships`, { data: { user_id: bob.user.id, type: 1 } }); expect(requested.ok(), await requested.text()).toBe(true);
    const accepted = await bob.api.put(`${server}/api/v1/users/@me/relationships/${alice.user.id}`); expect(accepted.ok(), await accepted.text()).toBe(true);
    const created = await alice.api.post(`${server}/api/v1/users/@me/dms`, { data: { recipient_id: bob.user.id } }); expect(created.status(), await created.text()).toBe(201);
    const dm = await created.json(); const route = `/app/dms/${dm.id}`;
    await setup(bob.page, bob.user.id, route); await setup(alice.page, alice.user.id, route);
    const a = alice.page.getByRole('textbox', { name: /Say something/ }).last();
    const b = bob.page.getByRole('textbox', { name: /Say something/ }).last();
    await a.fill('First private greeting');
    await expect(alice.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await a.press('Enter');
    await expect(bob.page.getByText('First private greeting', { exact: true })).toBeVisible();
    await b.fill('Private reply to first greeting'); await b.press('Enter');
    await expect(alice.page.getByText('Private reply to first greeting', { exact: true })).toBeVisible();
    await alice.page.getByText('First private greeting', { exact: true }).click({ button: 'right' });
    await alice.page.getByRole('menuitem', { name: 'Edit message', exact: true }).click();
    await alice.page.getByRole('textbox', { name: /Edit message from/ }).fill('Edited private greeting');
    await alice.page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bob.page.getByText('Edited private greeting', { exact: true })).toBeVisible();
    await alice.page.getByText('Edited private greeting', { exact: true }).click({ button: 'right' });
    await alice.page.getByRole('menuitem', { name: 'Delete message', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(alice.page.getByRole('alertdialog')).toHaveCount(0);
    await expect(bob.page.getByText('Edited private greeting', { exact: true })).toHaveCount(0);
    await a.fill('Fresh send after first-message deletion'); await a.press('Enter');
    await expect(bob.page.getByText('Fresh send after first-message deletion', { exact: true })).toBeVisible();
    expect(encryptedRequests.filter(request => request.method === 'PATCH')).toHaveLength(1);
    for (const request of encryptedRequests) {
      const payload = JSON.parse(request.body);
      expect(payload.content).toBe(''); expect(payload.e2ee.version).toBe(2);
      expect(request.body).not.toContain('private greeting'); expect(request.body).not.toContain('Private reply');
    }
    expect(await localStorageText(alice.page)).not.toContain('Fresh send after first-message deletion');
    await alice.page.screenshot({ path: testInfo.outputPath('alice-after-first-dm-delete.png'), fullPage: true });
    await bob.page.screenshot({ path: testInfo.outputPath('bob-after-first-dm-delete.png'), fullPage: true });
  } finally {
    await alice.api.dispose(); await bob.api.dispose(); await alice.context.close(); await bob.context.close(); }
});

test('locked recipient recovers a deleted encryption starter after a real server restart without replay memory', async ({ browser, playwright }, testInfo) => {
  const alice = await account(browser, playwright, 'recoveralice'); const bob = await account(browser, playwright, 'recoverbob');
  const starter = 'Deleted starter must never be displayed'; const surviving = 'Dependent ciphertext survives restart';
  const recoveryPages: Array<{ changes?: Array<{ message_id: string; archived_message: unknown; kind: string }>; states?: Array<{ message_id: string; state: string }> }> = [];
  bob.page.on('response', response => {
    if (response.status() === 200 && new URL(response.url()).pathname.endsWith('/messages/recovery')) void response.json().then(page => recoveryPages.push(page)).catch(() => {});
  });
  try {
    const requested = await alice.api.post(`${server}/api/v1/users/@me/relationships`, { data: { user_id: bob.user.id, type: 1 } }); expect(requested.ok(), await requested.text()).toBe(true);
    const accepted = await bob.api.put(`${server}/api/v1/users/@me/relationships/${alice.user.id}`); expect(accepted.ok(), await accepted.text()).toBe(true);
    const created = await alice.api.post(`${server}/api/v1/users/@me/dms`, { data: { recipient_id: bob.user.id } }); expect(created.status(), await created.text()).toBe(201);
    const dm = await created.json(); const route = `/app/dms/${dm.id}`;
    await setup(bob.page, bob.user.id, route); await setup(alice.page, alice.user.id, route);
    await bob.context.setOffline(true); await bob.page.goto('about:blank');
    const composer = alice.page.getByRole('textbox', { name: /Say something/ }).last();
    const send = async (content: string) => {
      const response = alice.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/channels/${dm.id}/messages`));
      await composer.fill(content); await expect(alice.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled(); await composer.press('Enter');
      const delivered = await response; expect(delivered.status()).toBe(201); await expect(alice.page.getByText(content, { exact: true })).toBeVisible();
      return delivered.json();
    };
    const first = await send(starter); const second = await send(surviving);
    const firstHeader = JSON.parse(first.e2ee.header); const secondHeader = JSON.parse(second.e2ee.header);
    expect(firstHeader.ik).toBeTruthy(); expect(secondHeader.ik).toBeUndefined();
    expect(secondHeader.dh).toBe(firstHeader.dh); expect(secondHeader.n).toBe(firstHeader.n + 1);
    await alice.page.getByText(starter, { exact: true }).click({ button: 'right' });
    await alice.page.getByRole('menuitem', { name: 'Delete message', exact: true }).click();
    const deleted = alice.page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(`/channels/${dm.id}/messages/${first.id}`));
    await alice.page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).ok()).toBe(true); await expect(alice.page.getByRole('alertdialog')).toHaveCount(0);
    await expect(alice.page.getByText(starter, { exact: true })).toHaveCount(0);
    const control = await playwright.request.newContext();
    try { const restarted = await control.post('http://127.0.0.1:18161/restart'); expect(restarted.status(), await restarted.text()).toBe(200); }
    finally { await control.dispose(); }
    await bob.page.addInitScript(deletedText => {
      const watch = () => {
        const target = window as unknown as { deletedStarterProjected?: boolean }; target.deletedStarterProjected = false;
        const inspect = () => { if (document.body.textContent?.includes(deletedText)) target.deletedStarterProjected = true; };
        new MutationObserver(inspect).observe(document.body, { subtree: true, childList: true, characterData: true }); inspect();
      };
      if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch, { once: true });
    }, starter);
    await bob.context.setOffline(false); await bob.page.goto(`http://127.0.0.1:4174${route}`); await dismiss(bob.page);
    await expect.poll(() => recoveryPages.some(page => page.changes?.some(change => change.message_id === first.id && change.kind === 'create' && change.archived_message)
      && page.states?.some(state => state.message_id === first.id && state.state === 'deleted'))).toBe(true);
    await expect(bob.page.getByText(starter, { exact: true })).toHaveCount(0);
    await expect(bob.page.getByText(surviving, { exact: true })).toHaveCount(0);
    await bob.page.getByRole('link', { name: 'Unlock encryption', exact: true }).click();
    await bob.page.getByLabel('Password', { exact: false }).fill(encryptionPassword);
    await bob.page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(bob.page).toHaveURL(new RegExp(route));
    await expect(bob.page.getByText(surviving, { exact: true })).toBeVisible();
    await expect(bob.page.getByText(starter, { exact: true })).toHaveCount(0);
    expect(await bob.page.evaluate(() => (window as unknown as { deletedStarterProjected?: boolean }).deletedStarterProjected)).toBe(false);
    expect(await localStorageText(bob.page)).not.toContain(surviving);
    await bob.page.screenshot({ path: testInfo.outputPath('recovered-dependent-after-server-restart.png'), fullPage: true });
  } finally { await alice.api.dispose(); await bob.api.dispose(); await alice.context.close(); await bob.context.close(); }
});

/** A lost reply after the server committed must replay, never duplicate (items 1 and 15). */
test('a delivery whose response is lost across a server restart replays its original request exactly once', async ({ browser, playwright }, testInfo) => {
  const alice = await account(browser, playwright, 'lostalice'); const bob = await account(browser, playwright, 'lostbob');
  const content = 'Committed before the response was lost';
  const bodies: string[] = [];
  try {
    const requested = await alice.api.post(`${server}/api/v1/users/@me/relationships`, { data: { user_id: bob.user.id, type: 1 } }); expect(requested.ok(), await requested.text()).toBe(true);
    const accepted = await bob.api.put(`${server}/api/v1/users/@me/relationships/${alice.user.id}`); expect(accepted.ok(), await accepted.text()).toBe(true);
    const created = await alice.api.post(`${server}/api/v1/users/@me/dms`, { data: { recipient_id: bob.user.id } }); expect(created.status(), await created.text()).toBe(201);
    const dm = await created.json(); const route = `/app/dms/${dm.id}`;
    await setup(bob.page, bob.user.id, route); await setup(alice.page, alice.user.id, route);
    await alice.page.route(`**/api/v1/channels/${dm.id}/messages`, async handler => {
      if (handler.request().method() !== 'POST') { await handler.fallback(); return; }
      bodies.push(handler.request().postData() ?? '');
      if (bodies.length > 1) { await handler.continue(); return; }
      // Commit on the server, restart it, and never hand the reply back.
      await handler.fetch();
      const control = await playwright.request.newContext();
      try { expect((await control.post('http://127.0.0.1:18161/restart')).status()).toBe(200); } finally { await control.dispose(); }
      await handler.abort('connectionfailed');
    });
    const composer = alice.page.getByRole('textbox', { name: /Say something/ }).last();
    await composer.fill(content);
    await expect(alice.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await composer.press('Enter');
    await expect.poll(() => bodies.length, { timeout: 60_000 }).toBeGreaterThan(1);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]).content).toBe('');
    await expect(alice.page.getByLabel('Message history').getByText(content, { exact: true })).toHaveCount(1);
    const session = await signIn(playwright, alice.email);
    try {
      const listed = await session.get(`${server}/api/v1/channels/${dm.id}/messages`);
      expect(listed.status(), await listed.text()).toBe(200);
      const rows = await listed.json() as Array<{ nonce: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].nonce).toBe(JSON.parse(bodies[0]).nonce);
    } finally { await session.dispose(); }
    await expect(bob.page.getByText(content, { exact: true })).toBeVisible();
    await alice.page.screenshot({ path: testInfo.outputPath('lost-response-replayed-once.png'), fullPage: true });
  } finally { await alice.api.dispose(); await bob.api.dispose(); await alice.context.close(); await bob.context.close(); }
});

/** Forced resync after replay eviction, concurrent with history (items 5 and 15). */
test('a reconnect after replay eviction recovers created, edited and deleted messages alongside history', async ({ browser, playwright }, testInfo) => {
  const owner = await account(browser, playwright, 'resync');
  const recoveries: string[] = [];
  owner.page.on('response', response => { if (response.status() === 200 && new URL(response.url()).pathname.endsWith('/messages/recovery')) recoveries.push(response.url()); });
  try {
    const guildResponse = await owner.api.post(`${server}/api/v1/guilds`, { data: { name: 'Replay eviction recovery' } }); expect(guildResponse.status()).toBe(201);
    const guild = await guildResponse.json();
    const channelResponse = await owner.api.post(`${server}/api/v1/guilds/${guild.id}/channels`, { data: { name: 'resync', channel_type: 0 } }); expect(channelResponse.status()).toBe(201);
    const channel = await channelResponse.json();
    const post = async (text: string) => {
      const response = await owner.api.post(`${server}/api/v1/channels/${channel.id}/messages`, { data: { content: text, nonce: crypto.randomUUID() } });
      expect(response.status(), await response.text()).toBe(201); return response.json();
    };
    const removed = await post('Deleted while this window was offline');
    await owner.page.goto(`http://127.0.0.1:4174/app/guilds/${guild.id}/channels/${channel.id}`); await dismiss(owner.page);
    const feed = owner.page.getByLabel('Message history');
    await expect(feed.getByText('Deleted while this window was offline', { exact: true })).toBeVisible();
    await owner.context.setOffline(true);
    const edited = await post('Original body before the offline edit');
    const patched = await owner.api.patch(`${server}/api/v1/channels/${channel.id}/messages/${edited.id}`, { data: { content: 'Edited while this window was offline' } });
    expect(patched.status(), await patched.text()).toBe(200);
    const deleted = await owner.api.delete(`${server}/api/v1/channels/${channel.id}/messages/${removed.id}`);
    expect(deleted.status(), await deleted.text()).toBeLessThan(300);
    const control = await playwright.request.newContext();
    try { expect((await control.post('http://127.0.0.1:18161/restart')).status()).toBe(200); } finally { await control.dispose(); }
    const before = recoveries.length;
    await owner.context.setOffline(false);
    // Reconnect and an ordinary history load race each other deliberately.
    await owner.page.reload(); await dismiss(owner.page);
    await expect(feed.getByText('Edited while this window was offline', { exact: true })).toBeVisible();
    await expect(feed.getByText('Deleted while this window was offline', { exact: true })).toHaveCount(0);
    await expect(feed.getByText('Original body before the offline edit', { exact: true })).toHaveCount(0);
    expect(recoveries.length).toBeGreaterThan(before);
    const welcome = owner.page.getByRole('button', { name: 'Jump in', exact: true });
    if (await welcome.isVisible().catch(() => false)) await welcome.click();
    await expect(feed.getByText('Edited while this window was offline', { exact: true })).toBeInViewport();
    await owner.page.screenshot({ path: testInfo.outputPath('resync-after-replay-eviction.png'), fullPage: true });
  } finally { await owner.api.dispose(); await owner.context.close(); }
});
