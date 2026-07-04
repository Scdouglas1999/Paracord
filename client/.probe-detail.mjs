import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:1420';
const OUT = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/polish-shots/channel-nav';
const PHASE = process.argv[2] || 'before';
const STATE = '/tmp/claude-1000/-home-scdouglas-Documents-Paracord/ba049638-ebf3-46fa-821d-934fdc5e82a4/scratchpad/channelnav-state.json';

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, storageState: fs.existsSync(STATE) ? STATE : undefined });
const page = await ctx.newPage();
await page.goto(`${BASE}/app/guilds/331819912232177664/channels/331819912232177665`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.getByRole('button', { name: 'Jump in' }).click().catch(()=>{});
await page.waitForTimeout(1000);

const gen = page.getByRole('treeitem').filter({ hasText: /general/i }).first();
const gbox = await gen.boundingBox().catch(()=>null);
console.log('general box', JSON.stringify(gbox));

// tight sidebar crop
await page.screenshot({ path: `${OUT}/${PHASE}-sidebar-tight.png`, clip: { x: 84, y: 8, width: 272, height: 400 } });
await b.close();
console.log('done detail', PHASE);
