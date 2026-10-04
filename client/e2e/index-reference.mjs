/**
 * Renders the approved Index prototype (output/design-reference/index/
 * paracord-index.html) at exactly 1x, one PNG per named state, so every Index
 * package compares its own 1280x800 screenshots against the same geometry.
 *
 *   cd client
 *   node e2e/index-reference.mjs
 *   → output/design-reference/index/ref/<state>.png  (1280x800 each)
 *
 * The prototype scales its 1280x800 stage to the width of its viewport box; at
 * a 1312px window the box is exactly 1280 wide, so the scale is 1 and the
 * shots are pixel-true. Reduced motion stays off: each step waits for its
 * motion to settle before the shot.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'output', 'design-reference', 'index', 'paracord-index.html');
const OUT = join(ROOT, 'output', 'design-reference', 'index', 'ref');
const SETTLE_MS = 1600;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1312, height: 1100 } });

async function load() {
  await page.goto(pathToFileURL(SRC).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const scale = await page.$eval('#vp', (vp) => vp.clientWidth / 1280);
  if (Math.abs(scale - 1) > 1e-6) throw new Error(`prototype stage scale is ${scale}, expected 1`);
}

async function shot(name) {
  await page.waitForTimeout(SETTLE_MS);
  const file = join(OUT, `${name}.png`);
  // The stage can sit on a fractional offset; clip an exact 1280x800 box.
  const box = await page.$eval('#vp', (vp) => {
    const r = vp.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  });
  await page.screenshot({
    path: file,
    fullPage: true,
    clip: { x: Math.round(box.x), y: Math.round(box.y), width: 1280, height: 800 },
  });
  console.log(`  ${name}.png`);
}

const step = () => page.click('#next');
const scrollFeed = (y) => page.$eval('#scroll', (s, top) => {
  s.scrollTop = top;
  s.dispatchEvent(new Event('scroll'));
}, y);

console.log(`Index reference → ${OUT}`);

// Quiet: new server, welcome cards; then the draft event and the open message box.
await load();
await shot('s0-quiet');
await page.click('.way[data-w="plan"]');
await shot('s0-plan-a-night');
await page.click('#msg');
await page.keyboard.type('testing the box');
await shot('s0-message-box-open');

// The story: arrives, joined, call open, another server, busy.
await load();
await step(); await shot('s1-someone-arrives');
await step(); await shot('s2-joined');
await step(); await shot('s3-call-open');
await step(); await shot('s4-other-server');
await step(); await page.waitForTimeout(1500); await scrollFeed(1e6); await shot('s5-busy');
await scrollFeed(120); await shot('s5-busy-title-folded');
await page.click('.dk[data-s="people"]'); await shot('s6-people');

await browser.close();
