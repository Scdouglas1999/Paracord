import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/settings';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
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

await page.getByRole('button', { name: 'My Account', exact: true }).first().click();
await page.waitForTimeout(400);
await page.mouse.move(928, 500);
async function wheelShot(px, name) {
  await page.mouse.wheel(0, px);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${PHASE}-${name}.png` });
  console.log('shot', name);
}
await wheelShot(650, 'account-s1');
await wheelShot(650, 'account-s2');
await wheelShot(650, 'account-s3');
await wheelShot(650, 'account-s4');

await b.close();
console.log('DONE');
