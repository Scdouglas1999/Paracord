import { expect, test, type Page } from '@playwright/test';
import { connect } from 'node:http2';
import { isGuildDetail, isGuildSummaryList } from '../src/api/generated/validators';

// Real-server smoke: unlike smoke.spec.ts, this test does NOT mock any /api
// route. It runs against the actual release `paracord-server` binary launched by
// e2e/real-server-harness.mjs, which serves the embedded web UI out of
// client/dist/ and a throwaway SQLite database. This is the only E2E coverage
// that exercises embedded-asset serving, real auth, and real REST contract
// shapes end to end. Keep it lean — the mocked smoke remains the fast gate.
//
// Every case here registers its own account, because the real server has real
// accounts and sharing one between cases would make them order-dependent. Added
// up across the whole real-server project that is more `/api/v1/auth/*` traffic
// per minute from 127.0.0.1 than the product's per-IP auth ceiling allows for a
// single client, so the harness raises that ceiling for its throwaway instance
// (see PARACORD_HTTP_RATE_LIMIT_* in e2e/real-server-harness.mjs). Do not
// respond to a 429 here by sleeping or retrying: a 429 in this project means the
// traffic shape changed, and the number that needs looking at is the request
// count, not the wait.

const PORT = process.env.PARACORD_E2E_PORT ?? '18150';
const BASE = `http://127.0.0.1:${PORT}`;

/** Click away the shell tour and the welcome screen in whatever order they arrive. */
async function dismissFirstRunOverlays(page: Page, quietMs = 2_500, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastSeen = Date.now();
  while (Date.now() < deadline && Date.now() - lastSeen < quietMs) {
    for (const name of ['Close welcome screen', 'Skip tour']) {
      const control = page.getByRole('button', { name, exact: true });
      if (await control.isVisible().catch(() => false)) {
        await control.click();
        lastSeen = Date.now();
      }
    }
    await page.waitForTimeout(250);
  }
}

test('embedded UI boots and real auth round trip succeeds', async ({ page, request, playwright }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  // 1. The embedded SPA is served and mounted by the real binary (no mocks).
  //    An unauthenticated visitor is routed to the login screen once the app
  //    confirms the server is reachable via the real /health endpoint.
  await page.goto('/');
  await expect(page.locator('#root')).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  // 2. Genuine REST round trip through the real API: register -> login ->
  //    authenticated fetch. This asserts real auth works and that the response
  //    contract shapes match what the client expects.
  const unique = Date.now();
  const username = `e2euser${unique}`.slice(0, 32);
  const email = `e2e-smoke-${unique}@example.test`;
  // Server password policy: 10-128 UTF-8 bytes with ASCII upper/lower/digit/special.
  const password = 'E2e-Smoke-Password-123!';

  const registerResp = await request.post(`${BASE}/api/v1/auth/register`, {
    data: { email, username, password },
  });
  expect(
    registerResp.ok(),
    `register failed: ${registerResp.status()} ${await registerResp.text()}`,
  ).toBeTruthy();
  const registerBody = await registerResp.json();
  expect(typeof registerBody.token).toBe('string');
  expect(registerBody.token.length).toBeGreaterThan(0);
  expect(registerBody.user).toBeTruthy();
  expect(registerBody.user.username).toBe(username);

  // Register set ambient auth cookies on this request context, so the real
  // CSRF middleware now requires the double-submit header on /api writes —
  // mirror the real client by echoing the paracord_csrf cookie.
  const cookies = (await request.storageState()).cookies;
  const csrf = cookies.find((c) => c.name === 'paracord_csrf')?.value;
  expect(csrf, 'register should set a readable paracord_csrf cookie').toBeTruthy();

  const loginResp = await request.post(`${BASE}/api/v1/auth/login`, {
    headers: { 'x-paracord-csrf': csrf! },
    data: { email, password },
  });
  expect(
    loginResp.ok(),
    `login failed: ${loginResp.status()} ${await loginResp.text()}`,
  ).toBeTruthy();
  const loginBody = await loginResp.json();
  const token = loginBody.token as string;
  expect(typeof token).toBe('string');
  expect(token.length).toBeGreaterThan(0);

  const meResp = await request.get(`${BASE}/api/v1/users/@me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    meResp.ok(),
    `users/@me failed: ${meResp.status()} ${await meResp.text()}`,
  ).toBeTruthy();
  const me = await meResp.json();
  expect(me.username).toBe(username);
  expect(String(me.id)).toBe(String(registerBody.user.id));

  // 3. Auth must actually be enforced: a genuinely unauthenticated request
  //    (fresh context — no cookies, no bearer) is denied.
  const freshContext = await playwright.request.newContext();
  try {
    const unauth = await freshContext.get(`${BASE}/api/v1/users/@me`);
    expect(unauth.status()).toBe(401);
  } finally {
    await freshContext.dispose();
  }

  expect(pageErrors).toEqual([]);
});

test('real identity setup survives rejected credentials and reload, then adopts the session and keeps identity enrollment separate on account changes', async ({ page, request }) => {
  const unique = Date.now();
  const email = `identity-${unique}@example.test`;
  const username = `identity${unique}`.slice(0, 32);
  const password = 'Server-Password-123!';
  const registered = await request.post(`${BASE}/api/v1/auth/register`, { data: { email, username, password } });
  expect(registered.ok()).toBe(true);
  const account = (await registered.json()).user;
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
  await page.goto(`/setup?migrate=1&server=__local__&user=${account.id}`);
  await page.getByLabel('New encryption password', { exact: false }).fill('Separate encryption password');
  await page.getByLabel('Confirm password', { exact: false }).fill('Separate encryption password');
  await page.getByLabel('Current sign-in password', { exact: false }).fill('Wrong-Server-Password-123!');
  await page.getByRole('button', { name: 'Secure account' }).click();
  await expect(page.getByText('The instance rejected that sign-in.', { exact: false })).toBeVisible();
  const original = await page.evaluate(() => localStorage.getItem('paracord:encrypted-identity:v1'));
  expect(original).toBeTruthy();
  await page.reload();
  await page.getByLabel('Encryption password', { exact: false }).fill('Separate encryption password');
  await page.getByLabel('Current sign-in password', { exact: false }).fill(password);
  const profiles: Array<{ status: number; authorization?: string }> = [];
  page.on('response', response => {
    if (response.url().endsWith('/api/v1/users/@me')) profiles.push({ status: response.status(), authorization: response.request().headers().authorization });
  });
  const attached = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/attach-public-key'));
  await page.getByRole('button', { name: 'Secure account' }).click();
  const response = await attached;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.user.id).toBe(account.id);
  expect(result.user.public_key).toBe(JSON.parse(original!).publicKey);
  await expect(page.getByRole('heading', { name: 'Recovery phrase' })).toBeVisible();
  await expect.poll(() => profiles.some(profile => profile.status === 200 && profile.authorization === `Bearer ${result.token}`)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('paracord:encrypted-identity:v1'))).toBe(original);
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/app/);

  // Keep the unlocked device identity in this browser while changing server
  // accounts through the real UI. Login/registration must not install it as a
  // credential on the next account or copy the home token into a remote entry.
  const implicitAttachments: string[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/auth/attach-public-key')) implicitAttachments.push(request.url());
  });
  async function logout() {
    await page.getByRole('button', { name: 'Open user settings', exact: true }).click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    // A device that holds an identity is asked to unlock it after a sign-out,
    // not to sign in. "Welcome back" heads both screens; the way on to another
    // account is the password sign-in, which is where "Create one" lives.
    const passwordInstead = page.getByRole('button', { name: 'Sign in with a password instead' });
    if (await passwordInstead.isVisible()) await passwordInstead.click();
  }
  await logout();
  await page.getByRole('link', { name: 'Create one' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  // Registration is two steps — who you are, then the password and the terms.
  const secondEmail = `second-${unique}@example.test`;
  await page.getByLabel('Email', { exact: false }).fill(secondEmail);
  await page.getByLabel('Username', { exact: false }).fill(`second${unique}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Step 2 of 2')).toBeVisible();
  await page.getByLabel('Password', { exact: false }).first().fill(password);
  await page.getByLabel('Confirm password', { exact: false }).fill(password);
  await page.getByRole('checkbox').check();
  const registrationResponse = page.waitForResponse(response => response.url().endsWith('/auth/register'));
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const registration = await registrationResponse;
  expect(registration.status()).toBe(201);
  const second = await registration.json();
  expect(second.user.public_key).toBeNull();
  await expect(page).toHaveURL(/\/app/);
  expect((await request.get(`${BASE}/api/v1/users/@me`, { headers: { Authorization: `Bearer ${second.token}` } })).status()).toBe(200);
  await logout();
  await page.locator('input[autocomplete="username"]').fill(secondEmail);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
  await page.getByRole('button', { name: 'Open user settings', exact: true }).click();
  expect(implicitAttachments).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('paracord:encrypted-identity:v1'))).toBe(original);

});


test('the release API seals uncertain deliveries and protects edit replays', async ({ request, playwright }) => {
  const unique = Date.now();
  const registered = await request.post(`${BASE}/api/v1/auth/register`, {
    data: { email: `resolution-${unique}@example.test`, username: `resolve${unique}`, password: 'Resolution-Password-123!' },
  });
  expect(registered.status()).toBe(201);
  const account = await registered.json();
  const client = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${account.token}` } });
  try {
    const guildResponse = await client.post(`${BASE}/api/v1/guilds`, { data: { name: 'Delivery resolution verification' } });
    expect(guildResponse.status()).toBe(201);
    const guild = await guildResponse.json();
    const channelResponse = await client.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, { data: { name: 'resolution', type: 0 } });
    expect(channelResponse.status()).toBe(201);
    const channel = await channelResponse.json();
    const nonce = `release-resolution-${unique}`;
    const path = `${BASE}/api/v1/channels/${channel.id}`;
    const resolved = await client.post(`${path}/message-deliveries/${nonce}/resolve`);
    expect(resolved.status()).toBe(200);
    expect(await resolved.json()).toEqual({ state: 'cancelled', channel_id: channel.id, author_id: account.user.id, nonce });
    const delayed = await client.post(`${path}/messages`, { data: { content: 'This canceled message must not appear', nonce } });
    expect(delayed.status()).toBe(410);
    expect((await delayed.json()).code).toBe('DELIVERY_CANCELLED');
    const repeated = await client.post(`${path}/message-deliveries/${nonce}/resolve`);
    expect(repeated.status()).toBe(200);
    expect((await repeated.json()).state).toBe('cancelled');
    const createdResponse = await client.post(`${path}/messages`, { data: { content: 'Original before durable edits', nonce: `edit-original-${unique}` } });
    expect(createdResponse.status()).toBe(201);
    const original = await createdResponse.json();
    const editPath = `${path}/messages/${original.id}`;
    const firstEdit = { content: 'First durable edit', edit_nonce: `first-edit-${unique}` };
    const applied = await client.patch(editPath, { data: firstEdit });
    expect(applied.status()).toBe(200); expect((await applied.json()).edit_replayed).toBe(false);
    const later = await client.patch(editPath, { data: { content: 'Newer durable edit', edit_nonce: `later-edit-${unique}` } });
    expect(later.status()).toBe(200); const latest = await later.json();
    const replay = await client.patch(editPath, { data: firstEdit });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ id: original.id, content: 'Newer durable edit', edit_nonce: firstEdit.edit_nonce, edit_replayed: true, edited_at: latest.edited_at });
    const history = await client.get(`${editPath}/edits`); expect(history.status()).toBe(200);
    expect((await history.json()).map((entry: { content: string }) => entry.content)).toEqual(['Original before durable edits', 'First durable edit']);
    const canceledNonce = `canceled-edit-${unique}`;
    const resolutionPath = `${editPath}/edits/${canceledNonce}/resolve`;
    const editResolution = await client.post(resolutionPath);
    expect(editResolution.status()).toBe(200);
    expect(await editResolution.json()).toMatchObject({ state: 'cancelled', actor_id: account.user.id, message_id: original.id, edit_nonce: canceledNonce });
    const replacement = await client.patch(editPath, { data: { content: 'Replacement after edit cancellation', edit_nonce: `replacement-${unique}` } });
    expect(replacement.status()).toBe(200);
    const delayedEdit = await client.patch(editPath, { data: { content: 'This delayed edit must not overwrite its replacement', edit_nonce: canceledNonce } });
    expect(delayedEdit.status()).toBe(410); expect((await delayedEdit.json()).code).toBe('EDIT_CANCELLED');
    const current = await client.get(`${path}/messages`); expect(current.status()).toBe(200);
    expect((await current.json()).find((entry: { id: string }) => entry.id === original.id)?.content).toBe('Replacement after edit cancellation');
    const appliedResolution = await client.post(`${editPath}/edits/${firstEdit.edit_nonce}/resolve`);
    expect(appliedResolution.status()).toBe(200); expect((await appliedResolution.json()).state).toBe('applied');
  } finally { await client.dispose(); }
});

test('real message edits retain readable history after reload', async ({ page, request, playwright }, testInfo) => {
  const unique = Date.now();
  const email = `edit-history-${unique}@example.test`;
  const password = 'Edit-History-Password-123!';
  const registered = await request.post(`${BASE}/api/v1/auth/register`, {
    data: { email, username: `edithistory${unique}`, password },
  });
  expect(registered.status()).toBe(201);
  const account = await registered.json();
  const client = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${account.token}` } });
  try {
    const guildResponse = await client.post(`${BASE}/api/v1/guilds`, { data: { name: 'Message edit verification' } });
    expect(guildResponse.status()).toBe(201);
    const guild = await guildResponse.json();
    const channelResponse = await client.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, { data: { name: 'edit-history', channel_type: 0 } });
    expect(channelResponse.status()).toBe(201);
    const channel = await channelResponse.json();
    await page.goto('/login');
    await page.locator('input[autocomplete="username"]').fill(email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page).toHaveURL(/\/app/);
    await page.goto(`/app/guilds/${guild.id}/channels/${channel.id}`);
    // First-run overlays arrive one at a time and not in a fixed order (the
    // tour, then the welcome screen a beat later, or the reverse), so keep
    // dismissing whichever is up until neither has appeared for a while.
    await dismissFirstRunOverlays(page);
    const original = 'First version from the real composer';
    await page.getByPlaceholder('Message #edit-history', { exact: true }).fill(original);
    const creation = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/channels/${channel.id}/messages`));
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const created = await creation; expect(created.status()).toBe(201);
    const message = await created.json();
    let preceding = original;
    // Scope to the feed: an in-flight durable edit is also listed in the saved
    // delivery panel until its receipt commits.
    const feed = page.getByLabel('Message history');
    for (const content of ['Second version from the real editor', 'Final version after two edits']) {
      await feed.getByText(preceding, { exact: true }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit message', exact: true }).click();
      await page.getByRole('textbox', { name: /Edit message from/ }).fill(content);
      const update = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/messages/${message.id}`));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await update).status()).toBe(200);
      await expect(feed.getByText(content, { exact: true })).toBeVisible();
      preceding = content;
    }
    await page.reload();
    await expect(feed.getByText(preceding, { exact: true })).toBeVisible();
    const historyResponse = page.waitForResponse(response => response.url().endsWith(`/messages/${message.id}/edits`));
    await page.getByRole('button', { name: `Show edit history for message ${message.id}`, exact: true }).click();
    expect((await historyResponse).status()).toBe(200);
    const history = page.getByRole('dialog', { name: 'Edit history', exact: true });
    await expect(history.getByText(original, { exact: true })).toBeVisible();
    await expect(history.getByText('Second version from the real editor', { exact: true })).toBeVisible();
    // WP7 restyled the dialog: each version is "Version N · <time>" in the mono meta face.
    await expect(history.getByText(/Version [12] ·/)).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('edit-history.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(history).not.toBeVisible();
    // Real network loss must report failure, never an empty successful history.
    await page.context().setOffline(true);
    await page.getByRole('button', { name: `Show edit history for message ${message.id}`, exact: true }).click();
    await expect(history.getByRole('alert')).toContainText('Couldn’t load edit history');
    await expect(history.getByText('No earlier versions are available.', { exact: true })).not.toBeVisible();
    for (const width of [320, 768, 320]) {
      await page.setViewportSize({ width, height: 640 });
      const bounds = await history.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(8); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 8);
      expect(bounds!.y).toBeGreaterThanOrEqual(8); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(632);
    }
    await page.screenshot({ path: testInfo.outputPath('edit-history-offline-320.png'), fullPage: true });
    await page.context().setOffline(false);
    await history.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(history.getByText(original, { exact: true })).toBeVisible();
    await expect(history.getByText('Second version from the real editor', { exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'Close edit history', exact: true }).click();
    await expect(history).not.toBeVisible();
  } finally { await page.context().setOffline(false); await client.dispose(); }
});


test('the release HTTP/2 server multiplexes requests and preserves authenticated JSON bodies', async () => {
  const session = connect(BASE);
  const sessionErrors: Error[] = [];
  session.on('error', error => { sessionErrors.push(error); });
  function request(path: string, method = 'GET', body?: unknown, token?: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      const stream = session.request({ ':method': method, ':path': path,
        ...(serialized === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(serialized) }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      });
      let status = 0; let response = '';
      stream.setEncoding('utf8');
      stream.setTimeout(10_000, () => stream.destroy(new Error('HTTP/2 response timed out.')));
      stream.once('response', headers => { status = Number(headers[':status']); });
      stream.on('data', chunk => { response += chunk; });
      stream.once('error', reject);
      stream.once('aborted', () => reject(new Error('HTTP/2 stream aborted before completion.')));
      stream.once('end', () => resolve({ status, body: response }));
      stream.end(serialized);
    });
  }
  try {
    const [health, anonymous] = await Promise.all([request('/health'), request('/api/v1/users/@me')]);
    expect(health.status).toBe(200);
    expect(anonymous.status).toBe(401);
    const unique = Date.now(); const username = `http2${unique}`;
    const registered = await request('/api/v1/auth/register', 'POST', {
      email: `http2-${unique}@example.test`, username, password: 'Http2-Transport-Password-123!',
    });
    expect(registered.status, registered.body).toBe(201);
    const account = JSON.parse(registered.body);
    const [own, unauthorized, again] = await Promise.all([
      request('/api/v1/users/@me', 'GET', undefined, account.token),
      request('/api/v1/users/@me'), request('/health'),
    ]);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body)).toMatchObject({ id: account.user.id, username });
    expect(unauthorized.status).toBe(401);
    expect(again.status).toBe(200);
    expect(sessionErrors).toEqual([]);
  } finally { session.destroy(); }
});

test('Home follows live mention creation, edits and deletion and opens the surviving exact message', async ({ page, playwright }, testInfo) => {
  const unique = Date.now();
  const password = 'Attention-Password-123!';
  const register = async (label: string) => {
    const context = await playwright.request.newContext();
    const email = `${label}-${unique}@example.test`;
    try {
      const response = await context.post(`${BASE}/api/v1/auth/register`, { data: { email, username: `${label}${unique}`, password } });
      expect(response.status(), await response.text()).toBe(201);
      return { ...await response.json(), email };
    } finally { await context.dispose(); }
  };
  const owner = await register('attentionowner');
  const member = await register('attentionmember');
  const ownerApi = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${owner.token}` } });
  const memberApi = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${member.token}` } });
  try {
    const guildResponse = await ownerApi.post(`${BASE}/api/v1/guilds`, { data: { name: 'Attention verification' } });
    expect(guildResponse.status()).toBe(201);
    const guild = await guildResponse.json();
    const channelResponse = await ownerApi.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, { data: { name: 'decisions', channel_type: 0 } });
    expect(channelResponse.status()).toBe(201);
    const channel = await channelResponse.json();
    const inviteResponse = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/invites`, { data: {} });
    expect(inviteResponse.status()).toBe(201);
    const invite = await inviteResponse.json();
    const joined = await memberApi.post(`${BASE}/api/v1/invites/${invite.code}`, { data: {} });
    expect(joined.ok(), await joined.text()).toBe(true);
    await page.addInitScript(() => {
      const observed = { readyUser: '', mentions: [] as string[] };
      (window as unknown as { attentionWire: typeof observed }).attentionWire = observed;
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          const observe = (event: MessageEvent<string>) => {
            try {
              const frame = JSON.parse(event.data);
              if (frame.t === 'READY') observed.readyUser = frame.d?.user?.id ?? '';
              if (frame.t === 'MESSAGE_MENTION') observed.mentions.push(frame.d.message_id);
            } catch { /* Non-gateway liveness frames carry no attention data. */ }
          };
          this.addEventListener('gateway', event => observe(event as MessageEvent<string>));
          this.addEventListener('message', observe);
        }
      };
    });
    await page.goto('/login');
    await page.locator('input[autocomplete="username"]').fill(member.email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page).toHaveURL(/\/app/);
    await page.goto('/app');
    const home = page.getByRole('main');
    await expect(home.getByRole('heading', { level: 1 })).toBeVisible();
    // Give the live transport an observed authenticated READY before emitting
    // the mention. No reload or mocked gateway event is used for this check.
    // §7.5 replaced the per-room "Continue in <room>" region. The building the
    // member just joined is the landmark that is always there — a dark building
    // is a `group`, a lit one an `article` — and it is enough to know Home has
    // rendered before the wire check below.
    await expect(
      home.getByRole('group', { name: 'Attention verification' })
        .or(home.getByRole('article', { name: 'Attention verification' })),
    ).toBeVisible();
    await page.waitForFunction(id => (window as unknown as { attentionWire: { readyUser: string } }).attentionWire.readyUser === id, member.user.id);
    const sent = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, { data: { content: `<@${member.user.id}> Please review the original design`, nonce: 'real-home-attention' } });
    expect(sent.status()).toBe(201);
    const message = await sent.json();
    const tail = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, { data: { content: 'Later unrelated chatter', nonce: 'real-home-tail' } });
    expect(tail.status()).toBe(201);
    const attention = home.getByRole('region', { name: 'For you' });
    await page.waitForFunction(id => (window as unknown as { attentionWire: { mentions: string[] } }).attentionWire.mentions.includes(id), message.id);
    // §7.5 names WHO, not how many: "<author> mentioned you", with the count
    // kept only when the author cannot be named (`needsYouReason`).
    await expect(attention.getByText(/mentioned you/)).toBeVisible();
    await expect(attention.getByText(/@you Please review the original design/)).toBeVisible();
    await expect(attention.getByText(/Later unrelated chatter/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('home-exact-mention.png'), fullPage: true });
    const second = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, { data: { content: `<@${member.user.id}> The surviving design decision`, nonce: 'real-home-second' } });
    expect(second.status()).toBe(201);
    const survivor = await second.json();
    const later = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, { data: { content: 'Still later unrelated chatter', nonce: 'real-home-later' } });
    expect(later.status()).toBe(201);
    // A second mention in the same room is the same row, still previewing the
    // oldest unread mention — the row is one piece of work, not two.
    await expect(attention.getByRole('listitem')).toHaveCount(1);
    await expect(attention.getByText(/@you Please review the original design/)).toBeVisible();
    const edited = await ownerApi.patch(`${BASE}/api/v1/channels/${channel.id}/messages/${message.id}`, { data: { content: `<@${member.user.id}> Review the revised original design` } });
    expect(edited.ok(), await edited.text()).toBe(true);
    await expect(attention.getByText(/Review the revised original design/)).toBeVisible();
    const deleted = await ownerApi.delete(`${BASE}/api/v1/channels/${channel.id}/messages/${message.id}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
    await expect(attention.getByText(/mentioned you/)).toBeVisible();
    await expect(attention.getByText(/The surviving design decision/)).toBeVisible();
    await expect(attention.getByText(/Review the revised original design/)).toHaveCount(0);
    await expect(attention.getByText(/Still later unrelated chatter/)).toHaveCount(0);
    const homeTour = page.getByRole('button', { name: 'Skip tour', exact: true });
    if (await homeTour.isVisible()) await homeTour.click();
    await page.screenshot({ path: testInfo.outputPath('home-surviving-mention.png'), fullPage: true });
    const jump = page.waitForURL(new RegExp(`/channels/${channel.id}\\?message=${survivor.id}`));
    // §7.5: a Needs-you row carries one action, labeled for the room it opens.
    await attention.getByRole('button', { name: 'Open decisions', exact: true }).click();
    await jump;
    const skip = page.getByRole('button', { name: 'Skip tour', exact: true });
    if (await skip.isVisible()) await skip.click();
    const welcome = page.getByRole('button', { name: 'Close welcome screen', exact: true });
    if (await welcome.isVisible()) await welcome.click();
    await expect(page.getByText(/The surviving design decision/).last()).toBeVisible();
    // Establish a read cursor for the existing history, then verify that a new
    // unread tail disappears live when its only message is deleted.
    const read = await memberApi.put(`${BASE}/api/v1/channels/${channel.id}/read`, { data: { last_message_id: (await later.json()).id } });
    expect(read.ok(), await read.text()).toBe(true);
    await page.goto('/app');
    await page.waitForFunction(id => (window as unknown as { attentionWire: { readyUser: string } }).attentionWire.readyUser === id, member.user.id);
    // §7.5 keeps the Needs-you section on the surface and lets it say so:
    // "Nothing new for you right now." It is no longer removed when
    // empty, because an absent section cannot tell you it checked.
    await expect(page.getByRole('main').getByRole('region', { name: 'For you' }).getByRole('listitem')).toHaveCount(0);
    await expect(page.getByRole('main').getByText('Nothing new for you right now.')).toBeVisible();
    const finalSend = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, { data: { content: `<@${member.user.id}> Only unread tail`, nonce: 'real-home-only-tail' } });
    expect(finalSend.status()).toBe(201);
    const finalMessage = await finalSend.json();
    await expect(page.getByRole('main').getByRole('region', { name: 'For you' }).getByText(/Only unread tail/)).toBeVisible();
    const finalDelete = await ownerApi.delete(`${BASE}/api/v1/channels/${channel.id}/messages/${finalMessage.id}`);
    expect(finalDelete.ok(), await finalDelete.text()).toBe(true);
    // §7.5 keeps the Needs-you section on the surface and lets it say so:
    // "Nothing new for you right now." It is no longer removed when
    // empty, because an absent section cannot tell you it checked.
    await expect(page.getByRole('main').getByRole('region', { name: 'For you' }).getByRole('listitem')).toHaveCount(0);
    await expect(page.getByRole('main').getByText('Nothing new for you right now.')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('home-deleted-tail-cleared.png'), fullPage: true });

  } finally {
    await ownerApi.dispose();
    await memberApi.dispose();
  }
});

test('real guild contracts keep the welcome member count correct after join and reload', async ({ page, playwright }, testInfo) => {
  const unique = Date.now();
  const password = 'Welcome-Password-123!';
  async function account(label: string) {
    const registration = await playwright.request.newContext();
    try {
      const email = `${label}-${unique}@example.test`;
      const response = await registration.post(`${BASE}/api/v1/auth/register`, {
        data: { email, username: `${label}${unique}`, password },
      });
      expect(response.status(), await response.text()).toBe(201);
      const body = await response.json();
      return { email, token: body.token as string };
    } finally {
      await registration.dispose();
    }
  }
  const owner = await account('welcomeowner');
  const member = await account('welcomemember');
  const ownerApi = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${owner.token}` } });
  const memberApi = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${member.token}` } });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    const created = await ownerApi.post(`${BASE}/api/v1/guilds`, { data: { name: 'Welcome count verification' } });
    expect(created.status()).toBe(201);
    const guild = await created.json();
    expect(isGuildDetail(guild)).toBe(true);
    expect(guild.member_count).toBe(1);
    const published = await ownerApi.patch(`${BASE}/api/v1/guilds/${guild.id}`, { data: { visibility: 'public' } });
    expect(published.status()).toBe(200);
    const channelResponse = await ownerApi.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, { data: { name: 'welcome-count', type: 0 } });
    expect(channelResponse.status()).toBe(201);
    const channel = await channelResponse.json();
    const joined = await memberApi.put(`${BASE}/api/v1/guilds/${guild.id}/members/@me`);
    expect(joined.status()).toBe(200);
    const joinedGuild = await joined.json();
    expect(isGuildDetail(joinedGuild)).toBe(true);
    expect(joinedGuild.member_count).toBe(2);
    const listResponse = await memberApi.get(`${BASE}/api/v1/users/@me/guilds`);
    expect(listResponse.status()).toBe(200);
    const list = await listResponse.json();
    expect(isGuildSummaryList(list)).toBe(true);
    expect(list.find((space: { id: string }) => space.id === guild.id)?.member_count).toBe(2);

    await page.goto('/login');
    await page.locator('input[autocomplete="username"]').fill(member.email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page).toHaveURL(/\/app/);
    await page.goto(`/app/guilds/${guild.id}/channels/${channel.id}`);
    await expect(page.getByText('Welcome aboard', { exact: true })).toBeVisible();
    await expect(page.getByText('2 members', { exact: true })).toBeVisible();
    await expect(page.getByText("2 people are already here. Say hi when you're ready.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Welcome aboard', { exact: true })).toBeVisible();
    await expect(page.getByText('2 members', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('welcome-member-count.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
  } finally {
    await ownerApi.dispose();
    await memberApi.dispose();
  }
});
