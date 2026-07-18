import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(CLIENT_ROOT, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images', 'readme');

const BASE_URL = (process.env.PARACORD_SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:8090')
  .replace(/\/+$/, '');
const USERNAME = process.env.PARACORD_SCREENSHOT_USER;
const PASSWORD = process.env.PARACORD_SCREENSHOT_PASSWORD;

function requireFixtureCredentials() {
  if (USERNAME && PASSWORD) return;
  throw new Error(
    [
      'README screenshots require a populated local fixture instance.',
      'Set PARACORD_SCREENSHOT_USER and PARACORD_SCREENSHOT_PASSWORD, and optionally',
      'PARACORD_SCREENSHOT_BASE_URL (default: http://127.0.0.1:8090).',
      'Use temporary fixture data only; never point this script at production.',
    ].join('\n'),
  );
}

async function expectOne(locator, description) {
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`Expected one ${description}, found ${count}.`);
  }
  return locator;
}

async function dismissIfPresent(page, role, name) {
  const locator = page.getByRole(role, { name, exact: true });
  if ((await locator.count()) === 1) {
    await locator.click();
  }
}

async function dismissWhenReady(page, role, name, timeout = 2_000) {
  const locator = page.getByRole(role, { name, exact: true });
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch {
    return;
  }
  await expectOne(locator, `${name} button`);
  await locator.click();
}

async function capture(page, name) {
  await page.screenshot({
    path: path.join(OUT_DIR, name),
    type: 'jpeg',
    quality: 88,
    fullPage: false,
  });
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

  const identity = page.getByPlaceholder('you@example.com or username', { exact: true });
  const password = page.getByPlaceholder('Enter your password', { exact: true });
  await identity.waitFor({ timeout: 20_000 });
  await expectOne(identity, 'login identity field');
  await expectOne(password, 'login password field');

  await identity.fill(USERNAME);
  await password.fill(PASSWORD);
  await (await expectOne(page.getByRole('button', { name: 'Log In', exact: true }), 'Log In button')).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 20_000 });
  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 20_000 });

  await dismissIfPresent(page, 'button', 'Skip tour');
}

async function openFirstSpace(page) {
  const spaces = page.getByRole('region', { name: 'Spaces', exact: true });
  await expectOne(spaces, 'Spaces region');

  const joinedSpaces = spaces.getByRole('group', { name: 'Joined spaces', exact: true });
  await expectOne(joinedSpaces, 'Joined spaces group');

  const candidates = await joinedSpaces.getByRole('option').all();
  for (const candidate of candidates) {
    const name = (await candidate.getAttribute('aria-label')) ?? (await candidate.innerText());
    if (!/add a space/i.test(name)) {
      await candidate.click();
      return;
    }
  }
  throw new Error('The fixture account must belong to at least one space.');
}

async function openFirstTextChannel(page) {
  const channels = page.getByRole('region', { name: 'Text channels', exact: true });
  await expectOne(channels, 'Text channels region');
  const buttons = await channels.getByRole('button').all();
  if (buttons.length === 0) {
    throw new Error('The fixture space must contain at least one text channel.');
  }
  await buttons[0].click();
  await page.getByRole('textbox', { name: /^Message #/ }).waitFor({ timeout: 20_000 });
  await dismissIfPresent(page, 'button', 'Close welcome screen');
}

async function run() {
  requireFixtureCredentials();
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });

    await login(page);
    await capture(page, 'home-2026.jpg');

    await openFirstSpace(page);
    await page.getByRole('region', { name: 'Rooms', exact: true }).waitFor({ timeout: 20_000 });
    await dismissWhenReady(page, 'button', 'Done');
    await capture(page, 'rooms-2026.jpg');

    await openFirstTextChannel(page);
    await page.getByRole('feed', { name: 'Message history', exact: true }).waitFor({ timeout: 20_000 });
    await capture(page, 'messaging-2026.jpg');

    const memberList = await expectOne(
      page.getByRole('button', { name: 'Member List', exact: true }),
      'Member List button',
    );
    await memberList.click();
    await page.getByRole('complementary', { name: 'Members', exact: true }).waitFor();
    await capture(page, 'members-2026.jpg');
    await (await expectOne(
      page.getByRole('button', { name: 'Close Members panel', exact: true }),
      'Close Members panel button',
    )).click();

    await (await expectOne(
      page.getByRole('button', { name: 'Search — open command palette', exact: true }),
      'command palette button',
    )).click();
    await page.getByRole('dialog', { name: 'Command Palette', exact: true }).waitFor();
    await capture(page, 'command-palette-2026.jpg');
    await page.getByRole('textbox', { name: 'Search command palette', exact: true }).press('Escape');

    await (await expectOne(
      page.getByRole('button', { name: 'Open user settings', exact: true }),
      'user settings button',
    )).click();
    await (await expectOne(
      page.getByRole('button', { name: 'Appearance', exact: true }),
      'Appearance settings button',
    )).click();
    await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    await capture(page, 'appearance-2026.jpg');
    await (await expectOne(
      page.getByRole('button', { name: 'Close user settings', exact: true }),
      'Close user settings button',
    )).click();

    await (await expectOne(
      page.getByRole('button', { name: 'Space settings', exact: true }),
      'Space settings button',
    )).click();
    await page.getByRole('dialog', { name: 'Space settings', exact: true }).waitFor();
    await capture(page, 'space-settings-2026.jpg');
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
