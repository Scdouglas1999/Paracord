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

// The three server icons of the places panel's server row (80px, shown at 40).
await draw('icon-game-night.png', 80, 80, `
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#3b3f46'); g.addColorStop(1, '#1c1e22');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#f1e9dc'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.roundRect(18, 28, 44, 26, 13); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(30, 35.6); ctx.lineTo(30, 46.4); ctx.moveTo(24.6, 41); ctx.lineTo(35.4, 41); ctx.stroke();
  ctx.fillStyle = '#ffc27e'; ctx.beginPath(); ctx.arc(50, 38.4, 2.6, 0, 7); ctx.fill();
  ctx.fillStyle = '#f1e9dc'; ctx.beginPath(); ctx.arc(54.8, 43.6, 2.6, 0, 7); ctx.fill();
`);
await draw('icon-basecamp.png', 80, 80, `
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#4a5a66'); g.addColorStop(1, '#27313a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(233,228,216,0.85)'; ctx.beginPath(); ctx.arc(56, 22, 6, 0, 7); ctx.fill();
  ctx.fillStyle = '#1b2228'; ctx.beginPath(); ctx.moveTo(0, 62); ctx.lineTo(22, 32); ctx.lineTo(34, 46);
  ctx.lineTo(44, 34); ctx.lineTo(80, 62); ctx.lineTo(80, 80); ctx.lineTo(0, 80); ctx.fill();
  ctx.fillStyle = 'rgba(223,230,234,0.8)'; ctx.beginPath(); ctx.moveTo(22, 32); ctx.lineTo(28, 39); ctx.lineTo(22, 38); ctx.lineTo(18, 41); ctx.fill();
`);
await draw('icon-sunday-league.png', 80, 80, `
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#3d4b41'); g.addColorStop(1, '#222b25');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(232,239,233,0.22)'; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(0, 52); ctx.lineTo(80, 52); ctx.moveTo(40, 52); ctx.lineTo(40, 80); ctx.stroke();
  ctx.fillStyle = '#eef1ec'; ctx.beginPath(); ctx.arc(40, 34, 14, 0, 7); ctx.fill();
  ctx.fillStyle = '#27302a'; ctx.beginPath(); ctx.moveTo(40, 26.4); ctx.lineTo(46.6, 31.2);
  ctx.lineTo(44, 39); ctx.lineTo(36, 39); ctx.lineTo(33.4, 31.2); ctx.fill();
`);

await browser.close();
