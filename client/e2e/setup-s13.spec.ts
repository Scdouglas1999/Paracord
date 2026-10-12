/**
 * The first run, held against the S13a references (docs/design/setup-plan.md
 * S13, §5.3). Every state the plan lists is driven through the real UI on the
 * mocked first-run scene and shot at 1280x800 into
 * output/design-reference/setup-build/<WP>/; `node e2e/setup-compare.mjs <WP>`
 * lays them beside the references.
 *
 *   PARACORD_E2E_SETUP_SPEC=setup-s13 PARACORD_E2E_SETUP_PORT=5003 PARACORD_E2E_SETUP_RT_PORT=5005 \
 *   PARACORD_E2E_SETUP_WP=s13 npx playwright test -c e2e/setup-review.config.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { CLOCK, FINGERPRINT, KANTO, inviteUrl, installSetupScene, showWords, type SetupScene, type SetupSceneOptions } from './fixtures/setup';

const NOW_S = Math.floor(Date.parse(CLOCK.start) / 1000);
const HOME = 'https://127.0.0.1:8443';
const FRIEND = `https://${KANTO.host}:${KANTO.port}`;
const GUILD = '510000000000000001';
const GENERAL = '510000000000000002';

/** Skip the launch for every shot but the launch's own. */
async function launchSeen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('paracord:v2:firstRun.launchSeen', '1');
    } catch {
      /* ignore */
    }
  });
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

let lastUser = { username: 'sam', display: 'Sam' };

function user(username: string, display: string) {
  lastUser = { username, display };
  return {
    id: '520000000000000001',
    username,
    display_name: display,
    discriminator: 1,
    avatar_hash: null,
    banner_hash: null,
    accent_color: null,
    bio: null,
    pronouns: null,
    email: `${username}@example.test`,
    email_verified: true,
    has_public_key: false,
    public_key: null,
    linked_accounts: [],
    bot: false,
    system: false,
    flags: 0,
    created_at: CLOCK.start,
  };
}

const SETTINGS = {
  user_id: '520000000000000001',
  theme: 'dark',
  locale: 'en-US',
  message_display_compact: false,
  custom_css: null,
  status: 'online',
  custom_status: null,
  crypto_auth_enabled: false,
  notifications: {},
  keybinds: {},
  link_previews: true,
  link_previews_available: true,
};

/** The REST a new account makes on a server (home or friend's): challenge, register/claim, settings, invites. */
async function accountRoutes(page: Page, server: string): Promise<void> {
  await page.route(`${server}/api/v1/auth/challenge`, (route) => route.fulfill(json({ nonce: 'n0nce-s13', timestamp: NOW_S, server_origin: server })));
  await page.route(`${server}/api/v1/auth/credential/register`, (route) => {
    const body = route.request().postDataJSON() as { username: string; display_name: string | null };
    return route.fulfill(json({ token: 'tok-s13', refresh_token: 'refresh-s13', user: user(body.username, body.display_name ?? body.username) }, 201));
  });
  await page.route(`${server}/api/v1/users/@me`, (route) => route.fulfill(json(user(lastUser.username, lastUser.display))));
  await page.route(`${server}/api/v1/users/@me/settings`, (route) => route.fulfill(json(SETTINGS)));
  await page.route(`${server}/api/v1/users/@me/guilds`, (route) => route.fulfill(json([])));
  await page.route(`${server}/api/v1/admin/**`, (route) => route.fulfill(json({})));
  await page.route(`${server}/api/v1/users/@me/key-backup/recovery-confirmed`, (route) => route.fulfill({ status: 204, body: '' }));
  await page.route(`${server}/api/v1/guilds/*/channels`, (route) => route.fulfill(json([{ id: GENERAL, name: 'general', type: 0, position: 0 }])));
  await page.route(`${server}/api/v1/instance/share-address`, (route) => route.fulfill(json({ url: 'https://73.162.4.19:8443', reach: 'internet' })));
  await page.route(`${server}/api/v1/channels/*/invites`, (route) =>
    route.fulfill(json({ code: 'k7Qm2xR', channel_id: GENERAL, guild_id: GUILD, inviter_id: null, created_at: CLOCK.start, max_age: 604800, max_uses: 25, uses: 0 })),
  );
  await page.route(`${server}/api/v1/invites/*`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill(
      json({ guild: { id: GUILD, name: KANTO.name, description: null, icon_hash: null, owner_id: '1', member_count: 42, created_at: CLOCK.start, default_channel_id: GENERAL } }),
    );
  });
}

/** The desktop host's claim answer (S7 `host_claim`). */
function scriptClaim(scene: SetupScene, hold?: Promise<void>): void {
  scene.host!.claim = (request) => {
    const r = request as { username: string; display_name: string | null; initial_space_name: string };
    const answer = { token: 'tok-host', refresh_token: 'refresh-host', user: user(r.username, r.display_name ?? r.username), space: { id: GUILD, name: r.initial_space_name, system_channel_id: GENERAL }, instance_name: r.initial_space_name };
    return hold ? hold.then(() => answer) : answer;
  };
}

async function shoot(scene: SetupScene, name: string): Promise<void> {
  // Let entrances settle (screen swap 240 ms, card 400 ms) before the shot.
  await scene.page.waitForTimeout(650);
  await scene.shoot(name);
}

async function welcome(page: Page, options: SetupSceneOptions = {}): Promise<SetupScene> {
  await launchSeen(page);
  const scene = await installSetupScene(page, options);
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: 'Welcome to Paracord' })).toBeVisible();
  return scene;
}

async function toHostName(page: Page, options: SetupSceneOptions = {}): Promise<SetupScene> {
  const scene = await welcome(page, options);
  await page.getByTestId('fr-choose-host').click();
  await expect(page.getByRole('heading', { name: 'What should we call your server?' })).toBeVisible();
  return scene;
}

async function fillName(page: Page): Promise<void> {
  await page.getByTestId('fr-server-name').fill('Friday Night Crew');
}

async function fillAccount(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Make your account' })).toBeVisible();
  await expect(page.locator('[data-step="account"]')).toHaveAttribute('data-state', 'on');
  await page.getByTestId('fr-display-name').fill('Sam');
  await page.getByTestId('fr-password').fill('paper lantern orbit');
  await expect(page.getByTestId('fr-password-help')).toHaveText('Strong.');
}

test.describe('launch and welcome', () => {
  test('launch', async ({ page }) => {
    const scene = await installSetupScene(page);
    await page.goto('/welcome');
    await expect(page.getByTestId('fr-launch')).toBeVisible();
    await scene.shoot('launch-1150ms');
    await expect(page.getByTestId('fr-launch')).toBeHidden({ timeout: 6_000 });
    await shoot(scene, 'welcome-after-launch');
  });

  test('welcome, hover and choose', async ({ page }) => {
    const scene = await welcome(page);
    await shoot(scene, 'welcome');
    await page.getByTestId('fr-choose-host').hover();
    await shoot(scene, 'welcome-hover-host');
    await page.getByTestId('fr-choose-join').hover();
    await shoot(scene, 'welcome-hover-join');
    await page.getByTestId('fr-choose-host').click();
    await page.waitForTimeout(140);
    await scene.shoot('welcome-choose-host-140ms');
  });

  test('a clipboard invite moves the welcome to Join', async ({ page }) => {
    await launchSeen(page);
    const scene = await installSetupScene(page, { clipboard: inviteUrl('Rf8kQ2') });
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: 'Paste your invite' })).toBeVisible();
    await expect(page.getByTestId('fr-clipboard-banner')).toBeVisible();
    await shoot(scene, 'welcome-clipboard');
    await shoot(scene, 'join-invite-clipboard');
  });
});

test.describe('host', () => {
  test('name, blocked, account', async ({ page }) => {
    const scene = await toHostName(page);
    await shoot(scene, 'host-name-empty');
    await fillName(page);
    await page.getByRole('radio', { name: 'Green' }).click();
    await shoot(scene, 'host-name-typed');
    await page.getByRole('radio', { name: 'Ember' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Make your account' })).toBeVisible();
    await shoot(scene, 'account-empty');
    await page.getByTestId('fr-display-name').fill('Sam');
    await page.getByTestId('fr-password').fill('paperlan');
    await shoot(scene, 'account-weak');
    await page.getByTestId('fr-password').fill('paper lantern orbit');
    await expect(page.getByTestId('fr-password-help')).toHaveText('Strong.');
    await shoot(scene, 'account-strong');
  });

  for (const reason of ['no_user_services', 'no_keychain', 'existing_server', 'no_port', 'no_space'] as const) {
    test(`preflight refuses: ${reason}`, async ({ page }) => {
      const scene = await toHostName(page, { preflight: reason });
      await expect(page.getByTestId('fr-preflight-block')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await shoot(scene, `host-name-blocked-${reason}`);
    });
  }

  for (const reach of ['open', 'refused', 'no_answer', 'shared_address'] as const) {
    test(`setup with the router ${reach}`, async ({ page }) => {
      const scene = await toHostName(page, { reach, progressDelayMs: 40 });
      let release: () => void = () => undefined;
      const held = reach === 'open' ? new Promise<void>((resolve) => (release = resolve)) : undefined;
      scriptClaim(scene, held);
      await accountRoutes(page, HOME);
      await fillName(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillAccount(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Setting up your server' })).toBeVisible();
      if (held) {
        await expect(page.locator('[data-row="3"]')).toHaveAttribute('data-state', 'run', { timeout: 15_000 });
        await shoot(scene, 'host-setup-running');
        release();
      }
      await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
      const name = reach === 'open' ? 'host-setup-done' : reach === 'shared_address' ? 'host-setup-shared' : reach === 'no_answer' ? 'host-setup-no-answer' : 'host-setup-refused';
      await shoot(scene, name);
      if (reach === 'refused') {
        await page.getByRole('button', { name: 'Show me how' }).click();
        await expect(page.getByTestId('fr-router-sheet')).toBeVisible();
        await shoot(scene, 'router-sheet');
        await page.getByRole('button', { name: 'Got it' }).click();
      }
      if (reach === 'shared_address') {
        await page.getByRole('button', { name: 'What can I do?' }).click();
        await shoot(scene, 'shared-sheet');
        await page.getByRole('button', { name: 'Got it' }).click();
      }
      if (reach !== 'open') return;
      await page.getByTestId('fr-see-protected').click();
      await expect(page.getByTestId('protected-rows')).toBeVisible();
      await shoot(scene, 'privacy-sheet-host');
      await page.getByRole('button', { name: 'Done' }).click();
      await page.getByTestId('fr-setup-continue').click();
      await expect(page.getByRole('heading', { name: 'Save your recovery phrase' })).toBeVisible();
      await shoot(scene, 'phrase-blurred');
      await page.getByTestId('fr-show-words').click();
      await shoot(scene, 'phrase-revealed');
      await page.getByTestId('fr-phrase-saved').check();
      await page.getByTestId('fr-phrase-continue').click();
      await expect(page.getByRole('heading', { name: 'Invite your friends' })).toBeVisible();
      await expect(page.getByTestId('fr-invite-link')).toContainText('https://73.162.4.19:8443/invite/k7Qm2xR');
      await shoot(scene, 'host-invite-internet');
      await page.getByTestId('fr-open-server').click();
      await page.waitForTimeout(360);
      await scene.shoot('done-host');
      scene.expectNothingUnhandled = () => undefined;
    });
  }

  test('a row that fails', async ({ page }) => {
    const scene = await toHostName(page, { setup: 'start_fail', progressDelayMs: 30 });
    await fillName(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillAccount(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('[data-row="1"]')).toHaveAttribute('data-state', 'fail', { timeout: 15_000 });
    await shoot(scene, 'host-setup-fail');
  });
});

test.describe('join', () => {
  async function toJoin(page: Page, options: SetupSceneOptions = {}): Promise<SetupScene> {
    if (options.clipboard) {
      // A clipboard invite takes the welcome straight to Join (§1.3).
      await launchSeen(page);
      const scene = await installSetupScene(page, options);
      await page.goto('/welcome');
      await expect(page.getByRole('heading', { name: 'Paste your invite' })).toBeVisible();
      return scene;
    }
    const scene = await welcome(page, options);
    await page.getByTestId('fr-choose-join').click();
    await expect(page.getByRole('heading', { name: 'Paste your invite' })).toBeVisible();
    return scene;
  }

  test('invite states', async ({ page }) => {
    const scene = await toJoin(page);
    await shoot(scene, 'join-invite-empty');
    await page.getByTestId('fr-invite-field').fill(inviteUrl('Gone404'));
    await expect(page.getByTestId('fr-invite-error')).toBeVisible();
    await shoot(scene, 'join-invite-invalid');
    await page.getByTestId('fr-invite-field').fill(inviteUrl('Unreach1'));
    await expect(page.getByTestId('fr-invite-error')).toContainText(/Can.t reach/);
    await shoot(scene, 'join-invite-unreachable');
    await page.getByTestId('fr-invite-field').fill(inviteUrl('OldSrv1'));
    await expect(page.getByTestId('fr-invite-error')).toContainText('older version');
    await shoot(scene, 'join-invite-old-server');
    await page.getByTestId('fr-invite-field').fill(inviteUrl('CaOk1'));
    await expect(page.getByTestId('fr-server-card')).toBeVisible();
    await shoot(scene, 'join-invite-ca-verified');
    await page.getByTestId('fr-invite-field').fill(inviteUrl('Rf8kQ2'));
    await expect(page.getByTestId('fr-trust-words')).toHaveText(showWords(FINGERPRINT.kanto));
    await shoot(scene, 'join-invite-card');
  });

  test('checking', async ({ page }) => {
    const scene = await toJoin(page);
    await page.getByTestId('fr-invite-field').fill(inviteUrl('Rf8kQ2'));
    await expect(page.getByTestId('fr-invite-checking')).toBeVisible();
    await scene.shoot('join-invite-checking');
  });

  test('the whole join', async ({ page }) => {
    const scene = await toJoin(page, { clipboard: inviteUrl('Rf8kQ2') });
    await accountRoutes(page, FRIEND);
    await page.getByRole('button', { name: 'Use it' }).click();
    await expect(page.getByTestId('fr-server-card')).toBeVisible();
    await page.getByTestId('fr-invite-continue').click();
    await expect(page.getByRole('heading', { name: 'Make your account' })).toBeVisible();
    await fillAccount(page);
    await shoot(scene, 'join-account');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
    await shoot(scene, 'join-setup-done');
    await page.getByTestId('fr-see-protected').click();
    await shoot(scene, 'privacy-sheet-join');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('fr-setup-continue').click();
    await page.getByTestId('fr-show-words').click();
    await page.getByTestId('fr-phrase-saved').check();
    await shoot(scene, 'join-phrase');
    await page.getByTestId('fr-phrase-continue').click();
    await page.waitForTimeout(360);
    await scene.shoot('done-join');
  });
});

test.describe('lan, identity, sign in', () => {
  test('the invite on the home network only', async ({ page }) => {
    const scene = await toHostName(page, { reach: 'refused', progressDelayMs: 30 });
    scriptClaim(scene);
    await accountRoutes(page, HOME);
    await page.route(`${HOME}/api/v1/instance/share-address`, (route) => route.fulfill(json({ url: 'https://192.168.1.28:8443', reach: 'local_network' })));
    await fillName(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillAccount(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('fr-setup-continue').click();
    await page.getByTestId('fr-phrase-saved').check();
    await page.getByTestId('fr-phrase-continue').click();
    await expect(page.getByTestId('fr-lan-note')).toBeVisible();
    await expect(page.getByTestId('fr-invite-link')).toContainText('https://192.168.1.28:8443/invite/k7Qm2xR');
    await shoot(scene, 'host-invite-lan');
  });

  test('a server whose identity changed', async ({ page }) => {
    const scene = await welcome(page);
    scene.host!.pinned.set(KANTO.host, FINGERPRINT.kanto);
    await scene.host!.rekey(KANTO.host, { fingerprint: FINGERPRINT.kantoReissued, caVerified: false });
    await page.getByTestId('fr-choose-join').click();
    await page.getByTestId('fr-invite-field').fill(inviteUrl('Rf8kQ2'));
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await shoot(scene, 'identity-changed');
  });

  async function signInRoutes(page: Page, mode: 'mfa' | 'legacy' | 'ok'): Promise<void> {
    await page.route(`${FRIEND}/api/v1/auth/credential/params`, (route) =>
      route.fulfill(json(mode === 'legacy' ? { version: 1 } : { version: 2, kdf: { alg: 'scrypt', log_n: 17, r: 8, p: 1 }, salt: 'A'.repeat(43), epoch: 1 })),
    );
    await page.route(`${FRIEND}/api/v1/auth/credential/login`, (route) => route.fulfill(json({ user: { mfa_required: true, mfa_ticket: 'ticket-s13' } })));
  }

  for (const state of ['empty', 'probed', 'mfa', 'legacy'] as const) {
    test(`sign in: ${state}`, async ({ page }) => {
      const scene = await welcome(page);
      await signInRoutes(page, state === 'legacy' ? 'legacy' : 'mfa');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      if (state === 'empty') return shoot(scene, 'sign-in-empty');
      await page.getByTestId('fr-sign-in-server').fill(`${KANTO.host}:${KANTO.port}`);
      await expect(page.getByTestId('fr-trust-row')).toBeVisible();
      await page.getByTestId('fr-sign-in-user').fill('sam');
      await page.getByTestId('fr-sign-in-password').fill('paper lantern orbit');
      if (state === 'probed') return shoot(scene, 'sign-in-probed');
      await page.getByTestId('fr-sign-in-submit').click();
      if (state === 'mfa') {
        await expect(page.getByTestId('fr-mfa-code')).toBeVisible({ timeout: 15_000 });
        await page.getByTestId('fr-mfa-code').fill('428913');
        return shoot(scene, 'sign-in-mfa');
      }
      await expect(page.getByTestId('fr-legacy-password')).toBeVisible({ timeout: 15_000 });
      await shoot(scene, 'sign-in-legacy');
    });
  }
});

test.describe('claim mode (a headless install, web)', () => {
  const TOKEN = 'ClaimTokenForTheS13Scene0123456789';
  for (const atRest of ['on', 'off'] as const) {
    test(`claim with stored-data encryption ${atRest}`, async ({ page }) => {
      const scene = await installSetupScene(page, { desktop: false });
      const origin = 'http://127.0.0.1:' + (process.env.PARACORD_E2E_SETUP_PORT ?? '4993');
      await accountRoutes(page, origin);
      await page.route(`${origin}/api/v1/setup/credential-claim`, (route) => {
        const body = route.request().postDataJSON() as { username: string; display_name: string | null; initial_space_name: string; token: string };
        if (body.token !== TOKEN) return route.fulfill(json({ code: 'unauthorized', message: 'unauthorized' }, 401));
        return route.fulfill(json({ token: 'tok-claim', refresh_token: 'refresh-claim', user: user(body.username, body.display_name ?? body.username), space: { id: GUILD, name: body.initial_space_name, system_channel_id: GENERAL }, instance_name: body.initial_space_name }, 201));
      });
      await page.route(`${origin}/api/v1/admin/host-status`, (route) =>
        route.fulfill(
          json({
            version: '3.5.0',
            started_at: CLOCK.start,
            setup_required: false,
            storage: atRest === 'on'
              ? { enabled: true, sqlite_encrypted: true, files_encrypted: true, key_source: 'systemd-creds', protection: 'tpm', escrowed: false }
              : { enabled: false, sqlite_encrypted: false, files_encrypted: false, key_source: null, protection: null, escrowed: false },
            reachability: { state: 'open', method: 'upnp', external_ip: '73.162.4.19', gateway_ip: '192.168.1.1', lan_ip: '192.168.1.28', port: 8443, lease_expires_at: null, next_retry_at: null, last_error: null, confirmed_at: null },
            backups: { enabled: true, interval_seconds: 86400, keep: 14, last_backup_at: null, last_error: null },
            tls: { fingerprint_sha256: FINGERPRINT.kanto, self_signed: true },
          }),
        ),
      );
      await page.goto(`/setup-server#claim=${TOKEN}`);
      await expect(page.getByRole('heading', { name: 'What should we call your server?' })).toBeVisible();
      await fillName(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillAccount(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
      await shoot(scene, `claim-mode-setup-at-rest-${atRest}`);
      if (atRest === 'on') await shoot(scene, 'claim-mode-setup-web');
    });
  }
});

test.describe('other windows (spec §1.1)', () => {
  const OUT = 'output/design-reference/setup-build/' + (process.env.PARACORD_E2E_SETUP_WP ?? 'latest') + '/viewports';
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `../${OUT}/${name}.png`, animations: 'allow' });
  };
  for (const [w, h] of [
    [1040, 680],
    [900, 700],
  ] as const) {
    test(`desktop ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await launchSeen(page);
      const scene = await installSetupScene(page, { progressDelayMs: 30 });
      scriptClaim(scene);
      await accountRoutes(page, HOME);
      await page.goto('/welcome');
      await expect(page.getByRole('heading', { name: 'Welcome to Paracord' })).toBeVisible();
      await page.waitForTimeout(600);
      await shot(page, `welcome-${w}x${h}`);
      await page.getByTestId('fr-choose-host').click();
      await fillName(page);
      await page.waitForTimeout(400);
      await shot(page, `host-name-${w}x${h}`);
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillAccount(page);
      await shot(page, `account-${w}x${h}`);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await shot(page, `setup-${w}x${h}`);
      await page.getByTestId('fr-setup-continue').click();
      await page.getByTestId('fr-show-words').click();
      await page.getByTestId('fr-phrase-saved').check();
      await page.waitForTimeout(400);
      await shot(page, `phrase-${w}x${h}`);
      await page.getByTestId('fr-phrase-continue').click();
      await expect(page.getByTestId('fr-invite-link')).toContainText('/invite/');
      await page.waitForTimeout(400);
      await shot(page, `invite-${w}x${h}`);
    });
  }

  test('phone 390x844 (web join)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const origin = 'http://127.0.0.1:' + (process.env.PARACORD_E2E_SETUP_PORT ?? '4993');
    await installSetupScene(page, { desktop: false });
    await accountRoutes(page, origin);
    await page.route(`${origin}/api/v1/invites/Rf8kQ2`, (route) =>
      route.request().method() === 'GET' ? route.fulfill(json({ code: 'Rf8kQ2', guild: { id: GUILD, name: KANTO.name, hue: KANTO.hue, online_count: 9, member_count: 41, icon_hash: null }, faces: KANTO.faces, join_gate: null, expires_at: null, instance: { name: KANTO.name, version: '3.5.0', credential_version: 2, registration_mode: 'invite_only', require_email: false } })) : route.fallback(),
    );
    await page.goto('/invite/Rf8kQ2');
    await expect(page.getByTestId('fr-server-card')).toBeVisible();
    await expect(page.getByTestId('fr-trust-row')).toContainText("on 127.0.0.1");
    await page.waitForTimeout(500);
    await shot(page, 'join-invite-390x844');
    await page.getByTestId('fr-invite-continue').click();
    await fillAccount(page);
    await shot(page, 'join-account-390x844');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
    await shot(page, 'join-setup-390x844');
    await page.getByTestId('fr-setup-continue').click();
    await page.getByTestId('fr-show-words').click();
    await page.getByTestId('fr-phrase-saved').check();
    await shot(page, 'join-phrase-390x844');
  });
});

test('nothing moves at rest (index-spec §1.2, setup-spec §0.4)', async ({ page }) => {
  const scene = await toHostName(page, { progressDelayMs: 20 });
  const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'animation'));
  await page.waitForTimeout(2000);
  expect(await running()).toEqual([]);
  scriptClaim(scene);
  await accountRoutes(page, HOME);
  await fillName(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(2000);
  expect(await running()).toEqual([]);
});
