// Regenerates the three PNGs the Glass review scene serves. They are committed,
// so the review harness never needs to run this; it exists so the pictures are
// reproducible rather than mysterious. Run from client/:
//   node e2e/fixtures/glass/generate-images.mjs
// The drawing happens in headless Chromium (canvas 2D), so no native image
// dependency is needed. Nothing here is photographic: flat shapes and type.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage();
const draw = (name, width, height, painter) =>
  page.evaluate(
    ([source, w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      new Function('ctx', 'w', 'h', source)(canvas.getContext('2d'), w, h);
      return canvas.toDataURL('image/png');
    },
    [painter, width, height],
  ).then((url) => writeFile(path.join(HERE, name), Buffer.from(url.split(',')[1], 'base64')));

// The Nick "MISSION COMPLETE 41:07" screen: dark cave, amber and teal bars.
await draw('mission-41-07.png', 480, 270, `
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#2a1d12'); g.addColorStop(0.55, '#101a1c'); g.addColorStop(1, '#070b0c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0a1214'; ctx.beginPath(); ctx.moveTo(0, h);
  for (let i = 0; i <= 12; i++) ctx.lineTo(i * w / 12, h * (0.78 - 0.1 * Math.abs(Math.sin(i * 1.7))));
  ctx.lineTo(w, h); ctx.fill();
  ctx.fillStyle = '#c9d2cf'; ctx.font = '600 10px monospace';
  ctx.fillText('M I S S I O N   C O M P L E T E', 34, 44);
  ctx.fillStyle = '#f3ead8'; ctx.font = '700 84px sans-serif'; ctx.fillText('41:07', 30, 128);
  ctx.fillStyle = '#f0b967'; ctx.fillRect(270, 52, 130, 6);
  ctx.fillStyle = '#2bd39a'; ctx.fillRect(270, 68, 100, 6);
  ctx.fillStyle = '#7f8b88'; ctx.font = '500 9px monospace';
  ctx.fillText('HAZARD 5  ·  0 DOWNS  ·  4/4 EXTRACTED', 34, 150);
`);

// Basecamp's server banner: layered ridges at dawn.
await draw('basecamp-banner.png', 1200, 400, `
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#20313f'); sky.addColorStop(0.7, '#8a6f58'); sky.addColorStop(1, '#c79a6b');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  const ridge = (base, amp, seed, color) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i <= 40; i++) ctx.lineTo(i * w / 40, h * base - amp * Math.abs(Math.sin(i * seed + seed)));
    ctx.lineTo(w, h); ctx.fill();
  };
  ridge(0.62, 90, 0.9, '#55606a'); ridge(0.74, 70, 1.4, '#34434b'); ridge(0.86, 50, 2.1, '#1a2529');
`);

// One photo for the Photos channel: a trail at first light.
await draw('photo-ridge.png', 640, 400, `
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#3b4f66'); sky.addColorStop(1, '#e0a874');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#26303a'; ctx.beginPath(); ctx.moveTo(0, h);
  for (let i = 0; i <= 16; i++) ctx.lineTo(i * w / 16, h * 0.55 + 60 * Math.sin(i * 1.3));
  ctx.lineTo(w, h); ctx.fill();
  ctx.fillStyle = '#12181e'; ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, h * 0.85);
  ctx.quadraticCurveTo(w * 0.5, h * 0.62, w, h * 0.9); ctx.lineTo(w, h); ctx.fill();
`);

await browser.close();
