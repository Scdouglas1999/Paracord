import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PARACORD_SCREENSHOT_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(CLIENT_ROOT, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPreview(proc) {
  for (let i = 0; i < 60; i += 1) {
    if (proc.exitCode !== null) {
      throw new Error(`vite preview exited early with code ${proc.exitCode}`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Retry below.
    }
    await sleep(500);
  }
  throw new Error('vite preview did not become reachable');
}

async function stopPreview(proc) {
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
  proc.kill();
}

async function installRoutes(page) {
  const guildId = '1001';
  const textChannelId = '2001';
  const voiceChannelId = '2002';
  const nowIso = new Date('2026-05-16T12:00:00.000Z').toISOString();
  const userPayload = {
    id: '42',
    username: 'release-preview',
    discriminator: '0001',
    avatar_hash: null,
    bot: false,
    system: false,
    flags: 0,
    created_at: nowIso,
  };
  const messages = [
    {
      id: '3001',
      channel_id: textChannelId,
      author: {
        id: '43',
        username: 'alex',
        discriminator: '0001',
        avatar_hash: null,
      },
      content: 'Release candidate smoke is green for the core chat path.',
      pinned: false,
      type: 0,
      message_type: 0,
      timestamp: nowIso,
      created_at: nowIso,
      edited_timestamp: null,
      edited_at: null,
      reference_id: null,
      attachments: [],
      reactions: [{ emoji: 'check', count: 3, me: false }],
    },
    {
      id: '3002',
      channel_id: textChannelId,
      author: {
        id: userPayload.id,
        username: userPayload.username,
        discriminator: userPayload.discriminator,
        avatar_hash: null,
      },
      content: 'Bundled client, routing, and release smoke coverage are current.',
      pinned: false,
      type: 0,
      message_type: 0,
      timestamp: nowIso,
      created_at: nowIso,
      edited_timestamp: null,
      edited_at: null,
      reference_id: null,
      attachments: [],
      reactions: [],
    },
  ];

  await page.route('**/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    });
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const requestPath = url.pathname;
    const json = (status, payload) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });

    if (requestPath === '/api/v1/auth/refresh' && method === 'POST') {
      return json(200, { token: 'screenshot-token', refresh_token: 'screenshot-refresh', user: userPayload });
    }
    if (requestPath === '/api/v1/users/@me' && method === 'GET') {
      return json(200, userPayload);
    }
    if (requestPath === '/api/v1/users/@me/settings' && method === 'GET') {
      return json(200, {
        user_id: userPayload.id,
        theme: 'dark',
        locale: 'en-US',
        message_display_compact: false,
        custom_css: null,
        status: 'online',
        custom_status: null,
        crypto_auth_enabled: false,
        notifications: {},
        keybinds: {},
      });
    }
    if (requestPath === '/api/v1/users/@me/guilds' && method === 'GET') {
      return json(200, [
        {
          id: guildId,
          name: 'Paracord Preview',
          server_url: 'https://preview.paracord.local',
          icon_hash: null,
          owner_id: userPayload.id,
          member_count: 4,
          features: [],
          created_at: nowIso,
        },
      ]);
    }
    if (requestPath === `/api/v1/guilds/${guildId}` && method === 'GET') {
      return json(200, {
        id: guildId,
        name: 'Paracord Preview',
        server_url: 'https://preview.paracord.local',
        icon_hash: null,
        owner_id: userPayload.id,
        member_count: 4,
        features: [],
        hub_settings: null,
        created_at: nowIso,
      });
    }
    if (requestPath === `/api/v1/guilds/${guildId}/channels` && method === 'GET') {
      return json(200, [
        {
          id: textChannelId,
          guild_id: guildId,
          name: 'release-chat',
          type: 0,
          channel_type: 0,
          position: 0,
          nsfw: false,
          parent_id: null,
          required_role_ids: [],
          created_at: nowIso,
        },
        {
          id: voiceChannelId,
          guild_id: guildId,
          name: 'Voice Review',
          type: 2,
          channel_type: 2,
          position: 1,
          nsfw: false,
          parent_id: null,
          required_role_ids: [],
          created_at: nowIso,
        },
      ]);
    }
    if (requestPath === `/api/v1/guilds/${guildId}/members` && method === 'GET') {
      return json(200, []);
    }
    if (requestPath === `/api/v1/guilds/${guildId}/onboarding/me` && method === 'GET') {
      return json(200, {
        settings: null,
        member_state: {
          accepted_rules: true,
          selected_role_ids: [],
          completed_at: nowIso,
        },
      });
    }
    if (requestPath === `/api/v1/channels/${textChannelId}/messages` && method === 'GET') {
      return json(200, messages);
    }
    if (requestPath === `/api/v1/channels/${textChannelId}/read` && method === 'PUT') {
      return json(200, { channel_id: textChannelId, last_message_id: '3002', mention_count: 0 });
    }
    if (requestPath === `/api/v1/guilds/${guildId}/economy/leaderboard` && method === 'GET') {
      return json(200, { guild_id: guildId, entries: [], limit: 8 });
    }
    if (requestPath === `/api/v1/guilds/${guildId}/economy/me` && method === 'GET') {
      return json(200, {
        guild_id: guildId,
        user_id: userPayload.id,
        xp: 0,
        level: 0,
        rank: null,
        last_xp_at: nowIso,
        progress: {
          current_level_floor: 0,
          next_level_at: 100,
          xp_into_level: 0,
          xp_required_this_level: 100,
        },
        streak: {
          days: 0,
          longest_days: 0,
          last_active_date: nowIso.slice(0, 10),
        },
        achievements: [],
      });
    }
    if (requestPath === `/api/v1/guilds/${guildId}/economy/level-roles` && method === 'GET') {
      return json(200, { guild_id: guildId, mappings: [] });
    }

    if (method === 'GET') return json(200, []);
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/api/v2/rt/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ws_url: 'ws://127.0.0.1:0/gateway',
        session_id: 'screenshot-session',
        token: 'screenshot-rt-token',
      }),
    });
  });
  await page.route('**/api/v2/rt/events**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
      body: 'event: gateway\ndata: {"op":0,"t":"READY","d":{}}\n\n',
    });
  });
  await page.route('**/api/v2/rt/commands', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
}

async function capture() {
  await mkdir(OUT_DIR, { recursive: true });
  const previewCommand =
    process.platform === 'win32'
      ? {
          command: 'cmd.exe',
          args: [
            '/d',
            '/s',
            '/c',
            `npm run preview -- --host 127.0.0.1 --port ${PORT}`,
          ],
        }
      : {
          command: 'npm',
          args: ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT)],
        };
  const preview = spawn(
    previewCommand.command,
    previewCommand.args,
    {
      cwd: CLIENT_ROOT,
      env: { ...process.env, BROWSER: 'none' },
      stdio: 'ignore',
    },
  );

  try {
    await waitForPreview(preview);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await installRoutes(page);
      await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
      await page.getByText(/Welcome to Paracord/i).waitFor({ timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, 'dashboard-current.png'), fullPage: true });

      await page.goto(`${BASE_URL}/app/guilds/1001/channels/2001`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder(/Message #release-chat/).waitFor({ timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, 'text-chat-current.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  } finally {
    await stopPreview(preview);
  }
}

capture().catch((error) => {
  console.error(error);
  process.exit(1);
});
