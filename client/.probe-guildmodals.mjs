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
await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
await page.getByPlaceholder('Enter your password').fill(PASSWORD);
await page.getByRole('button', { name: 'Log In' }).click();
await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 15000 });
await page.waitForTimeout(1500);

// dismiss onboarding if present
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(500);

// Open create-server modal
await page.getByRole('button', { name: 'Add a server' }).click();
await page.waitForTimeout(700);
const dialog = page.getByRole('dialog');
await page.screenshot({ path: `${OUT}/${PHASE}-create-tab.png` });

// Join tab
await dialog.getByRole('button', { name: 'Join', exact: true }).click().catch(()=>{});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/${PHASE}-join-tab.png` });

// Template tab
await dialog.getByRole('button', { name: 'Template', exact: true }).click().catch(()=>{});
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/${PHASE}-template-tab.png` });

// Close modal
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Open invite modal: navigate into guild general, then use invite entrypoint
await page.goto(`${BASE}/app/guilds/331819912232177664/channels/331819912232177665`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(400);

// Try to open invite modal via guild header menu
let inviteOpened = false;
try {
  await page.getByRole('button', { name: /Open server menu/i }).click();
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: /Invite/i }).click();
  await page.waitForTimeout(1000);
  inviteOpened = true;
} catch (e) { console.log('menu invite failed', e.message); }

if (!inviteOpened) {
  // try an "Invite" button/text anywhere
  try {
    await page.getByText(/Invite People|Invite friends|Invite/i).first().click();
    await page.waitForTimeout(1000);
    inviteOpened = true;
  } catch(e) { console.log('fallback invite failed', e.message); }
}
if (inviteOpened) {
  await page.screenshot({ path: `${OUT}/${PHASE}-invite-modal.png` });
} else {
  console.log('INVITE MODAL NOT OPENED');
}

await b.close();
console.log('done', PHASE);
