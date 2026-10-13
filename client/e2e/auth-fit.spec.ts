import { expect, test, type Page } from '@playwright/test';

/**
 * The fit gate for the first-run and account screens.
 *
 * The law (docs/lantern-stage-spec.md §7 surfaces, and the complaint that
 * produced it): at the desktop client's window sizes a first-run surface does
 * not scroll. The Tauri window is 1280×800 by default and 940×560 at its
 * minimum (`client/src-tauri/tauri.conf.json`); subtracting window chrome gives
 * the two viewports asserted here. A native app window that scrolls its whole
 * self is a webpage in a frame, and it is how "Continue" ends up below the fold.
 *
 * The same routes are served in a browser, so phone width is asserted the other
 * way: page scrolling there is normal and correct, and all that must hold is
 * that nothing overflows sideways and the primary action is reachable.
 *
 * Mocked exactly like `smoke.spec.ts` — this never touches a real server.
 */

/** The default window, minus title bar and borders. */
const NATIVE_DEFAULT = { width: 1280, height: 740 } as const;
/** The smallest window the client will let you make, minus the same chrome. */
const NATIVE_MIN = { width: 940, height: 500 } as const;
/** A browser at phone width, where page scrolling is the normal behavior. */
const PHONE = { width: 400, height: 844 } as const;

const NATIVE_VIEWPORTS = [
  ['1280x740', NATIVE_DEFAULT],
  ['940x500', NATIVE_MIN],
] as const;

const nowIso = new Date().toISOString();

const user = {
  id: '42',
  username: 'ada',
  display_name: 'Ada Lovelace',
  discriminator: 1,
  avatar_hash: null,
  banner_hash: null,
  accent_color: null,
  bio: null,
  pronouns: null,
  email: 'ada@example.test',
  email_verified: true,
  has_public_key: false,
  public_key: null,
  linked_accounts: [],
  bot: false,
  system: false,
  flags: 0,
  created_at: nowIso,
};

/**
 * Every request the signed-out entry screens make. `setupRequired` is a box
 * rather than a value because each screen flips it: only the first-owner claim
 * belongs to an unclaimed server, and every other entry screen redirects to it
 * while the server reports it has no owner.
 */
async function mockEntryScreens(page: Page, state: { setupRequired: boolean }) {
  await page.route('**/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (status: number, payload: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });

    if (pathname === '/api/v1/auth/refresh') return json(401, { message: 'No session' });
    if (pathname === '/api/v1/auth/options')
      return json(200, { allow_username_login: true, require_email: false });
    if (pathname === '/api/v1/setup/status')
      return json(200, { setup_required: state.setupRequired, instance_name: 'Riverside Studio' });
    if (pathname === '/api/v1/setup/password-requirements')
      return json(200, {
        min_length: 10,
        max_length: 128,
        length_unit: 'utf8_bytes',
        requires_uppercase: true,
        requires_lowercase: true,
        requires_digit: true,
        requires_symbol: true,
      });
    if (pathname === '/api/v1/instance')
      return json(200, {
        max_upload_size: 26_214_400,
        p2p_threshold: 8_388_608,
        setup_required: state.setupRequired,
        instance_name: 'Riverside Studio',
      });
    if (pathname === '/api/v1/invites/kestrel')
      return json(200, {
        code: 'kestrel',
        guild: {
          id: '1001',
          name: 'Kestrel Robotics',
          icon_hash: null,
          member_count: 24,
          description: null,
        },
        channel: { id: '2001', name: 'build-log' },
        inviter: user,
        approximate_member_count: 24,
        approximate_presence_count: 9,
        expires_at: null,
        max_uses: 0,
        uses: 3,
      });
    return json(200, []);
  });
}

/**
 * What the law actually says, in one measurement: the document does not scroll.
 * Returned rather than asserted so a failure prints the two numbers — "740 of
 * 1104" is a bug report; "expected true" is not.
 */
async function pageHeights(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[aria-label="Account access"]');
    return {
      content: document.documentElement.scrollHeight,
      window: document.documentElement.clientHeight,
      contentWidth: document.documentElement.scrollWidth,
      windowWidth: document.documentElement.clientWidth,
      // The canvas is the page's own viewport-sized surface. Measuring it as
      // well is what stops "the page does not scroll" from being satisfied by
      // quietly clipping the plate instead of fitting it.
      canvasContent: canvas ? canvas.scrollHeight : 0,
      canvasWindow: canvas ? canvas.clientHeight : 0,
    };
  });
}

async function expectNoPageScroll(page: Page, where: string) {
  await expect
    .poll(
      async () => {
        const m = await pageHeights(page);
        if (m.content > m.window + 1) return `page: ${m.content}px of content in ${m.window}px`;
        if (m.canvasContent > m.canvasWindow + 1) {
          return `plate: ${m.canvasContent}px of content in ${m.canvasWindow}px`;
        }
        return 'fits';
      },
      { message: `${where} must fit the window without scrolling or clipping` },
    )
    .toBe('fits');
  const { contentWidth, windowWidth } = await pageHeights(page);
  expect(contentWidth, `${where} must not overflow sideways`).toBeLessThanOrEqual(windowWidth + 1);
}

interface EntryScreen {
  name: string;
  url: string;
  /** The one action this screen exists to offer. */
  action: RegExp;
  /** Something that proves the screen actually rendered before we measure. */
  settled: RegExp;
}

const ENTRY_SCREENS: EntryScreen[] = [
  { name: 'login', url: '/login', action: /^Log in$/, settled: /Welcome back/ },
  { name: 'register', url: '/register', action: /^Continue$/, settled: /Create your account/ },
  // The first-owner claim is the first run's claim mode (docs/setup-spec.md
  // §2.11): it opens on Host › Name. `/connect` no longer has a screen of its
  // own (a browser with no server goes to /login, the desktop to /welcome).
  {
    name: 'setup-server',
    url: '/setup-server',
    action: /^Continue$/,
    settled: /What should we call your server\?/,
  },
  { name: 'account-setup', url: '/setup', action: /^Create identity$/, settled: /local identity/i },
  { name: 'account-recover', url: '/recover', action: /^Continue$/, settled: /Recover your account/ },
  // The web join (the first run's Join path in a browser, §1.7): the preview
  // mocked here is the pre-setup shape, so the screen names an older server;
  // what is measured is that the screen and its Continue fit.
  { name: 'invite', url: '/invite/kestrel', action: /^Continue$/, settled: /Paste your invite/ },
];

test.describe('first-run and account screens fit a native window', () => {
  test('every entry screen fits 1280x740 and 940x500 without page scroll', async ({ page }) => {
    const state = { setupRequired: false };
    await mockEntryScreens(page, state);

    for (const screen of ENTRY_SCREENS) {
      // Only the first-owner claim belongs to an unclaimed server; every other
      // entry screen redirects to it while `setup_required` is true.
      state.setupRequired = screen.name === 'setup-server';

      for (const [label, viewport] of NATIVE_VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(screen.url);
        await expect(page.getByText(screen.settled).first()).toBeVisible();

        const action = page.getByRole('button', { name: screen.action }).first();
        await expect(action, `${screen.name} at ${label} must offer its action`).toBeVisible();
        // `ratio: 1` is the point of the exercise: not "partly on screen",
        // wholly on screen without anyone scrolling to it.
        await expect(
          action,
          `${screen.name} at ${label}: the primary action must be fully visible`,
        ).toBeInViewport({ ratio: 1 });

        await expectNoPageScroll(page, `${screen.name} at ${label}`);
      }

      // Phone width is the other half of the rule: a browser page that scrolls
      // is fine there, and always was. What must hold is that nothing overflows
      // sideways and the action is still reachable.
      await page.setViewportSize(PHONE);
      await page.goto(screen.url);
      await expect(page.getByText(screen.settled).first()).toBeVisible();
      await expect(page.getByRole('button', { name: screen.action }).first()).toBeVisible();
      const { contentWidth, windowWidth } = await pageHeights(page);
      expect(contentWidth, `${screen.name} at 400x844 must not overflow sideways`).toBeLessThanOrEqual(
        windowWidth + 1,
      );
    }
  });

  test('the first-owner claim fits at every step, and Enter walks it', async ({ page }) => {
    await mockEntryScreens(page, { setupRequired: true });
    await page.setViewportSize(NATIVE_MIN);
    await page.goto('/setup-server#claim=A1B2C3D4E5F6G7H8J9K0MNPQRSTVWXYZ23456789');

    // Host › Name: the field has focus, and Enter advances like Continue.
    await expect(page.getByRole('heading', { name: 'What should we call your server?' })).toBeVisible();
    await expect(page.locator('input:focus')).toHaveCount(1);
    await page.getByTestId('fr-server-name').fill('Riverside Studio');
    await expect(page.getByRole('button', { name: /^Continue$/ }).first()).toBeInViewport({ ratio: 1 });
    await expectNoPageScroll(page, 'claim name at 940x500');
    await page.keyboard.press('Enter');

    // Host › Account.
    await expect(page.getByRole('heading', { name: 'Make your account' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Continue$/ }).first()).toBeInViewport({ ratio: 1 });
    await expectNoPageScroll(page, 'claim account at 940x500');

    // Back keeps the typed name.
    await page.getByRole('button', { name: /^Back$/ }).first().click();
    await expect(page.getByTestId('fr-server-name')).toHaveValue('Riverside Studio');
  });

  test('a long legal document scrolls its own region instead of being cut off', async ({
    page,
  }) => {
    // `html, body, #root` are `overflow: hidden` (tokens.css), so a page that
    // relies on the document scrolling is not long — it is clipped.
    await mockEntryScreens(page, { setupRequired: false });
    for (const url of ['/terms', '/privacy']) {
      await page.setViewportSize(NATIVE_DEFAULT);
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const reachable = await page.evaluate(() => {
        const sections = document.querySelectorAll('main section, article section');
        const last = sections[sections.length - 1];
        if (!last) return 'no sections rendered';
        last.scrollIntoView({ block: 'end' });
        const box = last.getBoundingClientRect();
        return box.bottom <= window.innerHeight + 1 ? 'reachable' : `${box.bottom}px past the fold`;
      });
      expect(reachable, `${url}: the end of the document must be reachable`).toBe('reachable');
    }
  });

  test('the unlock screen fits a native window', async ({ page }) => {
    await mockEntryScreens(page, { setupRequired: false });
    // The unlock screen only exists for a device that already holds an
    // identity; without one it correctly sends you to sign-in.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('paracord:account:exists', '1');
      } catch {
        /* storage unavailable */
      }
    });

    for (const [label, viewport] of NATIVE_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto('/unlock');
      const action = page.getByRole('button', { name: /^Unlock$/ });
      await expect(action).toBeVisible();
      await expect(action).toBeInViewport({ ratio: 1 });
      await expectNoPageScroll(page, `unlock at ${label}`);
    }
  });
});
