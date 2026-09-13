import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

// Real-server coverage for the guided voice connection check (improvement
// item 13). Nothing here is mocked: the check reads the real
// `/api/v1/voice/transport-diagnostics` route from the release binary and then
// opens a real WebTransport session to the media endpoint that route advertises.
//
// Two network conditions are exercised:
//
//   * reachable   — the browser resolves the media host to the loopback address
//                   the harness's QUIC listener is actually bound to.
//   * blocked UDP — the page is loaded through a hostname whose *media* port is
//                   mapped to an unroutable address (TEST-NET-3), so the UDP
//                   path is silent while HTTP chat keeps working. This is what
//                   an unforwarded firewall port looks like to a real user.
//
// The blocked case is produced with Chromium's own host resolver rather than by
// intercepting a response, so the failure is a genuine QUIC timeout.

const PORT = process.env.PARACORD_E2E_PORT ?? '18150';
const MEDIA_PORT = process.env.PARACORD_E2E_MEDIA_PORT ?? '8443';
const BASE = `http://127.0.0.1:${PORT}`;
const BLOCKED_HOST = 'blockedmedia.test';

// The check deliberately spends real time: it samples the microphone, plays a
// test tone, and gives the media endpoint a bounded window to answer. The
// blocked case waits out that whole window on purpose, twice (desktop + phone).
test.setTimeout(180_000);

/** Screenshots land with the rest of this workstream's evidence. */
function shotPath(name: string): string {
  // Playwright runs with `client/` as the working directory.
  return resolve(process.cwd(), '..', 'output', 'improvement-program', 'voice-diagnostics', name);
}

const MEDIA_LAUNCH_ARGS = [
  // Deterministic capture so the microphone step does not depend on hardware.
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

/**
 * Both cases need their own Chromium flags (fake capture devices, and for the
 * blocked case a host-resolver rule), and Playwright refuses per-describe
 * `launchOptions`. Launch a dedicated browser per test instead.
 */
async function withChromium(
  playwrightFixture: { chromium: { launch: (options: { args: string[] }) => Promise<Browser> } },
  args: string[],
  extraHTTPHeaders: Record<string, string>,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const browser = await playwrightFixture.chromium.launch({ args });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders,
    });
    await context.grantPermissions(['microphone', 'camera']);
    // Without this, a locator that never resolves hangs until the test timeout
    // and reports nothing useful about which step was stuck.
    context.setDefaultTimeout(20_000);
    const page = await context.newPage();
    try {
      await body(page);
    } catch (error) {
      await page
        .screenshot({ path: shotPath(`failure-${Date.now()}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * One account for the whole file. The real server rate-limits registration, and
 * this suite shares that budget with the other real-server specs, so each test
 * signs in again rather than creating another account.
 */
let sharedAccount: Promise<{ email: string; password: string }> | null = null;

function registerSharedAccount(page: Page): Promise<{ email: string; password: string }> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `voicecheck-${unique}@example.test`;
  const username = `vc${unique}`.slice(0, 32);
  const password = 'Voice-Check-Password-123!';
  // Registration goes through the loopback address: Playwright's Node-side
  // request context does not honour Chromium's host-resolver rules, so the
  // blocked-media hostname exists only inside the browser.
  return page.request
    .post(`${BASE}/api/v1/auth/register`, { data: { email, username, password } })
    .then(async (registered) => {
      expect(
        registered.ok(),
        `register failed: ${registered.status()} ${await registered.text()}`,
      ).toBeTruthy();
      return { email, password };
    });
}

async function signIn(page: Page): Promise<void> {
  if (!sharedAccount) sharedAccount = registerSharedAccount(page);
  const { email, password } = await sharedAccount;

  // `page.request` shares the browser context's cookie jar, so a registration
  // performed on this context already authenticated it. Clear it so the UI
  // login below is a genuine sign-in rather than an immediate redirect to /app.
  await page.context().clearCookies();

  await page.goto(`${BASE}/login`);
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);

  await dismissLayoutTour(page);
}

/** A first-run layout tour overlays the app and swallows clicks. */
async function dismissLayoutTour(page: Page): Promise<void> {
  const skipTour = page.getByRole('button', { name: 'Skip tour', exact: true });
  if (await skipTour.isVisible().catch(() => false)) {
    await skipTour.click();
    await expect(skipTour).toHaveCount(0);
  }
}

async function openConnectionCheck(page: Page): Promise<void> {
  // The desktop shell has a settings button in the user panel; the phone layout
  // reaches the same surface through the bottom navigation bar.
  const desktopEntry = page.getByRole('button', { name: 'Open user settings', exact: true });
  const phoneEntry = page.getByRole('button', { name: 'Settings', exact: true });
  // Wait for whichever shell rendered before deciding, so a slow first paint
  // does not silently send a desktop run down the phone path.
  await expect(desktopEntry.or(phoneEntry).first()).toBeVisible();
  if ((await desktopEntry.count()) > 0) {
    await desktopEntry.click();
  } else {
    await phoneEntry.click();
  }
  await page.getByRole('button', { name: 'Voice & video', exact: true }).click();
  await page.getByRole('button', { name: /Run connection check/i }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Voice connection check' })).toBeVisible();
}

/** Answer the speaker step. Headless Chromium has no audible output device. */
async function answerToneQuestion(page: Page, heard: boolean): Promise<void> {
  const button = page.getByRole('button', {
    name: heard ? /Yes, I heard it/i : /No, nothing played/i,
  });
  await button.waitFor({ state: 'visible', timeout: 60_000 });
  await button.click();
}

function step(page: Page, id: string) {
  return page.getByTestId(`voice-check-step-${id}`);
}

/** Run the check from the settings pane and unblock its one interactive step. */
async function runCheck(page: Page): Promise<void> {
  await openConnectionCheck(page);
  await page.getByRole('button', { name: /^Run check$/ }).click();
  // The speaker step runs before the server is asked anything and waits for a
  // human answer, so unblock it or nothing downstream happens.
  await answerToneQuestion(page, true);
}

test.describe('voice connection check against a reachable media endpoint', () => {
  test('reads the real transport configuration and attempts a real media session', async ({
    playwright,
  }) => {
    await withChromium(playwright, MEDIA_LAUNCH_ARGS, {}, async (page) => {
      await signIn(page);

      // The check must never join a call: assert no voice join request is made.
      const joinRequests: string[] = [];
      page.on('request', (request) => {
        if (/\/voice\/[^/]+\/join/.test(request.url())) joinRequests.push(request.url());
      });

      const configResponse = page.waitForResponse(
        (response) => response.url().endsWith('/api/v1/voice/transport-diagnostics'),
        { timeout: 120_000 },
      );
      configResponse.catch(() => {});
      await runCheck(page);

      const config = await configResponse;
      expect(config.status()).toBe(200);
      const payload = await config.json();
      expect(payload.transport).toBe('native');
      expect(payload.media_udp_port).toBe(Number(MEDIA_PORT));
      expect(payload.media_endpoint).toBe(`https://127.0.0.1:${MEDIA_PORT}/media`);
      expect(typeof payload.certificate_pin_sha256).toBe('string');

      await expect(step(page, 'secure-context')).toHaveAttribute('data-status', 'pass');
      // A headless runner has no real capture hardware, so the microphone step
      // may legitimately report a problem. What must hold is that it settles
      // with a precise, named cause rather than hanging or going vague.
      await expect(step(page, 'microphone')).toHaveAttribute('data-status', /pass|warn|fail/);
      await expect(step(page, 'microphone')).toContainText(/MIC_[A-Z_]+/);
      await expect(step(page, 'media-configuration')).toHaveAttribute('data-status', 'pass');
      await expect(step(page, 'media-configuration')).toContainText(
        `https://127.0.0.1:${MEDIA_PORT}/media`,
      );

      // The transport step must settle — pass or a precisely classified failure —
      // and must never be left running or ambiguous.
      const transport = step(page, 'transport');
      await expect(transport).not.toHaveAttribute('data-status', 'pending', { timeout: 60_000 });
      await expect(transport).not.toHaveAttribute('data-status', 'running', { timeout: 60_000 });
      const status = await transport.getAttribute('data-status');
      expect(['pass', 'fail']).toContain(status);
      if (status === 'fail') {
        // A refusal here is a certificate problem, not a reachability one: the
        // media listener is bound on loopback and definitely answering.
        await expect(transport).toContainText(/TRANSPORT_(CERTIFICATE_REFUSED|HANDSHAKE_FAILED)/);
      } else {
        await expect(transport).toContainText(/Opened a media connection/);
      }

      // Export becomes available as soon as there is a report to export.
      await expect(page.getByRole('button', { name: /Export diagnostics/i })).toBeEnabled();
      expect(joinRequests, 'a diagnostic must never join a call').toEqual([]);

      await transport.scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath('voice-check-reachable-desktop.png') });
    });
  });
});

test.describe('voice connection check with the media UDP path blocked', () => {
  // The page itself stays on loopback, which browsers always treat as a secure
  // origin, so the microphone and WebTransport remain available. Only the
  // *advertised media host* is moved: an `x-forwarded-host` header is what the
  // server derives the media endpoint from, and that hostname resolves to
  // TEST-NET-3, which is guaranteed not to be routable. HTTP chat keeps working
  // while UDP media goes nowhere — exactly an unforwarded firewall port.
  const BLOCKED_ARGS = [
    ...MEDIA_LAUNCH_ARGS,
    `--host-resolver-rules=MAP ${BLOCKED_HOST} 203.0.113.1`,
  ];
  const BLOCKED_HEADERS = { 'x-forwarded-host': `${BLOCKED_HOST}:${PORT}` };

  test('names the blocked UDP path and leaves the user able to keep chatting', async ({
    playwright,
  }) => {
    await withChromium(playwright, BLOCKED_ARGS, BLOCKED_HEADERS, async (page) => {
      await signIn(page);

      const configResponse = page.waitForResponse(
        (response) => response.url().endsWith('/api/v1/voice/transport-diagnostics'),
        { timeout: 120_000 },
      );
      configResponse.catch(() => {});
      await runCheck(page);

      const payload = await (await configResponse).json();
      expect(payload.transport).toBe('native');
      expect(payload.media_endpoint).toBe(`https://${BLOCKED_HOST}:${MEDIA_PORT}/media`);

      // The server's own settings are readable over TCP, proving chat is healthy.
      await expect(step(page, 'media-configuration')).toHaveAttribute('data-status', 'pass');

      const transport = step(page, 'transport');
      await expect(transport).toHaveAttribute('data-status', 'fail', { timeout: 60_000 });
      await expect(transport).toContainText(
        /TRANSPORT_(TIMEOUT|UNREACHABLE|HANDSHAKE_FAILED|CERTIFICATE_REFUSED)/,
      );
      await expect(transport).toContainText(new RegExp(`UDP port ${MEDIA_PORT}`));
      await expect(page.getByText(/Chat is unaffected/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Export diagnostics/i })).toBeEnabled();

      await transport.scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath('voice-check-blocked-desktop.png') });

      // Same failure, phone width. Reopening after the resize (rather than
      // resizing an open dialog) matches how the app swaps shells across this
      // breakpoint, and it costs no extra sign-in.
      await page.getByText('Close', { exact: true }).click();
      await expect(page.getByRole('dialog').filter({ hasText: 'Voice connection check' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 844 });
      await runCheck(page);
      const narrow = step(page, 'transport');
      await expect(narrow).toHaveAttribute('data-status', 'fail', { timeout: 60_000 });
      await expect(narrow).toContainText(new RegExp(`UDP port ${MEDIA_PORT}`));
      await narrow.scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath('voice-check-blocked-390.png') });

      // Nothing may scroll the page sideways at this width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The user returns to chat with nothing changed.
      await page.getByText('Close', { exact: true }).click();
      await expect(page.getByRole('dialog').filter({ hasText: 'Voice connection check' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/app/);
    });
  });

});
