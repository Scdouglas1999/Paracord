import { expect, test } from '@playwright/test';

// Real-server smoke: unlike smoke.spec.ts, this test does NOT mock any /api
// route. It runs against the actual release `paracord-server` binary launched by
// e2e/real-server-harness.mjs, which serves the embedded web UI out of
// client/dist/ and a throwaway SQLite database. This is the only E2E coverage
// that exercises embedded-asset serving, real auth, and real REST contract
// shapes end to end. Keep it lean — the mocked smoke remains the fast gate.

const PORT = process.env.PARACORD_E2E_PORT ?? '18150';
const BASE = `http://127.0.0.1:${PORT}`;

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
  // Server password policy: 10-128 chars with upper, lower, digit, and special.
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
