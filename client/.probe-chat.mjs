import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/chat';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();

let ok = false;
for (let attempt = 0; attempt < 5 && !ok; attempt++) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const idField = page.getByRole('textbox', { name: /Email or Username|Email/ });
  await idField.click();
  await idField.fill(USERNAME);
  const pwField = page.getByPlaceholder('Enter your password');
  await pwField.click();
  await pwField.fill(PASSWORD);
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Log In' }).click();
  for (let i = 0; i < 16 && !ok; i++) {
    await page.waitForTimeout(1000);
    if (page.url().includes('/app')) ok = true;
  }
  if (!ok) console.log('login attempt', attempt, 'failed, retrying');
}
if (!ok) { console.log('LOGIN GAVE UP'); await b.close(); process.exit(1); }
await page.waitForTimeout(1500);

await page.goto(`${BASE}/app/guilds/331819912232177664/channels/331819912232177665`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(800);

await page.screenshot({ path: `${OUT}/${PHASE}-messagelist-full.png` });

await page.evaluate(() => {
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 300) el.scrollTop = el.scrollHeight;
  }
});
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/${PHASE}-messagelist-bottom.png` });

// hover a message near middle for action bar
await page.mouse.move(800, 520);
await page.waitForTimeout(300);
await page.mouse.move(820, 470);
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/${PHASE}-message-hover.png` });

// zoom hovered message region
await page.screenshot({ path: `${OUT}/${PHASE}-message-hover-zoom.png`, clip: { x: 300, y: 380, width: 1200, height: 200 } });

const ta = page.locator('textarea').first();
await ta.click().catch(()=>{});
await ta.fill('This is a test message typed into the composer to check spacing and padding around the input and its toolbar buttons.').catch(()=>{});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/${PHASE}-composer-text.png` });

try {
  const box = await ta.boundingBox();
  if (box) {
    const cy = Math.max(0, box.y - 110);
    await page.screenshot({ path: `${OUT}/${PHASE}-composer-zoom.png`, clip: { x: Math.max(0, box.x - 60), y: cy, width: Math.min(1600 - Math.max(0, box.x - 60), box.width + 120), height: Math.min(900 - cy, box.height + 190) } });
  }
} catch (e) { console.log('zoom fail', e.message); }

await ta.fill('').catch(()=>{});
await b.close();
console.log('done', PHASE);
