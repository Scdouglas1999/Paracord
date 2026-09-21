import { expect, test, type ChildProcess } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// First-owner claim, driven through the real UI against the real release
// binary. Like real-server-restore.spec.ts this launches its OWN isolated
// instance on an OS-assigned port rather than using the shared harness on
// :18150 — that one is deliberately bootstrapped with `require_claim = false`
// so the existing smokes can register directly, and an unclaimed instance is
// exactly what this spec needs. Nothing here is mocked: the page is the
// embedded UI served by the server, the claim token is the one pinned in the
// server's own config, and every assertion is made on what a person would see.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const binName = process.platform === 'win32' ? 'paracord-server.exe' : 'paracord-server';
const serverBin = resolve(
  process.env.PARACORD_E2E_SERVER_BIN ?? join(repoRoot, 'target', 'release', binName),
);

// Pinned so the spec can present it without scraping the server's stdout. A
// real operator reads it from the banner or from first-owner-claim.txt; both
// are asserted by scripts/release_zero_config_first_run_smoke.py.
const CLAIM_TOKEN = 'E2ESETUPCLAIMTOKEN0123456789ABCDEFGHJKMNPQRSTVWXYZ23';
const OWNER_PASSWORD = 'Owner-Setup-123!';
const MEMBER_PASSWORD = 'Member-Setup-123!';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The child must inherit no PARACORD_* deployment overrides: the TOML fixture
// below is meant to be authoritative (the shared harness exports
// PARACORD_SETUP_REQUIRE_CLAIM=false, which would void this spec's premise).
function serverEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('PARACORD_')) env[key] = value;
  }
  env.RUST_LOG = 'warn';
  return env;
}

async function freeTcpPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = probe.address();
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  if (typeof address !== 'object' || address === null || !address.port) {
    throw new Error('OS did not assign a free TCP port');
  }
  return address.port;
}

async function freeUdpPort(): Promise<number> {
  const probe = createSocket('udp4');
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.bind(0, '127.0.0.1', resolvePromise);
  });
  const port = probe.address().port;
  await new Promise<void>((resolvePromise) => {
    try {
      probe.close(() => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
  if (!port) throw new Error('OS did not assign a free UDP port');
  return port;
}

interface ServerHandle {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: boolean;
  output: () => string;
}

function launchServer(configPath: string, env: NodeJS.ProcessEnv): ServerHandle {
  const child = spawn(serverBin, ['-c', configPath], { cwd: repoRoot, env });
  let output = '';
  const handle: ServerHandle = {
    child,
    hasExited: false,
    output: () => output,
    exited: new Promise<void>((resolvePromise) => {
      child.on('exit', () => {
        handle.hasExited = true;
        resolvePromise();
      });
      child.on('error', (error) => {
        output += `\n[setup-spec] spawn error: ${error.message}\n`;
        handle.hasExited = true;
        resolvePromise();
      });
    }),
  };
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 200_000) output = output.slice(-120_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return handle;
}

async function waitForHealth(handle: ServerHandle, base: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (handle.hasExited) {
      throw new Error(`server exited before becoming healthy\n${handle.output()}`);
    }
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`server never became healthy (${lastError})\n${handle.output()}`);
}

async function stopServer(handle: ServerHandle) {
  if (handle.hasExited) return;
  // Only the child this spec spawned is ever signalled.
  handle.child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    handle.exited,
    new Promise<void>((r) => {
      timer = setTimeout(r, 15_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!handle.hasExited) {
    handle.child.kill('SIGKILL');
    await handle.exited;
  }
}

test.describe('first-owner claim on a real unclaimed server', () => {
  test.skip(!existsSync(serverBin), `release server binary not built at ${serverBin}`);
  test.setTimeout(180_000);

  test('an unclaimed server is claimed through the UI, then takes ordinary members', async ({
    browser,
  }) => {
    const env = serverEnvironment();
    const dataDir = await mkdtemp(join(tmpdir(), 'paracord-e2e-setup-'));
    const configPath = join(dataDir, 'paracord.toml');
    const httpPort = await freeTcpPort();
    const udpPort = await freeUdpPort();
    const base = `http://127.0.0.1:${httpPort}`;
    const unique = Date.now();
    const ownerName = `owner${unique}`;
    const memberName = `member${unique}`;

    let server: ServerHandle | null = null;
    const pageErrors: string[] = [];

    const toml = (value: string) => JSON.stringify(value);
    try {
      await mkdir(join(dataDir, 'uploads'), { recursive: true });
      await mkdir(join(dataDir, 'files'), { recursive: true });
      await mkdir(join(dataDir, 'backups'), { recursive: true });
      await writeFile(
        configPath,
        [
          '[server]',
          `bind_address = ${toml(`127.0.0.1:${httpPort}`)}`,
          'server_name = "setup-e2e"',
          '',
          '[database]',
          'engine = "sqlite"',
          `url = ${toml(`sqlite://${join(dataDir, 'paracord.db')}?mode=rwc`)}`,
          '',
          '[auth]',
          `jwt_secret = ${toml(randomBytes(32).toString('hex'))}`,
          'registration_enabled = true',
          'require_email = true',
          '',
          '[setup]',
          'require_claim = true',
          `claim_token = ${toml(CLAIM_TOKEN)}`,
          '',
          '[storage]',
          'storage_type = "local"',
          `path = ${toml(join(dataDir, 'uploads'))}`,
          '',
          '[media]',
          `storage_path = ${toml(join(dataDir, 'files'))}`,
          '',
          '[voice]',
          'native_media = true',
          `port = ${udpPort}`,
          '',
          '[tls]',
          'enabled = false',
          '',
          '[backup]',
          `backup_dir = ${toml(join(dataDir, 'backups'))}`,
          'auto_backup_enabled = false',
          '',
        ].join('\n'),
      );

      server = launchServer(configPath, env);
      await waitForHealth(server, base);

      // A pinned token means the server must NOT write the generated-token
      // file: the operator already has the secret, and duplicating it would
      // widen its exposure for no benefit.
      await expect(
        stat(join(dataDir, 'first-owner-claim.txt')).then(
          () => 'exists',
          () => 'absent',
        ),
      ).resolves.toBe('absent');

      const context = await browser.newContext({ baseURL: base });
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));

      // 1. Landing on sign-in must not leave the operator staring at "Welcome
      //    back" on a server with no accounts.
      await page.goto('/login');
      await expect(page.getByText('Set up your Paracord instance')).toBeVisible();
      await expect(page).toHaveURL(/\/setup-server$/);

      // 2. Step one says who this is for, and where the token comes from.
      await expect(page.getByText('Step 1 of 4')).toBeVisible();
      await expect(
        page.getByText(/This makes you the owner/),
      ).toBeVisible();
      await expect(page.getByText(/first-owner-claim\.txt/)).toBeVisible();

      // The claim is a wizard, so this walks it the way an operator does: one
      // decision per step, Continue between them, and the claim only on the
      // last. Nothing may be off the window at any point — the fit law is
      // asserted for every route in e2e/auth-fit.spec.ts; here the concern is
      // that the stepped flow still claims a real server.
      const continueButton = page.getByRole('button', { name: 'Continue' });
      const claimButton = page.getByRole('button', { name: 'Claim this instance' });

      // 3. A wrong token is refused, and says so, without creating anything.
      //    It is only the claim itself that can know that, so the wizard is
      //    walked to the end before the server ever sees it.
      await page.getByLabel(/Setup code/).fill('X'.repeat(CLAIM_TOKEN.length));
      await continueButton.click();

      await expect(page.getByText('Step 2 of 4')).toBeVisible();
      await page.getByLabel(/Username/).fill(ownerName);
      await page.getByLabel(/Email/).fill(`${ownerName}@example.test`);
      await continueButton.click();

      // The server's own password rules are stated on the step that asks for one.
      await expect(page.getByText('Step 3 of 4')).toBeVisible();
      await expect(page.getByText(/10–128 bytes/)).toBeVisible();
      await page.getByLabel(/^Password/).fill(OWNER_PASSWORD);
      await page.getByLabel(/Confirm password/).fill(OWNER_PASSWORD);
      await continueButton.click();

      await expect(page.getByText('Step 4 of 4')).toBeVisible();
      await page.getByLabel(/Instance name/).fill('Riverside Studio');
      await page.getByLabel(/First server name/).fill('The Lounge');
      await claimButton.click();
      await expect(page.getByText(/not the one your server printed/)).toBeVisible();
      await expect(page).toHaveURL(/\/setup-server$/);

      // 4. The code is the thing that was wrong, so the wizard returns to it by
      //    itself — and every value typed on the way is still there.
      await expect(page.getByLabel(/Setup code/)).toHaveValue('X'.repeat(CLAIM_TOKEN.length));
      await page.getByLabel(/Setup code/).fill(CLAIM_TOKEN);
      await continueButton.click();
      await expect(page.getByLabel(/Username/)).toHaveValue(ownerName);
      await continueButton.click();
      await expect(page.getByLabel(/^Password/)).toHaveValue(OWNER_PASSWORD);
      await continueButton.click();
      await expect(page.getByLabel(/Instance name/)).toHaveValue('Riverside Studio');
      await expect(page.getByLabel(/First server name/)).toHaveValue('The Lounge');

      // 5. The real token claims the server and lands the owner in the space it
      //    just created.
      await claimButton.click();
      await page.waitForURL(/\/app\/guilds\/\d+/, { timeout: 60_000 });
      await expect(page.getByText('The Lounge').first()).toBeVisible({ timeout: 30_000 });

      // 6. The server now reports itself as claimed, by name.
      const statusResponse = await context.request.get(`${base}/api/v1/setup/status`);
      expect(statusResponse.status()).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        setup_required: false,
        instance_name: 'Riverside Studio',
      });

      // 7. The owner is an administrator; the token is spent.
      const me = await context.request.get(`${base}/api/v1/users/@me`);
      expect(me.status()).toBe(200);
      const owner = await me.json();
      expect(owner.username).toBe(ownerName);
      expect(Number(owner.flags) & 1).toBe(1);

      await context.close();

      // The replay that matters is an anonymous one — the owner's own context
      // carries session cookies and would be turned away by CSRF before the
      // claim handler ever saw it, which proves nothing about the token.
      const stranger = await browser.newContext({ baseURL: base });
      try {
        const replay = await stranger.request.post(`${base}/api/v1/setup/claim`, {
          data: {
            token: CLAIM_TOKEN,
            username: `usurper${unique}`,
            email: `usurper${unique}@example.test`,
            password: OWNER_PASSWORD,
            instance_name: 'Hijacked',
            initial_space_name: 'Mine Now',
          },
        });
        expect(replay.status(), await replay.text()).toBe(409);
      } finally {
        await stranger.close();
      }

      // 8. Somebody else arriving afterwards registers normally and is a
      //    member, not an operator. This is the distinction the setup page
      //    promises, checked against the server rather than the copy.
      const memberContext = await browser.newContext({ baseURL: base });
      try {
        const registration = await memberContext.request.post(`${base}/api/v1/auth/register`, {
          data: {
            email: `${memberName}@example.test`,
            username: memberName,
            password: MEMBER_PASSWORD,
          },
        });
        expect(registration.status(), await registration.text()).toBe(201);
        const member = (await registration.json()).user;
        expect(Number(member.flags) & 1).toBe(0);

      } finally {
        await memberContext.close();
      }

      // A claimed server shows sign-in, not the claim flow. Checked from a
      // context with no session of its own: registering above left cookies on
      // the member context, and a signed-in browser is sent to /app instead.
      const anonymous = await browser.newContext({ baseURL: base });
      try {
        const anonymousPage = await anonymous.newPage();
        anonymousPage.on('pageerror', (error) => pageErrors.push(error.message));
        await anonymousPage.goto('/login');
        await expect(anonymousPage.getByLabel(/Email|Username/i).first()).toBeVisible();
        await expect(anonymousPage).toHaveURL(/\/login$/);
        await expect(anonymousPage.getByText('Set up your Paracord instance')).toHaveCount(0);
      } finally {
        await anonymous.close();
      }

      expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);
    } finally {
      if (server) await stopServer(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
