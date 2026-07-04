import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/members-top';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
await page.getByPlaceholder('Enter your password').fill(PASSWORD);
await page.getByRole('button', { name: 'Log In' }).click();
try {
  await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 25000 });
} catch {
  await page.screenshot({ path: `${OUT}/${PHASE}-loginfail.png` });
  console.log('login failed, url:', page.url());
  await b.close();
  process.exit(2);
}
await page.waitForTimeout(2500);
console.log('after-login url:', page.url());

// Pure client-side navigation — NO page.goto reload (session lives in sessionStorage)
await page.getByRole('button', { name: 'Polish Probe HQ', exact: true }).click().catch((e) => console.log('pill click:', e.message));
await page.waitForTimeout(1200);
await page.keyboard.press('Escape').catch(() => {});
await page.getByRole('button', { name: 'Jump in' }).click().catch(() => {});
await page.waitForTimeout(700);
await page.getByRole('treeitem').filter({ hasText: /general/i }).first().click().catch((e) => console.log('treeitem click:', e.message));
await page.waitForTimeout(900);
await page.getByRole('button', { name: 'Jump in' }).click().catch(() => {});
await page.waitForTimeout(900);
console.log('final url:', page.url());

await page.screenshot({ path: `${OUT}/${PHASE}-full.png` });
await page.screenshot({ path: `${OUT}/${PHASE}-topbar.png`, clip: { x: 0, y: 0, width: 1600, height: 60 } });
await page.screenshot({ path: `${OUT}/${PHASE}-memberlist.png`, clip: { x: 1600 - 260, y: 0, width: 260, height: 900 } });

const footer = page.locator('.panel-divider').first();
if (await footer.count()) {
  const box = await footer.boundingBox();
  if (box) {
    await page.screenshot({ path: `${OUT}/${PHASE}-userfooter.png`, clip: { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: box.width + 12, height: box.height + 12 } });
  }
}

await b.close();
console.log('done', PHASE);
