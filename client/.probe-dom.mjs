import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:1420';
const USERNAME = 'polish_probe_7k3';
const PASSWORD = 'PolishProbe#2026';
const STATE = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/channelnav-state.json';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/channel-nav';
const PHASE = process.argv[2] || 'before';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();

async function login() {
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    if (page.url().includes('/app')) return true;
    await page.getByRole('textbox', { name: /Email or Username|Email/ }).fill(USERNAME);
    await page.getByPlaceholder('Enter your password').fill(PASSWORD);
    let got429 = false;
    const onResp = r => { if (r.url().includes('/auth/login') && r.status() === 429) got429 = true; };
    page.on('response', onResp);
    await page.getByRole('button', { name: 'Log In' }).click();
    try { await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 8000 }); page.off('response', onResp); return true; } catch {}
    page.off('response', onResp);
    const wait = got429 ? 16000 + attempt * 4000 : 3000;
    console.log(`login attempt ${attempt} failed (429=${got429}); wait ${wait}`);
    await page.waitForTimeout(wait);
  }
  return false;
}

if (!await login()) { console.log('LOGIN FAILED'); await b.close(); process.exit(1); }
await ctx.storageState({ path: STATE });

await page.getByRole('button', { name: 'Polish Probe HQ', exact: true }).first().waitFor({ timeout: 15000 });
await page.goto(`${BASE}/app/guilds/331819912232177664/channels/331819912232177665`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const btn = document.querySelector('nav[aria-label="Servers"] button[aria-label="Polish Probe HQ"]');
  if (!btn) return { err: 'no active guild button' };
  const wrapper = btn.closest('div.relative');
  const pill = wrapper?.querySelector('span.absolute');
  const pr = pill?.getBoundingClientRect();
  const clips = [];
  let el = wrapper;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      clips.push({ cls: el.className.slice(0, 50), ox: cs.overflowX, oy: cs.overflowY, left: Math.round(r.left), right: Math.round(r.right) });
    }
    el = el.parentElement;
  }
  return {
    pillExists: !!pill,
    pillColor: pill ? getComputedStyle(pill).backgroundColor : null,
    pillRect: pr ? { left: Math.round(pr.left), width: Math.round(pr.width), height: Math.round(pr.height) } : null,
    wrapperLeft: Math.round(wrapper.getBoundingClientRect().left),
    listLeft: (() => { const l = document.querySelector('nav[aria-label="Servers"] .overflow-y-auto'); return l ? Math.round(l.getBoundingClientRect().left) : null; })(),
    navLeft: Math.round(document.querySelector('nav[aria-label="Servers"]').getBoundingClientRect().left),
    clips,
  };
});
console.log(JSON.stringify(info, null, 2));

await page.screenshot({ path: `${OUT}/${PHASE}-rail-confirm.png`, clip: { x: 0, y: 60, width: 80, height: 320 } });
await b.close();
