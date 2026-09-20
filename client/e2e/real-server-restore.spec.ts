import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-server restore regression: like real-server.smoke.spec.ts this uses the
// actual release `paracord-server` binary with no mocked /api routes, but it
// launches its OWN isolated instance on an OS-assigned port (the shared
// real-server-harness on :18150 stays untouched). The test performs a real
// /admin/backup, mutates the database afterwards, stops the source with
// SIGTERM, runs the real `restore-backup` CLI into a fresh recovery directory,
// boots the generated activation config on the SAME port, and asserts that two
// already-signed-in browser clients reconcile to the restored history over a
// live reconnected EventSource — without any page reload. Epoch acceptance is
// observed only through the public paracord:database-history:* localStorage
// keys and READY frames on the real EventSource; no app internals are touched.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const binName = process.platform === 'win32' ? 'paracord-server.exe' : 'paracord-server';
const serverBin = resolve(
  process.env.PARACORD_E2E_SERVER_BIN ?? join(repoRoot, 'target', 'release', binName),
);
const HISTORY_KEY_PREFIX = 'paracord:database-history:';
const HISTORY_HEADER = 'X-Paracord-History-Epoch';

const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

// The child must inherit no PARACORD_* deployment overrides: the real TOML
// fixture below is meant to be authoritative, mirroring ci_restore_smoke.py.
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

// The native QUIC/WebTransport media engine binds UDP unconditionally when
// [voice] native_media is on (default 8443, already held by the harness
// instance). Allocate a distinct free UDP port for this isolated server.
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

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

interface ServerHandle {
  child: ChildProcess;
  exited: Promise<ExitResult>;
  exitResult: ExitResult | null;
  output: () => string;
}

function launchServer(configPath: string, env: NodeJS.ProcessEnv): ServerHandle {
  const child = spawn(serverBin, ['-c', configPath], { cwd: repoRoot, env });
  let output = '';
  const handle: ServerHandle = {
    child,
    exitResult: null,
    output: () => output,
    exited: new Promise<ExitResult>((resolvePromise) => {
      child.on('exit', (code, signal) => {
        handle.exitResult = { code, signal };
        resolvePromise(handle.exitResult);
      });
      child.on('error', (error) => {
        output += `\n[harness] spawn error: ${error.message}\n`;
        handle.exitResult = { code: null, signal: null };
        resolvePromise(handle.exitResult);
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

async function waitForHealth(handle: ServerHandle, base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (handle.exitResult) {
      throw new Error(
        `server exited before becoming healthy: ${JSON.stringify(handle.exitResult)}\n${handle.output()}`,
      );
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
  throw new Error(`server did not become healthy within ${timeoutMs}ms (${lastError})\n${handle.output()}`);
}

async function stopServer(handle: ServerHandle, timeoutMs = 20_000): Promise<void> {
  if (handle.exitResult) return;
  handle.child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    handle.exited,
    new Promise<null>((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  if (result === null) {
    // Only the child this test spawned is ever killed.
    handle.child.kill('SIGKILL');
    await handle.exited;
    throw new Error(`paracord-server ignored SIGTERM for ${timeoutMs}ms and was SIGKILLed`);
  }
}

async function runRestore(
  configPath: string,
  archivePath: string,
  outputDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      serverBin,
      ['--config', configPath, 'restore-backup', '--archive', archivePath, '--output-dir', outputDir],
      { cwd: repoRoot, env, timeout: 15_000, killSignal: 'SIGTERM' },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

// Observe real EventSource gateway traffic. READY frames carry
// d.user.id and d.database_history_epoch; nothing else is inspected.
const WIRE_INIT = `(() => {
  const wire = { readies: [] };
  Object.defineProperty(window, '__paracordWire', { value: wire });
  const NativeEventSource = window.EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(url, init) {
      super(url, init);
      const observe = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame && frame.t === 'READY' && frame.d) {
            wire.readies.push({
              user: String((frame.d.user && frame.d.user.id) || ''),
              epoch: String(frame.d.database_history_epoch || ''),
              session: frame.d.session_id || null,
            });
          }
        } catch { /* liveness frames carry no lifecycle payload */ }
      };
      this.addEventListener('gateway', observe);
      this.addEventListener('message', observe);
    }
  };
})();`;

type WireReady = { user: string; epoch: string; session: string | null };
const wireOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __paracordWire: { readies: WireReady[] } }).__paracordWire,
  );

async function waitForReadyWithEpoch(page: Page, userId: string, epoch: string, timeoutMs = 20_000) {
  await page.waitForFunction(
    ([id, want]) =>
      (window as unknown as { __paracordWire: { readies: WireReady[] } }).__paracordWire.readies.some(
        (ready) => ready.user === id && ready.epoch === want,
      ),
    [userId, epoch],
    { timeout: timeoutMs },
  );
}

async function waitForReadyExcludingEpoch(page: Page, userId: string, epoch: string, timeoutMs = 30_000) {
  await page.waitForFunction(
    ([id, stale]) =>
      (window as unknown as { __paracordWire: { readies: WireReady[] } }).__paracordWire.readies.some(
        (ready) => ready.user === id && ready.epoch !== '' && ready.epoch !== stale,
      ),
    [userId, epoch],
    { timeout: timeoutMs },
  );
}

// Public contract only: the epoch the client persisted for its account scope.
async function acceptedHistoryEpoch(page: Page): Promise<string | null> {
  return await page.evaluate((prefix) => {
    const values = Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .map((key) => localStorage.getItem(key));
    return values.length === 1 ? values[0] : null;
  }, HISTORY_KEY_PREFIX);
}

async function waitForAcceptedEpoch(page: Page, epoch: string, timeoutMs = 15_000) {
  await page.waitForFunction(
    ([prefix, want]) =>
      Object.keys(localStorage).some(
        (key) => key.startsWith(prefix) && localStorage.getItem(key) === want,
      ),
    [HISTORY_KEY_PREFIX, epoch],
    { timeout: timeoutMs },
  );
}

async function login(page: Page, base: string, email: string, password: string) {
  await page.goto(`${base}/login`);
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
}

async function dismissOnboarding(page: Page) {
  for (const name of ['Skip tour', 'Close welcome screen']) {
    try {
      const button = page.getByRole('button', { name, exact: true });
      await button.waitFor({ state: 'visible', timeout: 1500 });
      await button.click();
    } catch {
      // Overlay never appeared.
    }
  }
}

const UUID_EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('restored backup replaces live history for connected browsers without a reload', async ({ browser, playwright }, testInfo) => {
  expect(existsSync(serverBin), `release binary missing: ${serverBin}`).toBe(true);

  const unique = Date.now();
  const password = 'Restore-Cutover-123!';
  const env = serverEnvironment();
  const dataDir = await mkdtemp(join(tmpdir(), 'paracord-e2e-restore-'));
  const recoveryDir = join(dataDir, 'recovery');
  const configPath = join(dataDir, 'paracord.toml');
  const dbPath = join(dataDir, 'paracord.db');
  const uploadsDir = join(dataDir, 'uploads');
  const filesDir = join(dataDir, 'files');
  const backupsDir = join(dataDir, 'backups');

  const httpPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const BASE = `http://127.0.0.1:${httpPort}`;

  let source: ServerHandle | null = null;
  let recovered: ServerHandle | null = null;
  let ownerContext: BrowserContext | null = null;
  let memberContext: BrowserContext | null = null;
  const apiContexts: APIRequestContext[] = [];
  const pageErrors: string[] = [];

  const toml = (value: string) => JSON.stringify(value);
  try {
    await mkdir(uploadsDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(backupsDir, { recursive: true });
    await writeFile(
      configPath,
      [
        '[server]',
        `bind_address = ${toml(`127.0.0.1:${httpPort}`)}`,
        'server_name = "restore-e2e"',
        '',
        '[database]',
        'engine = "sqlite"',
        `url = ${toml(`sqlite://${dbPath}?mode=rwc`)}`,
        '',
        '[auth]',
        `jwt_secret = ${toml(randomBytes(32).toString('hex'))}`,
        'registration_enabled = true',
        'require_email = true',
        '',
        '[setup]',
        // This spec registers its own first account over REST, so the instance
        // is bootstrapped without a first-owner claim: the first registration
        // owns it. The claim flow itself is covered by real-server-setup.spec.ts.
        'require_claim = false',
        '',
        '[storage]',
        'storage_type = "local"',
        `path = ${toml(uploadsDir)}`,
        '',
        '[media]',
        `storage_path = ${toml(filesDir)}`,
        '',
        '[voice]',
        'native_media = true',
        `port = ${udpPort}`,
        '',
        '[tls]',
        'enabled = false',
        '',
        '[backup]',
        `backup_dir = ${toml(backupsDir)}`,
        'auto_backup_enabled = false',
        '',
      ].join('\n'),
    );

    source = launchServer(configPath, env);
    await waitForHealth(source, BASE);

    // ── Fixture accounts: first registered user becomes the server admin. ──
    const register = async (label: string) => {
      const context = await playwright.request.newContext();
      const email = `${label}-${unique}@example.test`;
      try {
        const response = await context.post(`${BASE}/api/v1/auth/register`, {
          data: { email, username: `${label}${unique}`, password },
        });
        expect(response.status(), await response.text()).toBe(201);
        return { ...(await response.json()), email };
      } finally {
        await context.dispose();
      }
    };
    const owner = await register('rowner');
    const member = await register('rmember');
    const ownerApi = await playwright.request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${owner.token}` },
    });
    const memberApi = await playwright.request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${member.token}` },
    });
    apiContexts.push(ownerApi, memberApi);

    const guildResponse = await ownerApi.post(`${BASE}/api/v1/guilds`, {
      data: { name: 'Restore verification' },
    });
    expect(guildResponse.status(), await guildResponse.text()).toBe(201);
    const guild = await guildResponse.json();
    const channelResponse = await ownerApi.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, {
      data: { name: 'anchor', channel_type: 0 },
    });
    expect(channelResponse.status(), await channelResponse.text()).toBe(201);
    const channel = await channelResponse.json();
    const inviteResponse = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/invites`, {
      data: {},
    });
    expect(inviteResponse.status(), await inviteResponse.text()).toBe(201);
    const invite = await inviteResponse.json();
    const joined = await memberApi.post(`${BASE}/api/v1/invites/${invite.code}`, { data: {} });
    expect(joined.ok(), await joined.text()).toBe(true);

    // Two baseline messages (mention + chatter) leave the channel at
    // message_revision 2. The member never opens the channel, so the mention
    // is unread and pinned on Home.
    const mentionPhrase = `restore-anchor-citadel-${unique}`;
    const ledgerPhrase = `baseline-ledger-${unique}`;
    const baselineMention = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, {
      data: { content: `<@${member.user.id}> ${mentionPhrase}`, nonce: `restore-mention-${unique}` },
    });
    expect(baselineMention.status(), await baselineMention.text()).toBe(201);
    const mentionMessage = await baselineMention.json();
    const baselineLedger = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, {
      data: { content: ledgerPhrase, nonce: `restore-ledger-${unique}` },
    });
    expect(baselineLedger.status(), await baselineLedger.text()).toBe(201);
    const ledgerMessage = await baselineLedger.json();
    const channelAtBaseline = await (
      await ownerApi.get(`${BASE}/api/v1/channels/${channel.id}`)
    ).json();
    expect(channelAtBaseline.message_revision).toBe('2');

    // ── Real browser sessions, logged in through the UI BEFORE the backup so
    //    their auth sessions live inside the archived database. ──
    const newWiredPage = async (label: string) => {
      const context = await browser.newContext();
      await context.addInitScript(WIRE_INIT);
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));
      return { context, page };
    };
    const ownerSession = await newWiredPage('owner');
    ownerContext = ownerSession.context;
    const ownerPage = ownerSession.page;
    const memberSession = await newWiredPage('member');
    memberContext = memberSession.context;
    const memberPage = memberSession.page;

    await login(ownerPage, BASE, owner.email, password);
    await waitForReadyExcludingEpoch(ownerPage, String(owner.user.id), '');
    // The wire observer is registered before the app's own listeners, so poll
    // briefly for the app to persist the epoch it accepted from that READY.
    await expect.poll(() => acceptedHistoryEpoch(ownerPage)).toMatch(UUID_EPOCH);
    const ownerEpoch = await acceptedHistoryEpoch(ownerPage);
    await waitForReadyWithEpoch(ownerPage, String(owner.user.id), ownerEpoch!);

    await login(memberPage, BASE, member.email, password);
    await expect.poll(() => acceptedHistoryEpoch(memberPage)).toMatch(UUID_EPOCH);
    const memberEpoch = await acceptedHistoryEpoch(memberPage);
    await waitForReadyWithEpoch(memberPage, String(member.user.id), memberEpoch!);

    const sourceEpoch = ownerEpoch!;
    expect(memberEpoch).toBe(sourceEpoch);

    // Owner watches the channel; member stays on Home to observe unread
    // previews. The unread baseline mention must already be visible.
    await ownerPage.goto(`${BASE}/app/guilds/${guild.id}/channels/${channel.id}`);
    await dismissOnboarding(ownerPage);
    await expect(ownerPage.getByText(ledgerPhrase).first()).toBeVisible();
    const memberHome = memberPage.getByRole('main');
    const memberAttention = memberHome.getByRole('region', { name: 'For you' });
    await expect(memberAttention).toBeVisible();
    await expect(memberAttention.getByText(/mentioned you|1 mention for you/)).toBeVisible();
    await expect(memberAttention.getByText(new RegExp(`@you ${mentionPhrase}`))).toBeVisible();
    await dismissOnboarding(memberPage);

    // ── Real backup through the admin API; archive lands in the configured
    //    backup directory. ──
    const backupResponse = await ownerApi.post(`${BASE}/api/v1/admin/backup`, {
      data: { include_media: true },
    });
    expect(backupResponse.status(), await backupResponse.text()).toBe(200);
    const backup = await backupResponse.json();
    expect(typeof backup.filename).toBe('string');
    const archivePath = join(backupsDir, backup.filename);
    expect(existsSync(archivePath), `backup not written to configured dir: ${archivePath}`).toBe(true);

    // ── Post-backup divergence: seven sends (last one a distinguishing
    //    mention) take the channel to revision 9, plus a new channel. ──
    for (let i = 1; i <= 6; i++) {
      const sent = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, {
        data: { content: `post-backup-drift-${i}-${unique}`, nonce: `drift-${i}-${unique}` },
      });
      expect(sent.status(), await sent.text()).toBe(201);
    }
    const signalPhrase = `post-backup-signal-${unique}`;
    const signal = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, {
      data: { content: `<@${member.user.id}> ${signalPhrase}`, nonce: `signal-${unique}` },
    });
    expect(signal.status(), await signal.text()).toBe(201);
    const postChannelResponse = await ownerApi.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, {
      data: { name: 'after-backup', channel_type: 0 },
    });
    expect(postChannelResponse.status(), await postChannelResponse.text()).toBe(201);
    const postChannel = await postChannelResponse.json();
    const channelAtNine = await (await ownerApi.get(`${BASE}/api/v1/channels/${channel.id}`)).json();
    expect(channelAtNine.message_revision).toBe('9');

    // Newer activity is actually live in both clients before the cutover.
    await expect(ownerPage.getByText(new RegExp(signalPhrase))).toBeVisible();
    await expect(ownerPage.getByText('after-backup').first()).toBeVisible();
    await expect(memberAttention.getByText(/mentioned you|2 mentions for you/)).toBeVisible();
    await ownerPage.screenshot({ path: testInfo.outputPath('restore-before-owner.png'), fullPage: true });
    await memberPage.screenshot({ path: testInfo.outputPath('restore-before-member.png'), fullPage: true });

    // ── Graceful source shutdown, awaiting the actual process exit before
    //    any recovery work begins. ──
    await stopServer(source);

    // ── Real offline recovery into a fresh directory with the ORIGINAL
    //    config; the generated activation config keeps the same bind port. ──
    const restore = await runRestore(configPath, archivePath, recoveryDir, env);
    expect(
      restore.code,
      `restore-backup failed\nstdout: ${restore.stdout}\nstderr: ${restore.stderr}`,
    ).toBe(0);
    const verification = JSON.parse(
      await readFile(join(recoveryDir, 'verification.json'), 'utf8'),
    ) as { database_history_epoch: string };
    expect(verification.database_history_epoch).toMatch(UUID_EPOCH);
    expect(verification.database_history_epoch).not.toBe(sourceEpoch);

    recovered = launchServer(join(recoveryDir, 'paracord.toml'), env);
    await waitForHealth(recovered, BASE);

    // ── Cutover observed live: both mounted clients reconnect, receive a new
    //    READY carrying the rotated epoch, and persist acceptance — no
    //    reload or navigation anywhere below. ──
    await waitForReadyExcludingEpoch(ownerPage, String(owner.user.id), sourceEpoch);
    await waitForReadyExcludingEpoch(memberPage, String(member.user.id), sourceEpoch);
    const readies = (await wireOf(ownerPage)).readies.filter(
      (ready) => ready.epoch === verification.database_history_epoch,
    );
    expect(readies.length).toBeGreaterThan(0);
    await waitForAcceptedEpoch(ownerPage, verification.database_history_epoch);
    await waitForAcceptedEpoch(memberPage, verification.database_history_epoch);

    // Restored history wins at the API: revision is back to the backup-time 2
    // and post-backup rows are gone.
    const restoredChannel = await (await ownerApi.get(`${BASE}/api/v1/channels/${channel.id}`)).json();
    expect(restoredChannel.message_revision).toBe('2');
    const restoredMessages = await (await ownerApi.get(`${BASE}/api/v1/channels/${channel.id}/messages`)).json();
    expect(restoredMessages.map((message: { content: string }) => message.content).sort()).toEqual([
      `<@${member.user.id}> ${mentionPhrase}`,
      ledgerPhrase,
    ]);
    const restoredChannels = await (await ownerApi.get(`${BASE}/api/v1/guilds/${guild.id}/channels`)).json();
    expect(
      (restoredChannels as Array<{ id: string; name: string }>).some(
        (entry) => entry.id === String(postChannel.id) || entry.name === 'after-backup',
      ),
    ).toBe(false);

    // The mounted UIs follow the restored history: baseline content returns,
    // post-backup content and the post-backup channel disappear.
    await expect(ownerPage.getByText(ledgerPhrase).first()).toBeVisible();
    await expect(ownerPage.getByText(new RegExp(signalPhrase))).toHaveCount(0);
    await expect(ownerPage.getByText(new RegExp(`post-backup-drift-\\d-${unique}`))).toHaveCount(0);
    await expect(ownerPage.getByText('after-backup')).toHaveCount(0);
    await expect(memberAttention.getByText(/mentioned you|1 mention for you/)).toBeVisible();
    await expect(memberAttention.getByText(new RegExp(`@you ${mentionPhrase}`))).toBeVisible();
    // The post-backup mention is gone with its message, so the room is one row
    // again. §7.5 names the author rather than the count, so the count itself is
    // no longer on the surface to assert — the row's preview above is.
    await expect(memberAttention.getByRole('listitem')).toHaveCount(1);
    await expect(memberPage.getByText(new RegExp(signalPhrase))).toHaveCount(0);

    // Both clients are still signed in: URLs never left /app, READY carried
    // their own user ids, and the archived sessions still authenticate.
    await expect(ownerPage).toHaveURL(/\/app/);
    await expect(memberPage).toHaveURL(/\/app/);
    expect((await ownerApi.get(`${BASE}/api/v1/users/@me`)).status()).toBe(200);
    expect((await memberApi.get(`${BASE}/api/v1/users/@me`)).status()).toBe(200);
    await ownerPage.screenshot({ path: testInfo.outputPath('restore-after-owner.png'), fullPage: true });
    await memberPage.screenshot({ path: testInfo.outputPath('restore-after-member.png'), fullPage: true });

    // ── Stale-epoch mutation is refused without touching the restored DB. ──
    const staleAttempt = await ownerApi.post(`${BASE}/api/v1/channels/${channel.id}/messages`, {
      headers: { [HISTORY_HEADER]: sourceEpoch },
      data: { content: `stale-epoch-mutation-attempt-${unique}`, nonce: `stale-${unique}` },
    });
    expect(staleAttempt.status()).toBe(409);
    expect((await staleAttempt.json()).code).toBe('HISTORY_CHANGED');
    expect(staleAttempt.headers()[HISTORY_HEADER.toLowerCase()]).toBe(
      verification.database_history_epoch,
    );
    const afterStale = await (await ownerApi.get(`${BASE}/api/v1/channels/${channel.id}`)).json();
    expect(afterStale.message_revision).toBe('2');

    // ── Lower-revision proof: deleting both baseline messages moves the
    //    restored channel to revisions 3/4 — still below the abandoned 9 —
    //    and member Home goes quiet live, so a stale revision-9 view cannot
    //    remain pinned. ──
    const deleteMention = await ownerApi.delete(
      `${BASE}/api/v1/channels/${channel.id}/messages/${mentionMessage.id}`,
    );
    expect(deleteMention.ok(), await deleteMention.text()).toBe(true);
    const deleteLedger = await ownerApi.delete(
      `${BASE}/api/v1/channels/${channel.id}/messages/${ledgerMessage.id}`,
    );
    expect(deleteLedger.ok(), await deleteLedger.text()).toBe(true);
    const afterDeletes = await (await ownerApi.get(`${BASE}/api/v1/channels/${channel.id}`)).json();
    expect(afterDeletes.message_revision).toBe('4');
    // §7.5 keeps the Needs-you section on the surface and lets it say so:
    // "Nothing new for you right now." It is no longer removed when
    // empty, because an absent section cannot tell you it checked.
    await expect(memberHome.getByRole('region', { name: 'For you' }).getByRole('listitem')).toHaveCount(0);
    await expect(memberHome.getByText('Nothing new for you right now.')).toBeVisible();
    await expect(ownerPage.getByText(ledgerPhrase)).toHaveCount(0);
    await memberPage.screenshot({ path: testInfo.outputPath('restore-quiet-member.png'), fullPage: true });

    expect(pageErrors).toEqual([]);
  } finally {
    for (const [label, handle] of [['source', source], ['recovered', recovered]] as const) {
      if (handle) await testInfo.attach(`${label}-server.log`, { body: handle.output(), contentType: 'text/plain' });
    }
    if (ownerContext) await ownerContext.close().catch(() => undefined);
    if (memberContext) await memberContext.close().catch(() => undefined);
    for (const context of apiContexts.splice(0)) await context.dispose();
    if (recovered) await stopServer(recovered).catch(() => recovered?.child.kill('SIGKILL'));
    if (source) await stopServer(source).catch(() => source?.child.kill('SIGKILL'));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }).catch(
      () => undefined,
    );
  }
});
