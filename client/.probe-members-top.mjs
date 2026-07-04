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
const pill = page.getByRole('button', { name: 'Polish Probe HQ', exact: true });
for (let i = 0; i < 5 && !page.url().includes('/guilds/'); i++) {
  await pill.first().click({ timeout: 4000 }).catch((e) => console.log('pill click:', e.message));
  await page.waitForFunction(() => location.pathname.includes('/guilds/'), { timeout: 4000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}
await page.getByRole('button', { name: 'Jump in' }).click().catch(() => {});
await page.waitForTimeout(500);
const general = page.getByRole('treeitem').filter({ hasText: /general/i }).first();
await general.click({ timeout: 8000 }).catch((e) => console.log('treeitem click:', e.message));
await page.waitForTimeout(900);
await page.getByRole('button', { name: 'Jump in' }).click().catch(() => {});
await page.waitForTimeout(900);
console.log('final url:', page.url());

// Open the member panel (Users icon in top bar) so MemberList renders
const membersBtn = page.getByRole('button', { name: 'Member List' });
if (await membersBtn.count()) {
  // Toggle until the member list (aria-label="Member list") is visible
  const memberList = page.locator('[aria-label="Member list"]');
  if (!(await memberList.count()) || !(await memberList.first().isVisible().catch(() => false))) {
    await membersBtn.first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
}
await page.waitForTimeout(600);

await page.screenshot({ path: `${OUT}/${PHASE}-full.png` });
await page.screenshot({ path: `${OUT}/${PHASE}-topbar.png`, clip: { x: 0, y: 0, width: 1600, height: 56 } });
// Top-bar right action cluster, zoomed
await page.screenshot({ path: `${OUT}/${PHASE}-topbar-right.png`, clip: { x: 1600 - 420, y: 0, width: 420, height: 56 } });

const memberList = page.locator('[aria-label="Member list"]').first();
if (await memberList.count()) {
  const box = await memberList.boundingBox();
  if (box) {
    await page.screenshot({ path: `${OUT}/${PHASE}-memberlist.png`, clip: { x: box.x, y: 0, width: box.width, height: 900 } });
  }
}

// User footer: the panel-divider that contains the Copy-username button
const footer = page.locator('div.panel-divider').filter({ has: page.locator('[aria-label^="Copy username"]') }).first();
if (await footer.count()) {
  const box = await footer.boundingBox();
  if (box) {
    await page.screenshot({ path: `${OUT}/${PHASE}-userfooter.png`, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 } });
  }
}

await b.close();
console.log('done', PHASE);
