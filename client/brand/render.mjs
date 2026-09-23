#!/usr/bin/env node
// Regenerates every Paracord brand asset from the procedural drawing in mark.html.
// See README.md in this folder. Run from anywhere:
//
//   node client/brand/render.mjs            masters, then every derived asset
//   node client/brand/render.mjs masters    only the 2048 px masters (client/brand/out/)
//   node client/brand/render.mjs derive     only the derived assets, from existing masters
//
// Needs Playwright's Chromium (a client devDependency) and ImageMagick 7 (`magick`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..');
const ROOT = join(CLIENT, '..');
const OUT = join(HERE, 'out');
const require = createRequire(join(CLIENT, 'package.json'));
/**
 * The ground behind every full-bleed icon (maskable, Apple touch, Android and
 * iOS): the middle tone of the tile's own Slate gradient, so a platform that
 * crops the tile to its own shape shows the same ground.
 */
const SLATE = '#0e1216';

/** Every master: a name and the mark.html params that draw it. */
const MASTERS = {
  icon: 'bg=1', // the app icon: lantern and cord on the Slate tile
  'icon-small': 'bg=1&small=1', // the same, simplified for 16-48 px
  free: 'bg=0', // lantern and cord, no tile
  bare: 'bg=0&ground=0', // in-app mark: no tile, no floor shadow
  'bare-small': 'bg=0&ground=0&small=1', // the same, simplified
  lantern: 'bg=0&cord=0', // loading screen: the lit lantern
  'lantern-dim': 'bg=0&cord=0&lit=0', // loading screen: the unlit silhouette
  cord: 'bg=0&lantern=0', // loading screen: the cord that draws itself on
};

async function renderMasters() {
  const { chromium } = require('playwright');
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2048, height: 2048 } });
  for (const [name, params] of Object.entries(MASTERS)) {
    await page.goto(`file://${join(HERE, 'mark.html')}?${params}#${params}`);
    await page.waitForFunction(() => window.DONE === true);
    await page.locator('#c').screenshot({ path: join(OUT, `${name}.png`), omitBackground: true });
    console.log(`master ${name}.png`);
  }
  await browser.close();
}

async function renderBanner() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1600 }, deviceScaleFactor: 2 });
  for (const [name, params] of Object.entries(BANNERS)) {
    await page.goto(`file://${join(HERE, 'banner.html')}?${params}#${params}`);
    await page.waitForFunction(() => window.DONE === true);
    await page.locator('#art').screenshot({ path: join(OUT, `${name}.png`), omitBackground: true });
    console.log(`banner ${name}.png`);
  }
  await browser.close();
}

/** banner.html views: the README banner in two grounds, and the bare wordmark. */
const BANNERS = {
  banner: 'view=banner',
  'banner-light': 'view=banner&ground=light',
  wordmark: 'view=wordmark',
};

const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });
const master = (name) => join(OUT, `${name}.png`);
/** Lanczos down to `size` square, as PNG or WebP by extension. */
function resize(name, size, dest, extra = []) {
  mkdirSync(dirname(dest), { recursive: true });
  magick(master(name), '-filter', 'Lanczos', '-resize', `${size}x${size}`, ...extra, dest);
}
const kb = (path) => `${(statSync(path).size / 1024).toFixed(1)} KB`;

function derive() {
  const pub = join(CLIENT, 'public');
  // The icon master is 2048; Tauri's generator wants a square source of 1024+.
  const icon1024 = join(OUT, 'icon-1024.png');
  resize('icon', 1024, icon1024);
  const free1024 = join(OUT, 'free-1024.png');
  resize('free', 1024, free1024);
  // Desktop and mobile icons: every file under src-tauri/icons. iOS icons may
  // not be transparent, so the tile's corners are filled with the Slate ground
  // (iOS masks them off anyway); Android's adaptive icon gets the bare drawing as
  // its foreground, scaled into the launcher's circular safe zone, over Slate.
  const manifest = join(OUT, 'tauri-icon.json');
  writeFileSync(manifest, JSON.stringify({
    default: 'icon-1024.png',
    bg_color: SLATE,
    android_fg: 'free-1024.png',
    android_fg_scale: 80,
  }));
  execFileSync('npx', ['tauri', 'icon', manifest, '-o', join(CLIENT, 'src-tauri', 'icons')], {
    cwd: CLIENT,
    stdio: 'inherit',
  });
  // Tauri draws the smallest desktop sizes from the detailed master; the
  // simplified drawing reads better there.
  const icons = join(CLIENT, 'src-tauri', 'icons');
  resize('icon-small', 32, join(icons, '32x32.png'));
  resize('icon-small', 30, join(icons, 'Square30x30Logo.png'));
  resize('icon-small', 44, join(icons, 'Square44x44Logo.png'));
  const icoParts = [16, 24, 32, 48].map((s) => {
    const p = join(OUT, `ico-${s}.png`);
    resize('icon-small', s, p);
    return p;
  });
  for (const s of [64, 128, 256]) {
    const p = join(OUT, `ico-${s}.png`);
    resize('icon', s, p);
    icoParts.push(p);
  }
  magick(...icoParts, join(icons, 'icon.ico'));

  // Web: favicon, PWA and Apple touch icons.
  magick(...icoParts.slice(0, 4), join(pub, 'favicon.ico'));
  resize('icon-small', 64, join(pub, 'pwa-64x64.png'));
  resize('icon', 192, join(pub, 'pwa-192x192.png'));
  resize('icon', 512, join(pub, 'pwa-512x512.png'));
  // Apple draws its own rounded corners over a full-bleed square, so the touch
  // icon is the drawing on a square Slate field rather than on the rounded tile.
  magick(master('free'), '-resize', '1640x1640', '-background', SLATE, '-gravity', 'center',
    '-extent', '2048x2048', '-filter', 'Lanczos', '-resize', '180x180', join(pub, 'apple-touch-icon-180x180.png'));
  // Maskable: the platform crops to a circle of 80% diameter, so the drawing
  // sits inside that safe zone on a full-bleed Slate square.
  magick(master('free'), '-resize', '1480x1480', '-background', SLATE, '-gravity', 'center',
    '-extent', '2048x2048', '-filter', 'Lanczos', '-resize', '512x512', join(pub, 'maskable-icon-512x512.png'));

  // In-app mark (AppMark) and the loading screen, at display size x2 (the
  // loading screen's art is at most 320 px, see client/index.html).
  const brand = join(pub, 'brand');
  const webp = ['-quality', '88', '-define', 'webp:alpha-quality=90', '-define', 'webp:method=6'];
  // Inside the app the mark is the bare drawing, trimmed to the lantern and
  // cord, `size` px tall: the Slate tile is the OS icon's ground, and on the
  // app's own dark surfaces it only made the lantern smaller.
  const bare = (name, size, dest) => {
    // The bounding box of everything drawn, the cord's soft drop shadow included.
    const box = execFileSync('magick', [master(name), '-alpha', 'extract', '-threshold', '2%', '-format', '%@', 'info:'])
      .toString().trim();
    magick(master(name), '-crop', box, '+repage', '-filter', 'Lanczos', '-resize', `x${size}`, ...webp, dest);
  };
  bare('bare', 128, join(brand, 'mark-64.webp')); // AppMark from 33 to 64 px tall
  bare('bare-small', 64, join(brand, 'mark-small-32.webp')); // AppMark 32 px tall and below
  resize('lantern', 640, join(brand, 'splash-lantern.webp'), webp);
  resize('lantern-dim', 640, join(brand, 'splash-lantern-dim.webp'), ['-quality', '70', ...webp.slice(2)]);
  resize('cord', 640, join(brand, 'splash-cord.webp'), webp);
  // Trimmed to the letters, so its CSS height is the cap-to-baseline height.
  magick(master('wordmark'), '-trim', '+repage', '-filter', 'Lanczos', '-resize', 'x96', ...webp, join(brand, 'wordmark.webp'));
  for (const f of ['mark-64', 'mark-small-32', 'splash-lantern', 'splash-lantern-dim', 'splash-cord', 'wordmark']) {
    console.log(`public/brand/${f}.webp ${kb(join(brand, `${f}.webp`))}`);
  }

  // Docs: README banner and a plain 512 mark.
  const docs = join(ROOT, 'docs', 'images', 'brand');
  mkdirSync(docs, { recursive: true });
  resize('icon', 512, join(docs, 'mark-512.png'));
  magick(master('banner'), '-filter', 'Lanczos', '-resize', '1280x', join(docs, 'banner.png'));
  magick(master('banner-light'), '-filter', 'Lanczos', '-resize', '1280x', join(docs, 'banner-light.png'));
}

const stage = process.argv[2] ?? 'all';
if (stage === 'all' || stage === 'masters') {
  await renderMasters();
  await renderBanner();
}
if (stage === 'all' || stage === 'derive') derive();
