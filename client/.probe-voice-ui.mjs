import { chromium } from 'playwright';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/voice-ui';
const GUILD = '331819912232177664';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
await page.getByPlaceholder('Enter your password').fill(PASSWORD);
await page.getByRole('button', { name: 'Log In' }).click();
await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 15000 });
await page.waitForTimeout(2000);
console.log('after login url:', page.url());

const tag = process.argv[2] || 'before';
await page.screenshot({ path: `${OUT}/${tag}-postlogin.png` });

// Enter guild via rail pill (in-app nav, no hard reload)
await page.getByRole('button', { name: 'Polish Probe HQ', exact: true }).click().catch((e)=>console.log('pill click err', e.message));
await page.waitForTimeout(1500);
console.log('after pill url:', page.url());
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(500);

const items = await page.getByRole('treeitem').allInnerTexts();
console.log('treeitems:', JSON.stringify(items));

// Join voice channel "General" (capital, text channel is "general")
const voiceItem = page.getByRole('treeitem').filter({ hasText: /General/ }).first();
await voiceItem.click().catch((e)=>console.log('voice click err', e.message));
await page.waitForTimeout(3000);
console.log('after voice-join url:', page.url());
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(1500);
console.log('before voice-full url:', page.url());

await page.screenshot({ path: `${OUT}/${tag}-voice-full.png` });
// docked control bar region (bottom center)
await page.screenshot({ path: `${OUT}/${tag}-controlbar.png`, clip: { x: 500, y: 780, width: 900, height: 120 } });

// Now go to a text channel while still in voice -> MiniVoiceBar appears in sidebar
const textItem = page.getByRole('treeitem').filter({ hasText: /general/ }).first();
await textItem.click().catch(()=>{});
await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/${tag}-minivoicebar-full.png` });
await page.screenshot({ path: `${OUT}/${tag}-minivoicebar.png`, clip: { x: 72, y: 770, width: 320, height: 130 } });

await b.close();
console.log('done', tag);
