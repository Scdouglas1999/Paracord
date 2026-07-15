#!/usr/bin/env node
/**
 * Capture README / promo screenshots from a running Paracord stack.
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
 *   PARACORD_CAPTURE_BASE=https://127.0.0.1:8443 \
 *   node scripts/capture-readme-screenshots.mjs
 *
 * Env:
 *   PARACORD_CAPTURE_BASE          Default https://127.0.0.1:8443
 *   PARACORD_SCREENSHOT_EMAIL      Demo account email
 *   PARACORD_SCREENSHOT_PASSWORD   Demo account password
 *   CHROME_PATH                    Optional Chromium binary
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'client', 'package.json'));
const { chromium } = require('playwright');

const OUT = path.join(ROOT, 'docs', 'images', 'readme');
const BASE = (process.env.PARACORD_CAPTURE_BASE || 'https://127.0.0.1:8443').replace(/\/$/, '');
const VIEWPORT = { width: 1440, height: 900 };

const email = process.env.PARACORD_SCREENSHOT_EMAIL || 'readme-1783269377@example.test';
const password = process.env.PARACORD_SCREENSHOT_PASSWORD || 'Readme-Capture-123!';
const guildName = 'Emerald Commons';

const captured = [];
const skipped = [];

async function dismissOverlays(page) {
  for (let i = 0; i < 8; i++) {
    const skipTour = page.getByRole('button', { name: /^skip tour$/i }).first();
    if (await skipTour.isVisible().catch(() => false)) {
      await skipTour.click().catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }
    const close = page.getByRole('button', { name: /close|dismiss|got it|skip|not now|maybe later/i }).first();
    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => {});
      await page.waitForTimeout(200);
      continue;
    }
    break;
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
}

async function shot(page, filename, description, opts = {}) {
  await page.waitForTimeout(opts.settleMs ?? 400);
  const filePath = path.join(OUT, filename);
  await page.screenshot({
    path: filePath,
    type: 'png',
    animations: 'disabled',
    fullPage: false,
    clip: opts.clip,
  });
  captured.push({ filename, description, route: opts.route || page.url().replace(BASE, '') });
  console.log('saved', filename);
  return filename;
}

async function ensureLoggedIn(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1200);
  const url = page.url();
  if (!/\/(login|register|connect)/.test(url) && url.includes('/app')) {
    return;
  }

  // Connect to local server if on /connect
  if (url.includes('/connect') || (await page.locator('input.input-field').count().catch(() => 0)) > 0) {
    if (page.url().includes('/connect')) {
      const fields = page.locator('input.input-field');
      if (await fields.first().isVisible().catch(() => false)) {
        await fields.first().fill(BASE);
        const connectBtn = page.getByRole('button', { name: /connect|continue/i }).first();
        if (await connectBtn.isVisible().catch(() => false)) {
          await connectBtn.click();
          await page.waitForTimeout(1500);
        }
      }
    }
  }

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('input.input-field', { timeout: 20_000 });
  const fields = page.locator('input.input-field');
  await fields.nth(0).fill(email);
  await fields.nth(1).fill(password);
  await page.getByRole('button', { name: /^log in$/i }).click();
  const loggedIn = await page.waitForURL(/\/app/, { timeout: 25_000 }).then(() => true).catch(() => false);
  if (loggedIn) return;

  const unique = Date.now();
  const user = `readme${String(unique).slice(-6)}`;
  const mail = `readme-${unique}@example.test`;
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
  const regFields = page.locator('input.input-field');
  await regFields.nth(0).fill(mail);
  // display name may be nth(1); username nth(2)
  if ((await regFields.count()) >= 5) {
    await regFields.nth(1).fill('Readme Capture');
    await regFields.nth(2).fill(user);
    await regFields.nth(3).fill(password);
    await regFields.nth(4).fill(password);
  } else {
    await regFields.nth(2).fill(user);
    await regFields.nth(3).fill(password);
    await regFields.nth(4).fill(password);
  }
  await page.locator('input[type="checkbox"]').check().catch(() => {});
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.waitForURL(/\/app/, { timeout: 45_000 });
}

async function ensureGuild(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await dismissOverlays(page);

  // Prefer showcase name, else any known space already on the demo account
  const candidates = [guildName, 'Fuel', 'Commons', 'General'];
  for (const name of candidates) {
    const btn = page.getByRole('button', { name: new RegExp(name, 'i') }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1200);
      await dismissOverlays(page);
      let match = page.url().match(/\/app\/guilds\/(\d+)/);
      if (match) return match[1];
      const enter = page.getByRole('button', { name: /enter space/i }).first();
      if (await enter.isVisible().catch(() => false)) {
        await enter.click();
        await page.waitForTimeout(1200);
        match = page.url().match(/\/app\/guilds\/(\d+)/);
        if (match) return match[1];
      }
    }
  }

  const spaceRow = page.locator('button').filter({ hasText: /unread|fuel|commons/i }).first();
  if (await spaceRow.isVisible().catch(() => false)) {
    await spaceRow.click();
    await page.waitForTimeout(1200);
    const match = page.url().match(/\/app\/guilds\/(\d+)/);
    if (match) return match[1];
  }

  const openCreate = page.getByRole('button', { name: /create a server|add a space|create server/i }).first();
  if (await openCreate.isVisible().catch(() => false)) {
    await openCreate.click();
    await page.waitForTimeout(600);
    const nameInput = page.locator('input.input-field').first();
    await nameInput.fill(guildName);
    await page.getByRole('button', { name: /^create$/i }).click();
    await page.waitForURL(/\/app\/guilds\/\d+/, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const match = page.url().match(/\/app\/guilds\/(\d+)/);
    if (match) return match[1];
  }

  throw new Error('Could not find or create a guild');
}

async function seedMessages(page, guildId) {
  await page.goto(`${BASE}/app/guilds/${guildId}`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  const general = page.getByRole('button', { name: /#?\s*general/i }).first();
  if (!(await general.isVisible().catch(() => false))) {
    // try link/text channel row
    const alt = page.locator('a, button').filter({ hasText: /#?\s*general/i }).first();
    if (!(await alt.isVisible().catch(() => false))) return null;
    await alt.click();
  } else {
    await general.click();
  }
  await page.waitForTimeout(1200);
  const m = page.url().match(/channels\/(\d+)/);
  const channelId = m?.[1] ?? null;
  const input = page.locator('[contenteditable="true"]').last();
  if (await input.isVisible().catch(() => false)) {
    const lines = [
      'Welcome to **Emerald Commons** — the v1.0 showcase server.',
      'Native QUIC voice, E2EE DMs, and the Rooms + Unified Stream layout.',
      'Jump into a voice room when you are ready — screen share and video grid included.',
    ];
    for (const line of lines) {
      await input.click();
      await input.fill('');
      await page.keyboard.type(line, { delay: 5 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
    }
  }
  return channelId;
}

async function findVoiceChannelId(page, guildId) {
  await page.goto(`${BASE}/app/guilds/${guildId}`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  const voice = page.locator('a, button').filter({ hasText: /voice|lounge|hangout|stage/i }).first();
  if (await voice.isVisible().catch(() => false)) {
    await voice.click();
    await page.waitForTimeout(1000);
    const m = page.url().match(/channels\/(\d+)/);
    return m?.[1] ?? null;
  }
  return null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Prefer dark emerald theme in localStorage before first paint when possible
  await page.addInitScript(() => {
    try {
      localStorage.setItem('paracord:theme', 'dark');
      localStorage.setItem('theme', 'dark');
      localStorage.setItem('paracord:accent', 'emerald');
      localStorage.setItem('paracord:layout-tour:shell', '1');
      localStorage.setItem('paracord:layout-tour:guild', '1');
    } catch {
      /* ignore */
    }
  });

  await ensureLoggedIn(page);
  await dismissOverlays(page);

  // Force dark appearance via settings if a toggle exists later
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.classList.add('dark');
  }).catch(() => {});

  const guildId = await ensureGuild(page);
  console.log('using guild', guildId);
  const textChannelId = await seedMessages(page, guildId);

  // --- Home / resume ---
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.waitForTimeout(1200);
  await shot(page, 'readme-home.png', 'Home / resume dashboard with unified sidebar', { route: '/app' });
  await shot(page, 'readme-sidebar.png', 'Unified sidebar: Needs you, Recent, and Spaces', { route: '/app' });

  // --- Guild rooms ---
  await page.goto(`${BASE}/app/guilds/${guildId}`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.waitForTimeout(1400);
  await shot(page, 'readme-rooms.png', 'Guild / server home Rooms view', {
    route: `/app/guilds/${guildId}`,
  });

  // --- Text channel ---
  let channelForChat = textChannelId;
  if (!channelForChat) {
    const general = page.getByRole('button', { name: /#?\s*general/i }).first();
    if (await general.isVisible().catch(() => false)) {
      await general.click();
      await page.waitForTimeout(1000);
      channelForChat = page.url().match(/channels\/(\d+)/)?.[1] ?? null;
    }
  }
  if (channelForChat) {
    await page.goto(`${BASE}/app/guilds/${guildId}/channels/${channelForChat}`, {
      waitUntil: 'domcontentloaded',
    });
    await dismissOverlays(page);
    await page.waitForTimeout(1400);
    await shot(page, 'readme-messaging.png', 'Text channel messaging with Emerald Commons theme', {
      route: `/app/guilds/${guildId}/channels/${channelForChat}`,
    });

    const membersBtn = page.getByRole('button', { name: /^members$/i }).first();
    if (await membersBtn.isVisible().catch(() => false)) {
      await membersBtn.click();
      await page.waitForTimeout(700);
      await shot(page, 'readme-members.png', 'Context panel member list beside chat', {
        route: `/app/guilds/${guildId}/channels/${channelForChat}`,
      });
      await page.keyboard.press('Escape');
    } else {
      skipped.push({ filename: 'readme-members.png', reason: 'Members button not found' });
    }
  } else {
    skipped.push({ filename: 'readme-messaging.png', reason: 'No text channel found' });
  }

  // --- Voice lobby / channel ---
  const voiceId = await findVoiceChannelId(page, guildId);
  if (voiceId) {
    await page.goto(`${BASE}/app/guilds/${guildId}/channels/${voiceId}`, { waitUntil: 'domcontentloaded' });
    await dismissOverlays(page);
    await page.waitForTimeout(1400);
    await shot(page, 'readme-voice.png', 'Voice channel lobby / video grid surface', {
      route: `/app/guilds/${guildId}/channels/${voiceId}`,
    });

    const joinBtn = page.getByRole('button', { name: /^join$/i }).first();
    if (await joinBtn.isVisible().catch(() => false)) {
      await joinBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
      await dismissOverlays(page);
      await shot(page, 'readme-voice-joined.png', 'Connected voice channel with control bar', {
        route: `/app/guilds/${guildId}/channels/${voiceId}`,
      });
      // Leave if possible to avoid hanging media
      const leave = page.getByRole('button', { name: /leave|disconnect/i }).first();
      if (await leave.isVisible().catch(() => false)) {
        await leave.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  } else {
    skipped.push({
      filename: 'readme-voice.png',
      reason: 'No voice channel found in Emerald Commons',
    });
  }

  // --- Friends / DMs ---
  await page.goto(`${BASE}/app/friends`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.waitForTimeout(900);
  await shot(page, 'readme-friends.png', 'Friends page', { route: '/app/friends' });

  await page.goto(`${BASE}/app/dms`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.waitForTimeout(900);
  await shot(page, 'readme-dms.png', 'Direct messages hub', { route: '/app/dms' });

  // --- Command palette ---
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(700);
  await shot(page, 'readme-command-palette.png', 'Command palette (Ctrl+K)', { route: '/app' });
  await page.keyboard.press('Escape');

  // --- User settings (Appearance preferred for polished theme shot) ---
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(900);
  const appearance = page.getByRole('button', { name: /^appearance$/i }).first();
  if (await appearance.isVisible().catch(() => false)) {
    await appearance.click();
    await page.waitForTimeout(600);
  }
  await shot(page, 'readme-settings.png', 'User settings — Appearance / theme (Emerald Commons dark)', {
    route: '/app',
  });
  await page.keyboard.press('Escape');

  // --- Guild settings ---
  await page.goto(`${BASE}/app/guilds/${guildId}`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.keyboard.press('Control+Shift+,');
  await page.waitForTimeout(1000);
  if (page.url().includes('settings') || (await page.getByText(/overview|server name|channels/i).first().isVisible().catch(() => false))) {
    await shot(page, 'readme-guild-settings.png', 'Guild settings overview', {
      route: `/app/guilds/${guildId}`,
    });
  } else {
    // try gear button
    const gear = page.getByRole('button', { name: /settings|server settings/i }).first();
    if (await gear.isVisible().catch(() => false)) {
      await gear.click();
      await page.waitForTimeout(900);
      await shot(page, 'readme-guild-settings.png', 'Guild settings overview', {
        route: `/app/guilds/${guildId}`,
      });
    } else {
      skipped.push({ filename: 'readme-guild-settings.png', reason: 'Guild settings overlay did not open' });
    }
  }
  await page.keyboard.press('Escape');

  // Also keep legacy unprefixed aliases expected by current README.md
  const aliases = [
    ['readme-home.png', 'home.png'],
    ['readme-sidebar.png', 'unified-sidebar.png'],
    ['readme-rooms.png', 'rooms-view.png'],
    ['readme-messaging.png', 'text-chat.png'],
  ];
  const { copyFile } = await import('node:fs/promises');
  for (const [src, dest] of aliases) {
    try {
      await copyFile(path.join(OUT, src), path.join(OUT, dest));
      console.log('alias', dest);
    } catch {
      /* source missing */
    }
  }

  const manifestMd = [
    '# README promo screenshots',
    '',
    `Captured: ${new Date().toISOString()}`,
    `Base URL: \`${BASE}\``,
    `Viewport: ${VIEWPORT.width}×${VIEWPORT.height}`,
    `Theme target: dark Emerald Commons`,
    '',
    '## Files',
    '',
    ...captured.map((c) => `- \`${c.filename}\` — ${c.description}`),
    '',
  ];
  if (skipped.length) {
    manifestMd.push('## Skipped / incomplete', '');
    for (const s of skipped) {
      manifestMd.push(`- \`${s.filename}\` — ${s.reason}`);
    }
    manifestMd.push('');
  }
  manifestMd.push(
    '## Notes',
    '',
    '- No auth tokens or secrets are stored in these images intentionally; review before publishing.',
    '- Voice/stream shots may show an empty lobby if no second client was connected.',
    '- Legacy aliases (`home.png`, `unified-sidebar.png`, `rooms-view.png`, `text-chat.png`) mirror the `readme-*` names for the current README image paths.',
    '',
  );

  await writeFile(path.join(OUT, 'MANIFEST.md'), `${manifestMd.join('\n')}\n`);
  await writeFile(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        viewport: VIEWPORT,
        base_url: BASE,
        captured,
        skipped,
      },
      null,
      2,
    )}\n`,
  );
  console.log('wrote MANIFEST.md + manifest.json');
  console.log(JSON.stringify({ captured: captured.length, skipped: skipped.length }, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
