import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/guild-modals';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
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
await page.waitForTimeout(600);

// In-app: click guild rail pill (SPA nav, keeps auth)
await page.getByRole('button', { name: 'Polish Probe HQ', exact: true }).click().catch(()=>{});
await page.waitForTimeout(1200);
// dismiss any settings/onboarding overlay
await page.keyboard.press('Escape').catch(()=>{});
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(400);
// select #general treeitem to ensure a text channel context
await page.getByRole('treeitem').filter({ hasText: /general/i }).first().click().catch(()=>{});
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/_dbg-guildpage.png` });

// Open server menu
await page.getByRole('button', { name: 'Open server menu' }).click({ timeout: 8000 });
await page.waitForTimeout(500);
await page.getByRole('button', { name: /Invite People/i }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/${PHASE}-invite-modal.png` });

// options-dirty state
await page.getByRole('combobox').first().selectOption('1hr').catch(()=>{});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/${PHASE}-invite-modal-dirty.png` });

await b.close();
console.log('done invite', PHASE);
