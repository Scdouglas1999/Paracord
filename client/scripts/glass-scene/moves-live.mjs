// The stage's moves on a real stream (WP-G15): Sean's client watches Vincent's
// share on a live instance and each move is held at fixed moments (every
// running animation paused at the same time), one run of the move per frame.
// Needs a scene held by `glass-scene.mjs --hold` against the same instance.
//
//   node client/scripts/glass-scene/moves-live.mjs --base http://127.0.0.1:<port> \
//        --scene output/design-reference/glass-build/<wp>/live/scene.json --out <dir>

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, openAs, press, CONTROLS, sceneOnScreen } from './ui.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:18420');
const scene = JSON.parse(readFileSync(resolve(arg('scene', 'output/design-reference/glass-build/live/scene.json')), 'utf8'));
const out = resolve(arg('out', 'output/design-reference/glass-build/live/moves'));
mkdirSync(out, { recursive: true });
const FRAMES = [0, 80, 180, 320, 650];

const log = line => console.log(line);
const browser = await launchBrowser();
let failed = false;
try {
  const sean = await openAs(browser, base, { ...scene.accounts.sean, name: 'Sean' }, { log, media: { voice: 'quiet' } });
  const { page } = sean;
  const general = `/app/guilds/${scene.servers.gameNight.id}/channels/${scene.servers.gameNight.channels.general}`;
  await page.goto(general);
  await page.getByText('bringing the projector').first().waitFor({ timeout: 30_000 });

  const settle = async () => {
    for (let i = 0; i < 60; i += 1) {
      const busy = await page.evaluate(() =>
        document.getAnimations().filter(a => a.id.startsWith('glass-morph:') && a.playState === 'running').length
        + document.querySelectorAll('.glass-morph > *').length);
      if (busy === 0) return;
      await page.waitForTimeout(100);
    }
    throw new Error('a move did not settle');
  };
  const freeze = ms => page.evaluate(t => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
  }, ms);
  const resume = () => page.evaluate(() => document.getAnimations().forEach(a => a.play()));
  const streamSeen = async () => {
    const box = await page.locator('.glass-frame__stage .glass-stage__stream').first().boundingBox();
    return box ? sceneOnScreen(page, box) : { teal: 0, amber: 0 };
  };

  // Watch once so the stream is warm, then close; each frame reopens it.
  await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
  for (let i = 0; i < 40; i += 1) { const seen = await streamSeen(); if (seen.teal > 300) break; await page.waitForTimeout(500); }
  await settle();
  await press(page, CONTROLS.stopWatching);
  await settle();
  for (const ms of FRAMES) {
    await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
    await freeze(ms);
    await page.screenshot({ path: join(out, `open-${String(ms).padStart(3, '0')}.png`) });
    await resume();
    await settle();
    await page.waitForTimeout(1500);
    await press(page, CONTROLS.stopWatching);
    await settle();
  }
  // Side by side -> theater, on the real picture.
  await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
  await settle();
  await page.waitForTimeout(2000);
  for (const ms of FRAMES) {
    await press(page, CONTROLS.theater);
    await freeze(ms);
    await page.screenshot({ path: join(out, `theater-${String(ms).padStart(3, '0')}.png`) });
    await resume();
    await settle();
    const seen = await streamSeen();
    log(`  theater at rest: ${seen.teal}px teal, ${seen.amber}px amber`);
    if (!(seen.teal > 300)) { failed = true; log('  FAIL the stream is not on screen after the move'); }
    await press(page, CONTROLS.sideBySide);
    await settle();
  }
  await press(page, CONTROLS.stopWatching);
  const errors = sean.logs.filter(line => line.startsWith('pageerror'));
  if (errors.length) { failed = true; log(`  page errors:\n    ${errors.join('\n    ')}`); }
  log(failed ? 'FAIL' : 'PASS: every move played on the real stream and the picture was there after each');
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
