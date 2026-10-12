#!/usr/bin/env node
// Regenerates every Paracord brand asset from the procedural drawing in mark.html.
// See README.md in this folder. Run from anywhere:
//
//   node client/brand/render.mjs            everything below, in order
//   node client/brand/render.mjs masters    the SVG art and the 2048 px PNG masters (client/brand/out/)
//   node client/brand/render.mjs derive     the derived icons, from existing masters
//   node client/brand/render.mjs code       CordMark's geometry and CSS, and the loading screen in index.html
//   node client/brand/render.mjs readme     the README's animated mark (docs/images/brand/paracord.webp)
//
// Needs Playwright's Chromium (a client devDependency) and ImageMagick 7 (`magick`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIGHLIGHT, TIMING, bootSplashCss, cordMarkCss, highlightDash } from './motion.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..');
const ROOT = join(CLIENT, '..');
const OUT = join(HERE, 'out');
const PUB = join(CLIENT, 'public');
const BRAND = join(PUB, 'brand');
const COMPONENT = join(CLIENT, 'src', 'components', 'brand');
const require = createRequire(join(CLIENT, 'package.json'));
const MASTER_PX = 2048;

/**
 * Every PNG master: a name and how mark.html draws it. Tiles are the app icon
 * (rounded, or square for platforms that cut their own shape); `free` is the
 * bare mark on transparency.
 */
const MASTERS = {
  'icon-full': (M) => M.tile('full'), // the app icon, 64 px and up
  'icon-mid': (M) => M.tile('mid'), // 24-48 px: a coarser braid, a little larger
  'icon-flat': (M) => M.tile('flat'), // 16-20 px: plain cord, fused ends, the gap
  // Apple touch: Apple rounds its own corners over a full-bleed square.
  'square-full': (M) => M.tile('full', { square: true }),
  // Maskable: the platform crops to a circle of 80% diameter, so the mark's
  // box sits inside it (its corners are empty; the drawing stays in the circle).
  'maskable-full': (M) => M.tile('full', { square: true, fill: 0.56 }),
  'free-full': (M) => M.free('full'), // the bare mark (Android foreground, banner)
  'free-mid': (M) => M.free('mid'),
  'free-flat': (M) => M.free('flat'), // the favicon
  'free-mono': (M) => M.free('mono'), // single-color, for trays
};

/** The in-app art CordMark and the loading screen draw. */
const ART = [
  ['cord-full', 'full', 'whole'],
  ['cord-full-under', 'full', 'under'],
  ['cord-mid', 'mid', 'whole'],
  ['cord-mid-under', 'mid', 'under'],
  ['cord-flat', 'flat', 'whole'],
  ['cord-flat-under', 'flat', 'under'],
  ['cord-mono', 'mono', 'whole'],
];

async function withMark(fn) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: MASTER_PX, height: MASTER_PX } });
    await page.goto(`file://${join(HERE, 'mark.html')}`);
    await page.waitForFunction(() => window.DONE === true);
    return await fn(page, browser);
  } finally {
    await browser.close();
  }
}

const geometry = (page) => page.evaluate(() => window.PCMark.GEO);

async function renderMasters() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(BRAND, { recursive: true });
  await withMark(async (page) => {
    for (const [name, level, part] of ART) {
      const svg = await page.evaluate(([l, p]) => window.PCMark.art(l, p), [level, part]);
      writeFileSync(join(BRAND, `${name}.svg`), `${svg}\n`);
      console.log(`public/brand/${name}.svg ${kb(join(BRAND, `${name}.svg`))}`);
    }
    for (const [name, make] of Object.entries(MASTERS)) {
      const svg = await page.evaluate(`(${make.toString()})(window.PCMark)`);
      writeFileSync(join(OUT, `${name}.svg`), svg);
      await rasterize(page, svg, join(OUT, `${name}.png`), MASTER_PX);
      console.log(`master ${name}.png`);
    }
  });
  await renderBanner();
}

/** Draw one SVG document to a transparent PNG of `px` square. */
async function rasterize(page, svg, dest, px) {
  const sized = svg.replace('<svg ', `<svg width="${px}" height="${px}" `);
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${sized}</body>`);
  await page.screenshot({ path: dest, omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
}

/** banner.html views: the README banner in two grounds, and the bare wordmark. */
const BANNERS = {
  banner: 'view=banner',
  'banner-light': 'view=banner&ground=light',
  wordmark: 'view=wordmark',
};

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

const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });
const master = (name) => join(OUT, `${name}.png`);
/** Lanczos down to `size` square, as PNG or WebP by extension. */
function resize(name, size, dest, extra = []) {
  mkdirSync(dirname(dest), { recursive: true });
  magick(master(name), '-filter', 'Lanczos', '-resize', `${size}x${size}`, ...extra, dest);
}
const kb = (path) => `${(statSync(path).size / 1024).toFixed(1)} KB`;
/** The level of detail for a raster of `px`: the same rule as CordMark. */
const levelFor = (px) => (px >= 64 ? 'full' : px >= 24 ? 'mid' : 'flat');

function derive() {
  // The tile's ground under every full-bleed platform icon (Android adaptive
  // background, iOS corners): the middle of the tile's own gradient.
  const GROUND = '#1f1b19';
  const icon1024 = join(OUT, 'icon-1024.png');
  resize('icon-full', 1024, icon1024);
  const free1024 = join(OUT, 'free-1024.png');
  resize('free-full', 1024, free1024);
  // Desktop and mobile icons: every file under src-tauri/icons. iOS icons may
  // not be transparent, so the tile's corners are filled with the ground (iOS
  // masks them off anyway); Android's adaptive icon gets the bare mark as its
  // foreground, scaled into the launcher's circular safe zone.
  const manifest = join(OUT, 'tauri-icon.json');
  writeFileSync(manifest, JSON.stringify({
    default: 'icon-1024.png',
    bg_color: GROUND,
    android_fg: 'free-1024.png',
    android_fg_scale: 70,
  }));
  execFileSync('npx', ['tauri', 'icon', manifest, '-o', join(CLIENT, 'src-tauri', 'icons')], {
    cwd: CLIENT,
    stdio: 'inherit',
  });
  // Tauri draws every size from the detailed master; below 64 px the coarser
  // drawings read better.
  const icons = join(CLIENT, 'src-tauri', 'icons');
  for (const [file, px] of [['32x32.png', 32], ['Square30x30Logo.png', 30], ['Square44x44Logo.png', 44]]) {
    resize(`icon-${levelFor(px)}`, px, join(icons, file));
  }
  const icoParts = [16, 24, 32, 48, 64, 128, 256].map((s) => {
    const p = join(OUT, `ico-${s}.png`);
    resize(`icon-${levelFor(s)}`, s, p);
    return p;
  });
  magick(...icoParts, join(icons, 'icon.ico'));
  // The tray: the flat mark in one light color. The tray itself still shows the
  // window icon (src-tauri/src/tray.rs); this is the asset for platforms that
  // want a monochrome one.
  resize('free-mono', 64, join(icons, 'tray-mono-64.png'));

  // Web: the favicon is the bare mark, as a browser tab shows it; the PWA and
  // Apple icons are the tile.
  const favParts = [16, 24, 32, 48].map((s) => {
    const p = join(OUT, `fav-${s}.png`);
    resize(`free-${s === 48 ? 'mid' : 'flat'}`, s, p);
    return p;
  });
  magick(...favParts, join(PUB, 'favicon.ico'));
  resize('icon-full', 64, join(PUB, 'pwa-64x64.png'));
  resize('icon-full', 192, join(PUB, 'pwa-192x192.png'));
  resize('icon-full', 512, join(PUB, 'pwa-512x512.png'));
  resize('square-full', 180, join(PUB, 'apple-touch-icon-180x180.png'));
  resize('maskable-full', 512, join(PUB, 'maskable-icon-512x512.png'));

  // The loading screen's wordmark, trimmed to the letters so its CSS height is
  // the cap-to-baseline height.
  const webp = ['-quality', '88', '-define', 'webp:alpha-quality=90', '-define', 'webp:method=6'];
  magick(master('wordmark'), '-trim', '+repage', '-filter', 'Lanczos', '-resize', 'x96', ...webp, join(BRAND, 'wordmark.webp'));
  console.log(`public/brand/wordmark.webp ${kb(join(BRAND, 'wordmark.webp'))}`);

  // Docs: README banner and a plain 512 icon.
  const docs = join(ROOT, 'docs', 'images', 'brand');
  mkdirSync(docs, { recursive: true });
  resize('icon-full', 512, join(docs, 'mark-512.png'));
  magick(master('banner'), '-filter', 'Lanczos', '-resize', '1280x', join(docs, 'banner.png'));
  magick(master('banner-light'), '-filter', 'Lanczos', '-resize', '1280x', join(docs, 'banner-light.png'));
}

// ---------------------------------------------------------------- code
const GENERATED = '// Generated by client/brand/render.mjs from client/brand/mark.html. Do not edit by hand.';

/** The inline SVG of an animated mark: two masked halves over static art. */
export function animatedMarkup(geo, { level, idPrefix, cls, href = (name) => `/brand/${name}.svg` }) {
  const [x, y, s] = geo.viewBox;
  const w = geo.width[level], mw = +(w + 0.6).toFixed(2), hw = +(w + 2 * geo.gap[level]).toFixed(2);
  const box = `x="${x}" y="${y}" width="${s}" height="${s}"`;
  const stroke = (c, width, color) => `class="${cls}__${c}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"`;
  return `<svg class="${cls}" viewBox="${geo.viewBox.join(' ')}" aria-hidden="true" focusable="false">`
    + `<defs><mask id="${idPrefix}o" maskUnits="userSpaceOnUse" ${box}><path d="${geo.paths.over}" ${stroke('o', mw, '#fff')}/></mask>`
    + `<mask id="${idPrefix}u" maskUnits="userSpaceOnUse" ${box}><path d="${geo.paths.under}" ${stroke('u', mw, '#fff')}/>`
    + `<path d="${geo.paths.halo}" ${stroke('h', hw, '#000')}/></mask></defs>`
    + `<g mask="url(#${idPrefix}u)"><image href="${href(`cord-${level}-under`)}" ${box}/></g>`
    + `<g mask="url(#${idPrefix}o)"><image href="${href(`cord-${level}`)}" ${box}/></g></svg>`;
}

async function writeCode() {
  const geo = await withMark((page) => geometry(page));
  // CordMark's geometry.
  const ts = `${GENERATED}
// The geometry of Paracord's mark in the art's own box (see client/brand/README.md).

export const CORD_GEO = {
  viewBox: ${JSON.stringify(geo.viewBox.join(' '))},
  box: ${JSON.stringify(geo.viewBox)} as const,
  /** Centerline stretches: the stem and the bowl's first half (over), the rest (under), the stem near the crossing (halo). */
  paths: ${JSON.stringify(geo.paths, null, 2).replace(/\n/g, '\n  ')},
  /** Cord width by level of detail. */
  width: ${JSON.stringify(geo.width)},
  /** The gap on each side of the stem where the tail passes under it. */
  gap: ${JSON.stringify(geo.gap)},
  tot: ${geo.tot},
  sMid: ${geo.sMid},
} as const;

/** The working highlight's bands: dash pattern and opacity, widest first. */
export const CORD_HIGHLIGHT = {
  color: ${JSON.stringify(HIGHLIGHT.color)},
  bands: ${JSON.stringify(highlightDash(geo).map((dash, i) => ({ dash, opacity: HIGHLIGHT.bands[i].opacity })))},
} as const;

/** Durations of each motion, in ms (the keyframes are in cordMark.css). */
export const CORD_TIMING = ${JSON.stringify(TIMING)} as const;
`;
  writeFileSync(join(COMPONENT, 'cordGeometry.ts'), ts);
  console.log('src/components/brand/cordGeometry.ts');

  const css = `/* Generated by client/brand/render.mjs (motion.mjs). Do not edit by hand. */
/* CordMark's motion: only the masks' dash values move; the art is static. */
${cordMarkCss(geo)}
/* Offscreen marks hold still (CordMark sets the attribute), and a paused one
   holds its first frame. */
.pc-cord[data-offscreen] *,.pc-cord[data-paused] *{animation-play-state:paused}
/* Reduced motion: the resting style of every mask is the whole mark. */
@media (prefers-reduced-motion: reduce){.pc-cord *{animation:none!important}}
:root[data-motion='reduced'] .pc-cord *{animation:none!important}
`;
  writeFileSync(join(COMPONENT, 'cordMark.css'), css);
  console.log('src/components/brand/cordMark.css');

  // The loading screen in index.html: its mark markup and its keyframes,
  // between the markers.
  const indexPath = join(CLIENT, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  html = replaceBetween(html, '/* cord-mark:css:begin */', '/* cord-mark:css:end */', `\n${bootSplashCss(geo)}\n      `);
  html = replaceBetween(html, '<!-- cord-mark:svg:begin -->', '<!-- cord-mark:svg:end -->',
    animatedMarkup(geo, { level: 'full', idPrefix: 'pc-boot-m', cls: 'pc-boot__mark' }).replace(/pc-boot__mark__/g, 'pc-boot__'));
  writeFileSync(indexPath, html);
  console.log('index.html (loading screen mark)');
}

function replaceBetween(text, begin, end, body) {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (a < 0 || b < a) throw new Error(`index.html is missing the ${begin} … ${end} markers`);
  return text.slice(0, a + begin.length) + body + text.slice(b);
}

// ---------------------------------------------------------------- README
/**
 * The README's animated mark: banner.html's `anim` view (the mark drawing on,
 * then the wordmark), stepped frame by frame through the Web Animations API and
 * packed into an animated WebP that holds on its last frame.
 */
async function renderReadme() {
  const { chromium } = require('playwright');
  const frames = join(OUT, 'readme-frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${join(HERE, 'banner.html')}?view=anim#view=anim`);
  await page.waitForFunction(() => window.DONE === true);
  const geo = await withMark((markPage) => geometry(markPage));
  const svg = animatedMarkup(geo, {
    level: 'full', idPrefix: 'rm', cls: 'pc-boot__mark', href: (name) => `../public/brand/${name}.svg`,
  }).replace(/pc-boot__mark__/g, 'pc-boot__');
  await page.evaluate(([markup, css]) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.getElementById('mark').innerHTML = markup;
  }, [svg, bootSplashCss(geo, { delay: 80 })]);
  // Let the art images load before the first frame.
  await page.waitForTimeout(300);
  const FPS = 30, END = 1700;
  for (let t = 0, i = 0; t <= END; t += 1000 / FPS, i++) {
    await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; }), t);
    await page.locator('#art').screenshot({ path: join(frames, `f${String(i).padStart(3, '0')}.png`) });
  }
  await browser.close();
  const files = readdirSync(frames).sort().map((f) => join(frames, f));
  const docs = join(ROOT, 'docs', 'images', 'brand');
  // Each frame at the capture rate; the last one held for 4 s.
  const delays = files.flatMap((f, i) => ['-delay', i === files.length - 1 ? '400' : `${100 / FPS}`, f]);
  // Plays once and holds: loop count 1.
  magick(...delays, '-loop', '1', '-quality', '82',
    '-define', 'webp:method=6', join(docs, 'paracord.webp'));
  console.log(`docs/images/brand/paracord.webp ${kb(join(docs, 'paracord.webp'))}`);
}

const stage = process.argv[2] ?? 'all';
if (stage === 'all' || stage === 'masters') await renderMasters();
if (stage === 'all' || stage === 'derive') derive();
if (stage === 'all' || stage === 'code') await writeCode();
if (stage === 'all' || stage === 'readme') await renderReadme();
