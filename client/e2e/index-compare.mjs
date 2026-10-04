/**
 * Holds a package's shots against the references (docs/design/index-plan.md §3).
 *
 *   cd client
 *   node e2e/index-compare.mjs <folder> [--only s0-quiet,s5-busy] [--max 4.5] [--quiet]
 *
 * <folder> is a package label (`ix5` → output/design-reference/index-build/ix5/),
 * a path to a folder of PNGs, or `ref` to run the references against themselves
 * (the check that the tool itself reports 0).
 *
 * For every `<state>.png` in the folder that has a `ref/<state>.png` (the 1280x800
 * reference renders from `node e2e/index-reference.mjs`), it writes into
 * `<folder>/compare/`:
 *
 *   <state>.png        reference on the left, the shot on the right, labeled
 *   <state>.diff.png   the per-pixel difference, amplified 4x (black = identical)
 *
 * and prints the mean per-pixel difference (mean of |a-b| over every pixel and
 * RGB channel, as a percent of full scale) and the share of pixels that differ by
 * more than 3% on any channel. A summary goes to `compare/summary.json`. Files
 * with an `@<w>x<h>` suffix are other viewport sizes and have no reference: they
 * are skipped. A pair whose sizes differ is reported and drawn side by side, with
 * no difference.
 *
 * The images are composed in a Playwright page canvas (no new dependency). The
 * number is a guide: READ the side-by-side image; a hue or a font weight can
 * be a small number and an obvious miss, and a one-line preview difference can
 * be a large one and no miss at all.
 *
 * --max <pct>  exit 1 if any pair's mean difference is above it
 * --only a,b   only these states
 * --quiet      no per-state lines, just the verdict
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REF_DIR = join(ROOT, 'output', 'design-reference', 'index', 'ref');
const BUILD_DIR = join(ROOT, 'output', 'design-reference', 'index-build');
/** A pixel counts as changed when any channel differs by more than this fraction of full scale. */
const CHANGED = 0.03;

function parseArgs(argv) {
  const args = { folder: null, only: null, max: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') args.only = argv[++i].split(',').filter(Boolean);
    else if (arg === '--max') args.max = Number(argv[++i]);
    else if (arg === '--quiet') args.quiet = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!args.folder) args.folder = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (!args.folder || (args.max !== null && !Number.isFinite(args.max))) {
    console.error('Usage: node e2e/index-compare.mjs <folder|ref> [--only a,b] [--max <pct>] [--quiet]');
    process.exit(2);
  }
  return args;
}

/** `ref` compares the references with themselves; anything else is a label or a path. */
function resolveFolder(name) {
  if (name === 'ref') return { dir: REF_DIR, out: join(BUILD_DIR, '_ref-self', 'compare'), self: true };
  const asPath = resolve(process.cwd(), name);
  const dir = existsSync(join(BUILD_DIR, name)) ? join(BUILD_DIR, name) : asPath;
  if (!existsSync(dir)) throw new Error(`No folder "${name}" (looked in ${join(BUILD_DIR, name)} and ${asPath})`);
  return { dir, out: join(dir, 'compare'), self: false };
}

const args = parseArgs(process.argv.slice(2));
const { dir, out, self } = resolveFolder(args.folder);
if (!existsSync(REF_DIR)) throw new Error(`No references in ${REF_DIR}: run node e2e/index-reference.mjs first`);

const states = readdirSync(dir)
  .filter((f) => f.endsWith('.png') && !f.includes('@') && !f.endsWith('.diff.png'))
  .map((f) => basename(f, '.png'))
  .filter((state) => existsSync(join(REF_DIR, `${state}.png`)))
  .filter((state) => !args.only || args.only.includes(state))
  .sort();
if (states.length === 0) {
  console.error(`Nothing to compare in ${dir}: no <state>.png with a reference of the same name in ${REF_DIR}`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');

/** Composes one pair in the page: returns the numbers and both PNGs as base64. */
async function compose(label, refB64, shotB64) {
  return page.evaluate(
    async ({ label, refB64, shotB64, changedAt }) => {
      const load = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      };
      const [a, b] = await Promise.all([load(refB64), load(shotB64)]);
      const canvasOf = (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      };
      const pixels = (img) => {
        const c = canvasOf(img.width, img.height);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      };
      const same = a.width === b.width && a.height === b.height;
      let mean = null;
      let changed = null;
      let diffUrl = null;
      if (same) {
        const pa = pixels(a).data;
        const pb = pixels(b).data;
        const diff = new ImageData(a.width, a.height);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < pa.length; i += 4) {
          let worst = 0;
          for (let k = 0; k < 3; k += 1) {
            const d = Math.abs(pa[i + k] - pb[i + k]);
            sum += d;
            if (d > worst) worst = d;
            diff.data[i + k] = Math.min(255, d * 4);
          }
          diff.data[i + 3] = 255;
          if (worst / 255 > changedAt) count += 1;
        }
        mean = (sum / (a.width * a.height * 3) / 255) * 100;
        changed = (count / (a.width * a.height)) * 100;
        const dc = canvasOf(a.width, a.height);
        dc.getContext('2d').putImageData(diff, 0, 0);
        diffUrl = dc.toDataURL('image/png');
      }
      // Side by side: reference | shot, each under a caption.
      const gutter = 16;
      const head = 34;
      const width = a.width + gutter + b.width;
      const height = head + Math.max(a.height, b.height);
      const sheet = canvasOf(width, height);
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#17181b';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(a, 0, head);
      ctx.drawImage(b, a.width + gutter, head);
      ctx.fillStyle = '#e8e8ea';
      ctx.font = '600 18px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`reference   ${label}`, 10, head / 2);
      const verdict = mean === null ? 'size differs' : `mean difference ${mean.toFixed(2)}%   changed pixels ${changed.toFixed(1)}%`;
      ctx.fillText(`shot   ${verdict}`, a.width + gutter + 10, head / 2);
      return { mean, changed, same, ref: [a.width, a.height], shot: [b.width, b.height], sheetUrl: sheet.toDataURL('image/png'), diffUrl };
    },
    { label, refB64, shotB64, changedAt: CHANGED },
  );
}

const results = [];
for (const state of states) {
  const refB64 = readFileSync(join(REF_DIR, `${state}.png`)).toString('base64');
  const shotB64 = readFileSync(join(dir, `${state}.png`)).toString('base64');
  const r = await compose(state, refB64, shotB64);
  writeFileSync(join(out, `${state}.png`), Buffer.from(r.sheetUrl.split(',')[1], 'base64'));
  if (r.diffUrl) writeFileSync(join(out, `${state}.diff.png`), Buffer.from(r.diffUrl.split(',')[1], 'base64'));
  results.push({ state, mean: r.mean, changed: r.changed, sizeMatches: r.same, ref: r.ref, shot: r.shot });
}
await browser.close();

writeFileSync(join(out, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);

if (!args.quiet) {
  console.log(`${self ? 'ref against itself' : dir}  →  ${out}`);
  for (const r of results) {
    const line = r.sizeMatches
      ? `  ${r.state.padEnd(24)} mean ${r.mean.toFixed(2).padStart(6)}%   changed ${r.changed.toFixed(1).padStart(5)}%`
      : `  ${r.state.padEnd(24)} SIZE ${r.shot.join('x')} vs reference ${r.ref.join('x')}`;
    console.log(line);
  }
}
const worst = Math.max(...results.map((r) => (r.mean === null ? Infinity : r.mean)));
const mismatched = results.filter((r) => !r.sizeMatches);
if (mismatched.length > 0) console.log(`${mismatched.length} pair(s) with a different size: no difference computed`);
if (args.max !== null && worst > args.max) {
  console.log(`FAIL: worst mean difference ${worst.toFixed(2)}% is above --max ${args.max}%`);
  process.exit(1);
}
console.log(`${results.length} state(s) compared; worst mean difference ${Number.isFinite(worst) ? `${worst.toFixed(2)}%` : 'n/a'}`);
