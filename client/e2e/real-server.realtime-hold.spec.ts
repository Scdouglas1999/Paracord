import { expect, test, type Page } from '@playwright/test';

// Can the app just sit there?
//
// Every other real-server spec does its work and leaves within a few seconds,
// and the 3.0 release candidate shipped with a client that could not hold a
// realtime connection for two minutes: it created a session, opened the event
// stream, and — because the server's idle keepalive was an SSE comment no
// client can observe — its liveness watchdog declared the healthy stream dead
// and rebuilt the whole thing, every ninety seconds, refetching each guild's
// channels and members on the way. Nothing in the suite noticed, because
// nothing in the suite stayed.
//
// So this one stays. It signs in, does nothing at all, and counts.
//
// The hold is four minutes by default — long enough to have caught the old
// ninety-second cycle nearly three times over, short enough to keep in a suite.
// PARACORD_E2E_HOLD_MINUTES raises it for a release run; note that the server
// caps a single stream's lifetime at fifteen minutes by design (a re-attached
// stream is what makes a revoked token take effect), so a hold past that
// legitimately sees a second session.

const PORT = process.env.PARACORD_E2E_PORT ?? '18150';
const BASE = `http://127.0.0.1:${PORT}`;
const HOLD_MINUTES = Number(process.env.PARACORD_E2E_HOLD_MINUTES ?? 4);
const HOLD_MS = HOLD_MINUTES * 60_000;

test.describe.configure({ timeout: HOLD_MS + 180_000 });

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

test('a signed-in client holds one realtime session while it sits idle', async ({ page, request }) => {
  const unique = Date.now();
  const username = `rthold${unique}`.slice(0, 32);
  const email = `rt-hold-${unique}@example.test`;
  const password = 'Rt-Hold-Password-123!';

  const registerResp = await request.post(`${BASE}/api/v1/auth/register`, {
    data: { email, username, password },
  });
  expect(
    registerResp.ok(),
    `register failed: ${registerResp.status()} ${await registerResp.text()}`,
  ).toBeTruthy();

  // Count from the very first navigation: a reconnect storm at boot counts too.
  const calls = new Map<string, number>();
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname.replace(/\/\d{5,}/g, '/{id}');
    if (!path.startsWith('/api')) return;
    const key = `${req.method()} ${path}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
  });
  const count = (key: string) => calls.get(key) ?? 0;

  await page.goto('/');
  await page.getByLabel(/email/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();
  await dismissFirstRunOverlays(page);

  // The stream has to be up before the hold means anything.
  await expect
    .poll(() => count('GET /api/v2/rt/events'), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(1);

  const sessionsAtStart = count('POST /api/v2/rt/session');
  const streamsAtStart = count('GET /api/v2/rt/events');
  const worldAtStart =
    count('GET /api/v1/guilds/{id}/channels') +
    count('GET /api/v1/guilds/{id}/channels/visible') +
    count('GET /api/v1/guilds/{id}/members');

  await page.waitForTimeout(HOLD_MS);

  const sessions = count('POST /api/v2/rt/session') - sessionsAtStart;
  const streams = count('GET /api/v2/rt/events') - streamsAtStart;
  const world =
    count('GET /api/v1/guilds/{id}/channels') +
    count('GET /api/v1/guilds/{id}/channels/visible') +
    count('GET /api/v1/guilds/{id}/members') -
    worldAtStart;

  const report = `over ${HOLD_MINUTES} idle minutes: ${sessions} new realtime sessions, ` +
    `${streams} new streams, ${world} world refetches`;
  expect(sessions, `the client must not create a second realtime session while idle — ${report}`).toBe(0);
  expect(streams, `the client must not reopen the event stream while idle — ${report}`).toBe(0);
  expect(world, `an idle client must not refetch channels or members — ${report}`).toBe(0);
});
