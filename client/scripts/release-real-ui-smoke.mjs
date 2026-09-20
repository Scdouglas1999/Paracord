import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(CLIENT_ROOT, '..');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright');

function parseArgs() {
  const args = {
    port: 18152,
    server: null,
    webDir: null,
  };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--port') {
      args.port = Number(process.argv[++i]);
    } else if (arg === '--server') {
      args.server = process.argv[++i];
    } else if (arg === '--web-dir') {
      args.webDir = path.resolve(process.argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new Error('--port must be a positive integer');
  }
  return args;
}

function releaseServerPath() {
  if (process.platform === 'win32') {
    return path.join(ROOT, 'target', 'release', 'paracord-server.exe');
  }
  return path.join(ROOT, 'target', 'release', 'paracord-server');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, proc) {
  for (let i = 0; i < 90; i += 1) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early with code ${proc.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Retry below.
    }
    await sleep(500);
  }
  throw new Error('server did not become healthy');
}

async function stopProcess(proc) {
  if (proc.exitCode !== null || proc.pid == null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  proc.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(12000)]);
  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
}

async function requestJson(method, baseUrl, route, { token, body, expected = 200 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status !== expected) {
    const text = await response.text();
    throw new Error(`${method} ${route}: expected ${expected}, got ${response.status}: ${text.slice(0, 500)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function seedServer(baseUrl) {
  const password = 'RealUiSmokePass123!';
  const admin = await requestJson('POST', baseUrl, '/api/v1/auth/register', {
    expected: 201,
    body: {
      email: 'real-ui-smoke@example.com',
      username: 'realuismoke',
      password,
    },
  });
  const token = admin.token;
  if (((admin.user?.flags ?? 0) & 1) === 0) {
    throw new Error(`first registered user was not promoted to admin; flags=${admin.user?.flags ?? 'missing'}`);
  }
  const guild = await requestJson('POST', baseUrl, '/api/v1/guilds', {
    token,
    expected: 201,
    body: {
      name: 'Real UI Smoke Guild',
      icon: null,
    },
  });
  const channel = await requestJson('POST', baseUrl, `/api/v1/guilds/${guild.id}/channels`, {
    token,
    expected: 201,
    body: {
      name: 'real-ui-smoke',
      channel_type: 0,
      parent_id: null,
      required_role_ids: null,
    },
  });
  const disposableUser = await requestJson('POST', baseUrl, '/api/v1/auth/register', {
    expected: 201,
    body: {
      email: 'delete-me-real-ui-smoke@example.com',
      username: 'deletemesmoke',
      password: 'DeleteMeSmoke123!',
    },
  });
  const disposableGuild = await requestJson('POST', baseUrl, '/api/v1/guilds', {
    token,
    expected: 201,
    body: {
      name: 'Disposable Admin Delete Guild',
      icon: null,
    },
  });
  const discoveryOwner = await requestJson('POST', baseUrl, '/api/v1/auth/register', {
    expected: 201,
    body: {
      email: 'discovery-owner-real-ui-smoke@example.com',
      username: 'discoveryowner',
      password: 'DiscoveryOwner123!',
    },
  });
  const discoveryGuild = await requestJson('POST', baseUrl, '/api/v1/guilds', {
    token: discoveryOwner.token,
    expected: 201,
    body: {
      name: 'Discovery Join Guild',
      icon: null,
    },
  });
  const discoveryChannel = await requestJson('POST', baseUrl, `/api/v1/guilds/${discoveryGuild.id}/channels`, {
    token: discoveryOwner.token,
    expected: 201,
    body: {
      name: 'discovery-lobby',
      channel_type: 0,
      parent_id: null,
      required_role_ids: null,
    },
  });
  await requestJson('POST', baseUrl, `/api/v1/channels/${discoveryChannel.id}/invites`, {
    token: discoveryOwner.token,
    expected: 201,
    body: {
      max_uses: 0,
      max_age: 0,
    },
  });
  await requestJson('PATCH', baseUrl, `/api/v1/guilds/${discoveryGuild.id}`, {
    token: discoveryOwner.token,
    body: {
      description: 'Public guild for real browser discovery join coverage',
      visibility: 'public',
      discovery_tags: ['technology'],
    },
  });
  return {
    email: 'real-ui-smoke@example.com',
    password,
    token,
    guildId: guild.id,
    channelId: channel.id,
    discoveryGuildId: discoveryGuild.id,
    disposableUserId: disposableUser.user?.id,
    disposableGuildId: disposableGuild.id,
  };
}

async function seedSecurityEventHistory(baseUrl, token) {
  for (let i = 0; i < 28; i += 1) {
    await requestJson('PATCH', baseUrl, '/api/v1/admin/settings', {
      token,
      body: {
        server_name: `Real UI Smoke ${i}`,
      },
    });
  }
}

async function writeDiagnostics(page, label) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const screenshotPath = path.join(ARTIFACT_DIR, `${safeLabel}.png`);
  const textPath = path.join(ARTIFACT_DIR, `${safeLabel}.txt`);
  await page.getByText('Error details').click({ timeout: 1000 }).catch(() => undefined);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch((error) => String(error));
  await writeFile(textPath, `url=${page.url()}\n\n${bodyText}`, 'utf-8');
  console.error(`Wrote Playwright diagnostics: ${screenshotPath}`);
  console.error(`Wrote Playwright diagnostics: ${textPath}`);
}

async function clickWithRetry(locatorFactory, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await locatorFactory().click({ timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError;
}

async function setSwitch(page, name, checked) {
  const control = page.getByRole('switch', { name });
  await control.waitFor({ timeout: 15000 });
  const current = (await control.getAttribute('aria-checked')) === 'true';
  if (current !== checked) {
    await control.click();
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await control.getAttribute('aria-checked')) === String(checked)) return;
    await sleep(50);
  }
  throw new Error(`switch ${name} did not become ${checked}`);
}

async function expectInputValue(locator, expected) {
  const deadline = Date.now() + 15000;
  let actual = '';
  await locator.waitFor({ timeout: 15000 });
  while (Date.now() < deadline) {
    actual = await locator.inputValue();
    if (actual === expected) return;
    await sleep(100);
  }
  throw new Error(`input value mismatch: expected ${expected}, got ${actual}`);
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  const overflow = Math.max(metrics.documentWidth, metrics.bodyWidth) - metrics.viewportWidth;
  if (overflow > 1) {
    throw new Error(`${label} has document-level horizontal overflow: ${JSON.stringify(metrics)}`);
  }
}

async function navigateSpa(page, route) {
  await page.evaluate((nextRoute) => {
    window.history.pushState({}, '', nextRoute);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
}

async function dismissGuidance(page) {
  const tour = page.getByRole('button', { name: 'Skip tour' });
  await tour.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await tour.isVisible().catch(() => false)) await tour.click();
  const welcome = page.getByRole('button', { name: 'Close welcome screen' });
  if (await welcome.isVisible().catch(() => false)) await welcome.click();
}

async function runSmoke() {
  const args = parseArgs();
  const server = args.server ? path.resolve(args.server) : releaseServerPath();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'paracord-real-ui-smoke-'));
  const uploadDir = path.join(tempDir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const baseUrl = `http://127.0.0.1:${args.port}`;
  const pngPath = path.join(tempDir, 'release-ui-smoke.png');
  await writeFile(
    pngPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  );

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PARACORD_'))),
    PARACORD_BIND_ADDRESS: `127.0.0.1:${args.port}`,
    PARACORD_VOICE_PORT: process.env.PARACORD_VOICE_PORT || String(args.port + 1000),
    PARACORD_SETUP_REQUIRE_CLAIM: 'false',
    PARACORD_DATABASE_ENGINE: 'sqlite',
    PARACORD_DATABASE_URL: `sqlite://${path.join(tempDir, 'paracord.db').replaceAll('\\', '/')}?mode=rwc`,
    PARACORD_JWT_SECRET: 'release-real-ui-smoke-secret-0123456789abcdef',
    PARACORD_TLS_ENABLED: 'false',
    PARACORD_STORAGE_PATH: uploadDir,
    PARACORD_MEDIA_STORAGE_PATH: path.join(tempDir, 'files'),
    PARACORD_BACKUP_DIR: path.join(tempDir, 'backups'),
    PARACORD_REGISTRATION_ENABLED: 'true',
    PARACORD_AUTH_REQUIRE_EMAIL: 'true',
    PARACORD_FEDERATION_ENABLED: 'true',
    PARACORD_FEDERATION_DOMAIN: 'real-ui-smoke.local',
    PARACORD_FEDERATION_SIGNING_KEY_PATH: path.join(tempDir, 'federation_signing_key.hex'),
    PARACORD_FEDERATION_ALLOW_DISCOVERY: 'false',
    // The manually pinned peer fixture points to this disposable local process.
    PARACORD_ALLOW_PRIVATE_FEDERATION_URLS: 'true',
    PARACORD_LOG_ANSI: 'false',
  };

  const serverArgs = ['-c', path.join(tempDir, 'paracord.toml')];
  if (args.webDir) {
    serverArgs.push('--web-dir', args.webDir);
    console.log(`Using separately built frontend assets: ${args.webDir}`);
  }
  const proc = spawn(server, serverArgs, {
    cwd: tempDir,
    env,
    stdio: 'ignore',
  });

  try {
    await waitForHealth(baseUrl, proc);
    const seeded = await seedServer(baseUrl);
    await seedSecurityEventHistory(baseUrl, seeded.token);
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });
      page.on('response', (response) => {
        if (response.status() >= 400) console.error(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') console.error(`Browser console: ${message.text()}`);
      });

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder(/you@example\.com|username/i).fill(seeded.email);
      await page.getByPlaceholder('Enter your password').fill(seeded.password);
      const loginResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/auth/login') &&
          response.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: 'Log In' }).click();
      const loginData = await (await loginResponse).json();
      if (((loginData.user?.flags ?? 0) & 1) === 0) {
        throw new Error(`login response user was not admin; flags=${loginData.user?.flags ?? 'missing'}`);
      }
      await page.waitForURL(/\/app/, { timeout: 15000 });

      try {
        await page.goto(`${baseUrl}/app/templates`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'Template Gallery' }).waitFor({ timeout: 15000 });
        await dismissGuidance(page);
        await page.getByLabel('Source server').selectOption(seeded.guildId);
        await navigateSpa(page, `/app/guilds/${seeded.guildId}/channels/${seeded.channelId}`);
        await page.getByPlaceholder(/Say something in real-ui-smoke/i).waitFor({ timeout: 15000 });
        await dismissGuidance(page);
        const closeWelcome = page.getByRole('button', { name: 'Close welcome screen' });
        if (await closeWelcome.isVisible().catch(() => false)) {
          await closeWelcome.click();
        }

        await page.getByPlaceholder(/Say something in real-ui-smoke/i).fill('real browser release UI smoke message');
        await page.keyboard.press('Enter');
        await page.getByLabel('Message history').getByText('real browser release UI smoke message').waitFor({
          timeout: 15000,
        });

        await page.locator('input[type="file"]').setInputFiles(pngPath);
        await page.getByText('release-ui-smoke.png').waitFor({ timeout: 15000 });
        await page.getByPlaceholder(/Say something in real-ui-smoke/i).fill('real browser image upload');
        const imagePosted = page.waitForResponse((response) => response.url().endsWith(`/channels/${seeded.channelId}/messages`) && response.request().method() === 'POST');
        await page.keyboard.press('Enter');
        const imageResponse = await imagePosted;
        if (imageResponse.status() !== 201) throw new Error(`image message failed: ${imageResponse.status()}`);
        await imageResponse.json();
        await page.getByLabel('Message history').getByText('real browser image upload').waitFor({
          timeout: 15000,
        });
        const previewImage = page.getByRole('img', { name: 'release-ui-smoke.png' }).last();
        await previewImage.waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Open image preview: release-ui-smoke.png' }).click();
        await page.getByRole('dialog', { name: 'Image viewer' }).waitFor({
          timeout: 15000,
        });
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: 'Image viewer' }).waitFor({
          state: 'hidden',
          timeout: 15000,
        });

        await navigateSpa(page, '/app/templates');
        await page.getByRole('heading', { name: 'Template Gallery' }).waitFor({ timeout: 15000 });
        await dismissGuidance(page);
        await assertNoHorizontalOverflow(page, 'template gallery');
        await page.getByLabel('Source server').selectOption(seeded.guildId);
        await page.getByRole('button', { name: 'Create Template' }).click();
        await page.getByRole('button', { name: 'View template Real UI Smoke Guild' }).waitFor({
          timeout: 15000,
        });
        await page.getByRole('button', { name: 'View template Real UI Smoke Guild' }).click();
        await page.locator('#main-content').getByText('real-ui-smoke').waitFor({ timeout: 15000 });
        await page.getByLabel('New server name').fill('Template Created Smoke Guild');
        await page.getByRole('button', { name: 'Create From Template' }).click();
        await page.waitForURL(/\/app\/guilds\/\d+/, { timeout: 15000 });
        await page.getByText('Template Created Smoke Guild').first().waitFor({ timeout: 15000 });
        const templatesAfterApply = await requestJson('GET', baseUrl, '/api/v1/templates', {
          token: seeded.token,
        });
        const appliedTemplate = templatesAfterApply.find((template) => template.name === 'Real UI Smoke Guild');
        if (!appliedTemplate || appliedTemplate.usage_count < 1) {
          throw new Error(`template apply did not increment usage count: ${JSON.stringify(templatesAfterApply)}`);
        }

        await navigateSpa(page, '/app/discovery');
        await page.getByText('Discover Servers').waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'discovery');
        await page.getByLabel('Search public servers').fill('Discovery Join Guild');
        await page.getByRole('button', { name: 'Technology' }).click();
        await page.getByText('Discovery Join Guild').waitFor({ timeout: 15000 });
        await page.getByText('Public guild for real browser discovery join coverage').waitFor({
          timeout: 15000,
        });
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
        await page.getByRole('dialog', { name: 'Discovery Join Guild' }).getByRole('button', { name: 'Join Discovery Join Guild' }).click();
        await page.waitForURL(new RegExp(`/app/guilds/${seeded.discoveryGuildId}/channels/`), {
          timeout: 15000,
        });
        await page.getByText('Joined Discovery Join Guild!').waitFor({ timeout: 15000 });
        await page.getByText('discovery-lobby').first().waitFor({ timeout: 15000 });

        await navigateSpa(page, `/app/guilds/${seeded.guildId}/channels/${seeded.channelId}`);
        await page.getByPlaceholder(/Say something in real-ui-smoke/i).waitFor({ timeout: 15000 });
        await dismissGuidance(page);
        const restartChatting = page.getByRole('button', { name: 'Start Chatting' });
        if (await restartChatting.isVisible().catch(() => false)) {
          await restartChatting.click();
        }

        await page.getByRole('button', { name: 'More channel actions' }).click();
        await page.getByRole('menuitem', { name: 'Server settings' }).click();
        const settingsDialog = page.getByRole('dialog', { name: 'Server settings' });
        await settingsDialog.waitFor({ timeout: 15000 });
        await settingsDialog.getByRole('button', { name: 'Channels', exact: true }).click();
        await settingsDialog.getByRole('heading', { name: 'Channels' }).waitFor({ timeout: 15000 });
        await page.keyboard.press('Escape');
        await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });

        await page.getByRole('button', { name: /Open account menu/ }).click();
        const adminDashboardControl = page.getByRole('menuitem', { name: 'Admin dashboard' });
        await adminDashboardControl.waitFor({ timeout: 15000 });
        await adminDashboardControl.click();
        await page.waitForURL(/\/app\/admin$/, { timeout: 15000 });
        await page.getByRole('heading', { name: 'Instance health' }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin overview');
        await page.getByRole('button', { name: 'Users' }).click();
        await page.getByRole('heading', { name: /Users/ }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin users');
        await page.getByRole('button', { name: 'Delete user deletemesmoke' }).click();
        const deleteUserDialog = page.getByRole('alertdialog', { name: 'Delete user?' });
        await deleteUserDialog.waitFor({ timeout: 15000 });
        await deleteUserDialog.getByRole('button', { name: 'Delete' }).click();
        await page.getByRole('button', { name: 'Delete user deletemesmoke' }).waitFor({
          state: 'detached',
          timeout: 15000,
        });
        await page.getByRole('button', { name: 'Servers', exact: true }).click();
        await page.getByRole('heading', { name: 'Servers', exact: true }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin guilds');
        await page.getByRole('button', { name: 'Delete server Disposable Admin Delete Guild' }).click();
        const deleteGuildDialog = page.getByRole('alertdialog', { name: 'Delete server?' });
        await deleteGuildDialog.waitFor({ timeout: 15000 });
        await deleteGuildDialog.getByRole('button', { name: 'Delete' }).click();
        await page.getByRole('button', { name: 'Delete server Disposable Admin Delete Guild' }).waitFor({
          state: 'detached',
          timeout: 15000,
        });
        await page.getByRole('button', { name: 'Federation' }).click();
        await page.getByRole('heading', { name: 'Federation', exact: true }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin federation');
        await page.locator('#fed-name').fill('smoke-peer.invalid');
        await page.locator('#fed-domain').fill('smoke-peer.invalid');
        await page.locator('#fed-endpoint').fill(`${baseUrl}/_paracord/federation/v1`);
        await page.getByLabel('Public key (hex)').fill('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
        await page.getByLabel('Key ID', { exact: true }).fill('ed25519:smoke');
        await setSwitch(page, 'Discover keys automatically', false);
        await page.getByRole('button', { name: 'Add Server' }).click();
        await page.getByText('Federated instance added.').waitFor({ timeout: 15000 });
        const federationRow = page.locator('section').filter({ hasText: 'Known instances' }).locator('li').filter({ hasText: 'smoke-peer.invalid' });
        await federationRow.waitFor({ timeout: 15000 });
        await federationRow.getByRole('button', { name: 'Inspect' }).click();
        await page.getByRole('heading', { name: 'Details — smoke-peer.invalid' }).waitFor({ timeout: 15000 });
        await federationRow.getByRole('button', { name: 'Remove' }).click();
        const removeFederationDialog = page.getByRole('alertdialog', { name: 'Remove federated instance?' });
        await removeFederationDialog.waitFor({ timeout: 15000 });
        await removeFederationDialog.getByRole('button', { name: 'Remove' }).click();
        await page.getByText('Federated instance removed.').waitFor({ timeout: 15000 });
        await federationRow.waitFor({ state: 'detached', timeout: 15000 });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('heading', { name: 'Instance settings' }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin settings');
        await expectInputValue(page.getByLabel('Instance name'), 'Real UI Smoke 27');
        const expectedSettings = {
          server_name: 'Real UI Smoke Updated',
          server_description: 'Release smoke settings description',
          registration_enabled: 'false',
          max_guilds_per_user: '17',
          max_members_per_guild: '1234',
          max_guild_storage_quota: '2048',
          federation_file_cache_enabled: 'true',
          federation_file_cache_max_size: '321',
          federation_file_cache_ttl_hours: '72',
        };
        await page.getByLabel('Instance name').fill(expectedSettings.server_name);
        await page.getByLabel('Instance description').fill(expectedSettings.server_description);
        await setSwitch(page, 'Open registration', false);
        await page.getByLabel('Max servers per user').fill(expectedSettings.max_guilds_per_user);
        await page.getByLabel('Max members per server').fill(expectedSettings.max_members_per_guild);
        await page.getByLabel('Max server storage quota (MB)').fill(expectedSettings.max_guild_storage_quota);
        await setSwitch(page, 'Cache federated files', true);
        await page.getByLabel('Cache max size (MB)').fill(expectedSettings.federation_file_cache_max_size);
        await page.getByLabel('Cache TTL (hours)').fill(expectedSettings.federation_file_cache_ttl_hours);
        await expectInputValue(page.getByLabel('Instance name'), expectedSettings.server_name);
        await expectInputValue(page.getByLabel('Instance description'), expectedSettings.server_description);
        await expectInputValue(page.getByLabel('Max servers per user'), expectedSettings.max_guilds_per_user);
        await expectInputValue(page.getByLabel('Max members per server'), expectedSettings.max_members_per_guild);
        await expectInputValue(page.getByLabel('Max server storage quota (MB)'), expectedSettings.max_guild_storage_quota);
        await expectInputValue(
          page.getByLabel('Cache max size (MB)'),
          expectedSettings.federation_file_cache_max_size,
        );
        await expectInputValue(
          page.getByLabel('Cache TTL (hours)'),
          expectedSettings.federation_file_cache_ttl_hours,
        );
        await page.getByRole('button', { name: 'Save Changes' }).click();
        await page.getByText('Saved', { exact: true }).waitFor({ timeout: 15000 });
        const savedSettings = await requestJson('GET', baseUrl, '/api/v1/admin/settings', {
          token: seeded.token,
        });
        for (const [key, value] of Object.entries(expectedSettings)) {
          if (String(savedSettings[key]) !== value) {
            throw new Error(`admin setting ${key} mismatch: expected ${value}, got ${savedSettings[key]}`);
          }
        }
        await page.getByRole('button', { name: 'Overview' }).click();
        await page.getByRole('heading', { name: 'Instance health' }).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('heading', { name: 'Instance settings' }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin settings after reload');
        await expectInputValue(page.getByLabel('Instance name'), expectedSettings.server_name);
        await expectInputValue(page.getByLabel('Instance description'), expectedSettings.server_description);
        await page.getByRole('switch', { name: 'Open registration', checked: false }).waitFor({
          timeout: 15000,
        });
        await expectInputValue(page.getByLabel('Max servers per user'), expectedSettings.max_guilds_per_user);
        await expectInputValue(page.getByLabel('Max members per server'), expectedSettings.max_members_per_guild);
        await expectInputValue(page.getByLabel('Max server storage quota (MB)'), expectedSettings.max_guild_storage_quota);
        await page.getByRole('switch', { name: 'Cache federated files', checked: true }).waitFor({
          timeout: 15000,
        });
        await expectInputValue(
          page.getByLabel('Cache max size (MB)'),
          expectedSettings.federation_file_cache_max_size,
        );
        await expectInputValue(
          page.getByLabel('Cache TTL (hours)'),
          expectedSettings.federation_file_cache_ttl_hours,
        );
        await page.getByRole('button', { name: 'Backups' }).click();
        await page.getByRole('heading', { name: 'Backups', exact: true }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin backups');
        await page.getByRole('button', { name: 'Create Backup' }).click();
        await page.getByText(/Backup created:/).waitFor({ timeout: 30000 });
        const backupRow = page.locator('table tbody tr').filter({ hasText: /backup/i }).first();
        await backupRow.waitFor({ timeout: 15000 });
        const backupName = (await backupRow.locator('td').first().innerText()).trim();
        if (!backupName.endsWith('.tar.gz')) {
          throw new Error(`unexpected backup filename: ${backupName}`);
        }

        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
        await page.getByRole('button', { name: `Download backup ${backupName}` }).click();
        const download = await downloadPromise;
        if (download.suggestedFilename() !== backupName) {
          throw new Error(`download filename mismatch: expected ${backupName}, got ${download.suggestedFilename()}`);
        }
        const downloadFailure = await download.failure();
        if (downloadFailure) {
          throw new Error(`backup download failed: ${downloadFailure}`);
        }

        await page.getByRole('button', { name: 'Security' }).click();
        await page.getByRole('heading', { name: 'Security Events' }).waitFor({ timeout: 15000 });
        await assertNoHorizontalOverflow(page, 'admin security');
        await page.getByText(/Page 1 · 25 events/).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Next' }).click();
        await page.getByText(/Page 2 ·/).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Previous' }).click();
        await page.getByText(/Page 1 · 25 events/).waitFor({ timeout: 15000 });
        await page.getByLabel('Filter security events by exact action').fill('admin.backup.create');
        await page.getByRole('button', { name: 'Apply' }).click();
        const backupCreateRow = page.locator('table tbody tr').filter({ hasText: 'admin.backup.create' }).first();
        await backupCreateRow.waitFor({ timeout: 15000 });
        await backupCreateRow.getByRole('button', { name: 'View' }).click();
        await page.locator('pre').filter({ hasText: backupName }).first().waitFor({ timeout: 15000 });

        await page.getByRole('button', { name: 'Backups' }).click();
        await page.getByRole('heading', { name: 'Backups', exact: true }).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: `Recovery instructions for ${backupName}` }).click();
        const recovery = page.getByRole('region', { name: 'Recovery instructions' });
        await recovery.waitFor({ timeout: 15000 });
        await recovery.locator('pre').filter({ hasText: 'restore-backup' }).waitFor({ timeout: 15000 });
        if (!(await recovery.innerText()).includes(backupName)) throw new Error('recovery instructions reference the wrong archive');
        // Recovery preparation must keep the running server and its data intact.
        const survivingMessages = await requestJson('GET', baseUrl, `/api/v1/channels/${seeded.channelId}/messages`, { token: seeded.token });
        if (!survivingMessages.some((message) => message.content === 'real browser release UI smoke message')) {
          throw new Error('recovery preparation altered live message history');
        }

        await page.getByRole('button', { name: `Delete backup ${backupName}` }).click();
        const deleteDialog = page.getByRole('alertdialog', { name: 'Delete backup?' });
        await deleteDialog.waitFor({ timeout: 15000 });
        await deleteDialog.getByRole('button', { name: 'Delete' }).click();
        await page.getByText(`Backup deleted: ${backupName}`).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: `Delete backup ${backupName}` }).waitFor({
          state: 'detached',
          timeout: 15000,
        });

        await page.getByRole('button', { name: 'Security' }).click();
        await page.getByRole('heading', { name: 'Security Events' }).waitFor({ timeout: 15000 });
        await page.getByLabel('Filter security events by exact action').fill('admin.backup.recovery_instructions');
        await page.getByRole('button', { name: 'Apply' }).click();
        await page.getByText('admin.backup.recovery_instructions').waitFor({ timeout: 15000 });
        await page.getByLabel('Filter security events by exact action').fill('admin.backup.delete');
        await page.getByRole('button', { name: 'Apply' }).click();
        await page.getByText('admin.backup.delete').waitFor({ timeout: 15000 });

        if (pageErrors.length > 0) {
          throw new Error(`page errors observed: ${pageErrors.join('; ')}`);
        }
      } catch (error) {
        await writeDiagnostics(page, 'release-real-ui-smoke-failure');
        throw error;
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopProcess(proc);
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log('PASS: release real-browser UI smoke passed');
}

runSmoke().catch((error) => {
  console.error(error);
  process.exit(1);
});
