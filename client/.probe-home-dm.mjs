import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/home-dm';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
await page.getByPlaceholder('Enter your password').fill(PASSWORD);
await page.getByRole('button', { name: 'Log In' }).click();
await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 15000 });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Jump in' }).click().catch(() => {});
await page.waitForTimeout(400);

// Zoom crops of home surfaces
// Right rail region
await page.screenshot({ path: `${OUT}/${PHASE}-zoom-rightrail.png`, clip: { x: 1245, y: 145, width: 340, height: 560 } });
// Empty-state cards (main column)
await page.screenshot({ path: `${OUT}/${PHASE}-zoom-cards.png`, clip: { x: 395, y: 145, width: 830, height: 580 } });
// DM list rail
await page.screenshot({ path: `${OUT}/${PHASE}-zoom-dmrail.png`, clip: { x: 78, y: 10, width: 292, height: 520 } });

await b.close();
console.log('done', PHASE);
