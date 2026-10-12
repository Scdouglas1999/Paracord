import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerOnePassword, signInOnePassword } from '../scripts/lib/credential-node.mjs';

// A saved server must come back by itself, or say why it cannot, against real servers.
//
// After a relaunch the desktop app sat on "This server is not available": the access
// token had expired while it was closed (they last fifteen minutes), the refresh that
// should have renewed it was lost, and nothing ever tried again. Mocked suites cannot
// say whether a real server accepts the refresh the client sends, refuses a revoked
// one, or lets a client back in after a restart. This drives the client (the dev
// build, cross-origin, as the desktop is) against two real paracord-server
// instances it starts itself:
//
//   Lantern  the saved server under test: an expired access token at first, then a
//            restart, then a session revoked on the server
//   Cedar    a second saved server with a good session, so the app stays signed in
//            (with no session left at all the app shows the sign-in screen instead)
//
//   cd client && PARACORD_E2E_REAL=1 npx playwright test real-server.session-recovery
//
// Needs the release server binary (cargo build --release --bin paracord-server, or
// PARACORD_E2E_SERVER_BIN). The client is served from source by Vite on its own port
// (PARACORD_E2E_RECOVERY_APP_PORT, default 4923); the two servers take
// PARACORD_E2E_RECOVERY_PORT and the port two above it (default 18171, 18173), and
// each the next UDP port for voice. PARACORD_E2E_RECOVERY_DEBUG=1 prints every
// request the servers saw and the page's console.

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..');
const repoRoot = join(clientDir, '..');
const SERVER_BIN = process.env.PARACORD_E2E_SERVER_BIN ?? join(repoRoot, 'target', 'release', 'paracord-server');
const APP_PORT = Number(process.env.PARACORD_E2E_RECOVERY_APP_PORT ?? 4923);
const APP = `http://127.0.0.1:${APP_PORT}`;
const PASSWORD = 'Recovery-Password-123!';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

interface Instance {
  name: string;
  port: number;
  url: string;
  secret: string;
  dataDir: string;
  child: ChildProcess | null;
  requests: string[];
}

function instance(name: string, port: number): Instance {
  return {
    name,
    port,
    url: `http://127.0.0.1:${port}`,
    secret: `session-recovery-${name}-secret-0123456789abcdef0123`,
    dataDir: mkdtempSync(join(tmpdir(), `paracord-e2e-recovery-${name}-`)),
    child: null,
    requests: [],
  };
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function start(server: Instance): Promise<void> {
  const env = {
    ...process.env,
    PARACORD_BIND_ADDRESS: `127.0.0.1:${server.port}`,
    PARACORD_DATABASE_ENGINE: 'sqlite',
    PARACORD_DATABASE_URL: `sqlite://${join(server.dataDir, 'paracord.db')}?mode=rwc`,
    PARACORD_JWT_SECRET: server.secret,
    PARACORD_TLS_ENABLED: 'false',
    PARACORD_AT_REST_ENABLED: 'false',
    PARACORD_STORAGE_PATH: join(server.dataDir, 'uploads'),
    PARACORD_MEDIA_STORAGE_PATH: join(server.dataDir, 'files'),
    PARACORD_BACKUP_DIR: join(server.dataDir, 'backups'),
    PARACORD_REGISTRATION_ENABLED: 'true',
    PARACORD_REGISTRATION_MODE: 'open',
    PARACORD_AUTH_REQUIRE_EMAIL: 'true',
    PARACORD_SETUP_REQUIRE_CLAIM: 'false',
    PARACORD_LOG_ANSI: 'false',
    PARACORD_HTTP_RATE_LIMIT_GLOBAL_PER_SECOND: '2000',
    PARACORD_HTTP_RATE_LIMIT_AUTH_PER_MINUTE: '1000',
    // The client is another origin, as the desktop app is.
    PARACORD_CORS_ALLOWED_ORIGINS: APP,
    PARACORD_VOICE_PORT: String(server.port + 1),
    RUST_LOG: 'warn,paracord_api=info',
  };
  const child = spawn(SERVER_BIN, ['-c', join(server.dataDir, 'paracord.toml')], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const match = line.match(/status=(\d+).*method=(\w+) path=(\S+)/);
      if (match) server.requests.push(`${match[2]} ${match[3]} ${match[1]}`);
    }
  });
  child.stderr?.on('data', () => {});
  server.child = child;
  await waitFor(async () => (await fetch(`${server.url}/health`)).ok, `${server.name} to come up`);
}

async function stop(server: Instance): Promise<void> {
  const child = server.child;
  server.child = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  // The voice UDP port is released a moment after the process goes.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text) as T;
}

interface Account {
  username: string;
  token: string;
  refreshToken: string;
  guildId: string;
}

/** An account with one server on `server`, signed in the way a native client is (no Origin: the refresh token comes in the body). */
async function account(server: Instance, guildName: string): Promise<Account> {
  const username = `rec${server.name}${Date.now()}`.slice(0, 30);
  // A one-password account (docs/setup-spec.md §3.3), made the way the client
  // makes one; the server only ever receives the derived auth key.
  const registered = await registerOnePassword(server.url, { username, email: `${username}@example.test`, password: PASSWORD });
  const guild = await json<{ id: string }>(
    await fetch(`${server.url}/api/v1/guilds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registered.token}` },
      body: JSON.stringify({ name: guildName }),
    }),
  );
  const session = (await signInOnePassword(server.url, username, PASSWORD)) as { token: string; refresh_token: string };
  return { username, token: session.token, refreshToken: session.refresh_token, guildId: guild.id };
}

/** The same access token, as the server would have issued it twenty minutes ago: expired, otherwise genuine. */
function expired(token: string, secret: string): string {
  const [, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  claims.iat = now - 1_200;
  claims.exp = now - 300;
  const head = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/** Where a saved server stands, as the app's connection store says. */
function phaseOf(page: Page, serverId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const { useServerConnectionStore } = (await import('/src/stores/serverConnectionStore.ts' as string)) as typeof import('../src/stores/serverConnectionStore');
    return useServerConnectionStore.getState().servers[id]?.phase ?? null;
  }, serverId);
}

function savedServer(page: Page, serverId: string): Promise<{ token: string | null; refreshToken: string | null } | null> {
  return page.evaluate(async (id) => {
    const { useServerListStore } = (await import('/src/stores/serverListStore.ts' as string)) as typeof import('../src/stores/serverListStore');
    const entry = useServerListStore.getState().getServer(id);
    return entry ? { token: entry.token ?? null, refreshToken: entry.refreshToken ?? null } : null;
  }, serverId);
}

const dockItem = (page: Page, guildId: string) => page.locator(`[data-testid="ix-dock-item"][data-place="${guildId}"]`);

let vite: ChildProcess | null = null;
const lantern = instance('lantern', Number(process.env.PARACORD_E2E_RECOVERY_PORT ?? 18171));
const cedar = instance('cedar', lantern.port + 2);
let lanternAccount: Account;
let cedarAccount: Account;

test.beforeAll(async () => {
  if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} (cargo build --release --bin paracord-server)`);
  vite = spawn('node', ['./e2e/index-dev.mjs', String(APP_PORT)], {
    cwd: clientDir,
    env: { ...process.env, VITE_DEV_PROXY_TARGET: cedar.url, VITE_DEV_HMR: 'false' },
    stdio: 'ignore',
  });
  await Promise.all([start(lantern), start(cedar)]);
  await waitFor(async () => (await fetch(APP)).ok, 'the dev server');
  // One after the other: two fresh servers minting in the same millisecond give their
  // servers the same snowflake. The dock keeps two places with one id apart (`placeKeys`),
  // but a real server cannot be made to collide on demand, and this test asserts on a
  // place by its plain id.
  lanternAccount = await account(lantern, 'Lantern place');
  await new Promise((resolve) => setTimeout(resolve, 20));
  cedarAccount = await account(cedar, 'Cedar place');
  expect(cedarAccount.guildId).not.toBe(lanternAccount.guildId);
});

test.afterAll(async () => {
  await Promise.all([stop(lantern), stop(cedar)]);
  vite?.kill('SIGTERM');
  for (const server of [lantern, cedar]) rmSync(server.dataDir, { recursive: true, force: true });
});

test('a saved server is refreshed, reconnects after a restart, and signs in again after a revocation', async ({ page }) => {
  const consoleLines: string[] = [];
  page.on('console', (message) => consoleLines.push(`${message.type()} ${message.text()}`.slice(0, 400)));
  try {
    await recover(page);
  } finally {
    if (process.env.PARACORD_E2E_RECOVERY_DEBUG) {
      console.log(['--- lantern', ...lantern.requests, '--- cedar', ...cedar.requests, '--- console', ...consoleLines].join('\n'));
    }
  }
});

async function recover(page: Page): Promise<void> {
  await page.goto(`${APP}/`);
  await page.waitForFunction(() => document.readyState === 'complete');

  // A relaunch, as the desktop finds it: Lantern's access token expired while the app
  // was closed; its refresh token is good. Cedar's session is current.
  await page.evaluate(
    async ({ lantern, cedar }) => {
      const { useServerListStore } = (await import('/src/stores/serverListStore.ts' as string)) as typeof import('../src/stores/serverListStore');
      useServerListStore.setState({
        hydrated: true,
        tokensHydrated: true,
        activeServerId: null,
        servers: [
          { id: 's_cedar', name: 'Cedar', url: cedar.url, token: cedar.token, refreshToken: cedar.refreshToken, connected: false },
          { id: 's_lantern', name: 'Lantern', url: lantern.url, token: lantern.token, refreshToken: lantern.refreshToken, connected: false },
        ],
      });
      window.history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    {
      lantern: { url: lantern.url, token: expired(lanternAccount.token, lantern.secret), refreshToken: lanternAccount.refreshToken },
      cedar: { url: cedar.url, token: cedarAccount.token, refreshToken: cedarAccount.refreshToken },
    },
  );

  // 1. Expired access token: refreshed silently, and the server connects.
  await expect.poll(() => phaseOf(page, 's_lantern'), { timeout: 30_000 }).toBe('connected');
  await expect(dockItem(page, lanternAccount.guildId)).toBeVisible();
  await expect(dockItem(page, cedarAccount.guildId)).toBeVisible();
  expect(lantern.requests).toContain('POST /api/v1/auth/refresh 200');
  const refreshed = await savedServer(page, 's_lantern');
  expect(refreshed?.refreshToken).not.toBe(lanternAccount.refreshToken);

  // 2. Lantern restarts: the app gets back by itself.
  const sessionsBefore = lantern.requests.filter((line) => line.startsWith('POST /api/v2/rt/session 200')).length;
  await stop(lantern);
  await expect.poll(() => phaseOf(page, 's_lantern'), { timeout: 30_000 }).not.toBe('connected');
  await start(lantern);
  await expect.poll(() => phaseOf(page, 's_lantern'), { timeout: 90_000 }).toBe('connected');
  expect(lantern.requests.filter((line) => line.startsWith('POST /api/v2/rt/session 200')).length).toBeGreaterThan(sessionsBefore);
  await expect(dockItem(page, lanternAccount.guildId)).toBeVisible();

  // 3. The session is revoked on the server (signed out elsewhere). The next time the
  //    app needs it (here, the stream after another restart) the refresh is refused:
  //    Lantern says so and offers to sign in again, and nothing retries on its own.
  const current = await savedServer(page, 's_lantern');
  const logout = await fetch(`${lantern.url}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${current?.token}` } });
  expect(logout.status).toBe(204);
  await stop(lantern);
  await start(lantern);
  await expect.poll(() => phaseOf(page, 's_lantern'), { timeout: 90_000 }).toBe('signed-out');
  const banner = page.getByTestId('ix-banner-signed-out');
  await expect(banner).toContainText('You’re signed out of Lantern.');
  await expect(dockItem(page, lanternAccount.guildId)).toHaveCount(0);
  // Cedar is untouched.
  expect(await phaseOf(page, 's_cedar')).toBe('connected');
  await page.screenshot({ path: test.info().outputPath('signed-out.png') });

  await banner.getByRole('button', { name: 'Sign in again' }).click();
  const dialog = page.getByTestId('ix-signin-dialog');
  await dialog.getByLabel('Email or username').fill(lanternAccount.username);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog).toBeHidden();

  // 4. Connected again, without a restart.
  await expect.poll(() => phaseOf(page, 's_lantern'), { timeout: 30_000 }).toBe('connected');
  await expect(banner).toHaveCount(0);
  await expect(dockItem(page, lanternAccount.guildId)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('signed-in-again.png') });
}
