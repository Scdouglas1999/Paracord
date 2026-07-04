import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/guild-modals';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
if (!page.url().includes('/app')) {
  await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
  await page.getByPlaceholder('Enter your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).click();
}
await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 20000 });
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(500);

async function shotModal(name) {
  const dlg = page.getByRole('dialog');
  await dlg.waitFor({ timeout: 5000 });
  const box = await dlg.locator('..').boundingBox().catch(()=>null);
  const b2 = await dlg.boundingBox();
  await page.screenshot({ path: `${OUT}/zoom-${PHASE}-${name}.png`, clip: {
    x: Math.max(0, b2.x - 12), y: Math.max(0, b2.y - 12),
    width: Math.min(1600 - Math.max(0,b2.x-12), b2.width + 24),
    height: Math.min(900 - Math.max(0,b2.y-12), b2.height + 24),
  }});
}

// Create modal
await page.getByRole('button', { name: 'Add a server' }).click();
await page.waitForTimeout(700);
const dialog = page.getByRole('dialog');
await shotModal('create');
await dialog.getByRole('button', { name: 'Join', exact: true }).click();
await page.waitForTimeout(400);
await shotModal('join');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await b.close();
console.log('done zoom', PHASE);
