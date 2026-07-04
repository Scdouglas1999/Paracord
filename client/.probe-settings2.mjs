import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/settings';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1800 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
await page.getByPlaceholder('Enter your password').fill(PASSWORD);
await page.getByRole('button', { name: 'Log In' }).click();
await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 15000 }).catch(() => {});
await page.getByRole('button', { name: 'Jump in' }).click().catch(() => {});
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Open user settings' }).first().click();
await page.getByRole('navigation', { name: 'User settings' }).waitFor({ timeout: 8000 });
await page.waitForTimeout(400);

async function shot(label, name) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${PHASE}-${name}.png`, fullPage: true });
  console.log('shot', name);
}

await shot('Appearance', 'appearance-full');
await shot('My Account', 'account-full');

await b.close();
console.log('DONE');
