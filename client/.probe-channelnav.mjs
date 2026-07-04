import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/channel-nav';
const PHASE = process.argv[2] || 'before';
const STATE = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/channelnav-state.json';

const b = await chromium.launch();
const haveState = fs.existsSync(STATE);
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, storageState: haveState ? STATE : undefined });
const page = await ctx.newPage();

async function login() {
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    if (page.url().includes('/app')) return true;
    const id = page.getByRole('textbox', { name: /Email or Username|Email/ });
    await id.fill(USERNAME);
    await page.getByPlaceholder('Enter your password').fill(PASSWORD);
    let got429 = false;
    const onResp = r => { if (r.url().includes('/auth/login') && r.status() === 429) got429 = true; };
    page.on('response', onResp);
    await page.getByRole('button', { name: 'Log In' }).click();
    try {
      await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 8000 });
      page.off('response', onResp);
      return true;
    } catch {}
    page.off('response', onResp);
    const wait = got429 ? 15000 + attempt * 5000 : 3000;
    console.log(`attempt ${attempt} failed (429=${got429}); waiting ${wait}ms`);
    await page.waitForTimeout(wait);
  }
  return false;
}

let ok = page.url().includes('/app');
if (!ok) {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' }).catch(()=>{});
  ok = page.url().includes('/app');
}
if (!ok) ok = await login();
if (!ok) { console.log('LOGIN FAILED'); await b.close(); process.exit(1); }

await ctx.storageState({ path: STATE });

await page.goto(`${BASE}/app/guilds/331819912232177664/channels/331819912232177665`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(1000);
console.log('final url', page.url());

await page.screenshot({ path: `${OUT}/${PHASE}-full-window.png` });
await page.screenshot({ path: `${OUT}/${PHASE}-leftnav.png`, clip: { x: 0, y: 0, width: 320, height: 900 } });

const chan = page.getByRole('treeitem').filter({ hasText: /random/i }).first();
await chan.hover().catch(()=>{});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/${PHASE}-leftnav-hover.png`, clip: { x: 0, y: 0, width: 320, height: 900 } });

const pill = page.getByRole('button', { name: 'Polish Probe HQ', exact: true }).first();
await pill.hover().catch(()=>{});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/${PHASE}-guildrail-hover.png`, clip: { x: 0, y: 0, width: 90, height: 900 } });

await b.close();
console.log('done', PHASE);
