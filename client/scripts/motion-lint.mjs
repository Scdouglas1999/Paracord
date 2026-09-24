#!/usr/bin/env node
/**
 * The motion lint (docs/lantern-stage-spec.md §5.2 — the motion law).
 *
 * "Only `transform` and `opacity` animate." A transition or a keyframe that
 * moves `box-shadow`, `width`, `height`, `filter`, `top` or `left` repaints (or
 * re-lays-out) its element on every frame; on the Linux desktop webview one
 * animated shadow once held the app at ~1.8 CPU cores. This lint keeps the rule
 * from coming back one component at a time. It reads, across client/src
 * (tests excluded):
 *
 *   - CSS `transition` / `transition-property` values, and every declaration
 *     inside an `@keyframes` block;
 *   - Tailwind classes: `transition-all`, `transition-shadow`, and any
 *     `transition-[…]` that names a forbidden property;
 *   - inline style strings (`transition: '…'`, `style.transition = …`);
 *   - Web Animations keyframes inside `.animate(…)` calls.
 *
 * `transition: all` (and Tailwind's `transition-all`) counts, because `all`
 * includes every one of them. Color transitions are fine.
 *
 * It also holds the one reduced-motion switch (§5.3): no `prefers-reduced-motion`
 * media query and no Tailwind `motion-safe:`/`motion-reduce:` variant anywhere —
 * `lib/motion/reducedMotion.ts` folds the OS setting with the user's own
 * choice and publishes `data-motion` on <html>; a media query would be a
 * second source of truth that "Full motion" could not override.
 *
 * A few places are allowed one, each named below with the reason it cannot be
 * transform/opacity. An allowance that no longer matches anything fails the
 * run too, so the list cannot rot.
 *
 * Run: `npm run test:motion-lint` (also part of `npm test`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');

/** The properties that may never animate. */
const FORBIDDEN = ['box-shadow', 'width', 'height', 'filter', 'backdrop-filter', 'top', 'left', 'all'];
const FORBIDDEN_JS = ['boxShadow', 'width', 'height', 'filter', 'backdropFilter', 'top', 'left'];

/**
 * Allowed findings: [file, a substring of the offending text, reason].
 * Keep each one narrow — a substring of the declaration, not the whole file.
 */
const ALLOWED = [
  [
    'styles/daily-word.css',
    'box-shadow: inset 0 0 0 2px var(--word-tile-edge-filled)',
    'the Daily word tile flip swaps the tile edge for the fill at the 49%/50% '
      + 'edge-on instant — a discrete swap hidden by scaleY(0.05), never an '
      + 'interpolated shadow',
  ],
  [
    'styles/daily-word.css',
    'box-shadow: none',
    'the other half of the same edge-on swap in the tile flip',
  ],
  [
    'styles/server-home.css',
    'transition: filter var(--duration-dim)',
    'the speaking glow on a live card fades out through `filter: opacity()` on '
      + 'its own composited glow layer — a one-off fade when the talking stops, '
      + 'kept by decision of the speaking-signal work (server-home-spec)',
  ],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.(css|tsx?|mjs)$/.test(name)) continue;
    if (/\.test\.|\.spec\.|__tests__|\.d\.ts$/.test(full)) continue;
    out.push(full);
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Forbidden property names in a CSS transition value. */
function forbiddenInTransition(value) {
  if (/^\s*none\s*(!important)?\s*$/.test(value)) return [];
  const hits = [];
  for (const part of value.split(',')) {
    const first = part.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (FORBIDDEN.includes(first)) hits.push(first);
  }
  return hits;
}

function strip(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lintCss(file, raw) {
  const findings = [];
  const css = strip(raw);
  for (const m of css.matchAll(/@media[^{]*prefers-reduced-motion[^{]*\{/g)) {
    findings.push({ line: lineOf(css, m.index), text: m[0], why: 'a prefers-reduced-motion media query — use :root[data-motion=\'reduced\']' });
  }
  // Transitions.
  const decl = /(?:^|[;{\s])(transition(?:-property)?)\s*:\s*([^;}]+)/g;
  for (const m of css.matchAll(decl)) {
    for (const hit of forbiddenInTransition(m[2])) {
      findings.push({ line: lineOf(css, m.index), text: `${m[1]}: ${m[2].trim()}`, why: `transitions ${hit}` });
    }
  }
  // Keyframes.
  const kf = /@keyframes\s+([\w-]+)\s*\{/g;
  for (const m of css.matchAll(kf)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    const body = css.slice(start, i - 1);
    const prop = /(?:^|[;{\s])([a-z-]+)\s*:\s*([^;}]+)/g;
    for (const d of body.matchAll(prop)) {
      if (FORBIDDEN.includes(d[1]) && d[1] !== 'all') {
        findings.push({
          line: lineOf(css, start + d.index),
          text: `${d[1]}: ${d[2].trim()}`,
          why: `@keyframes ${m[1]} animates ${d[1]}`,
        });
      }
    }
  }
  return findings;
}

function lintScript(file, src) {
  const findings = [];
  for (const m of src.matchAll(/\bmotion-(safe|reduce):/g)) {
    findings.push({ line: lineOf(src, m.index), text: m[0], why: `Tailwind's ${m[0]} is a prefers-reduced-motion media query — the switch is data-motion` });
  }
  if (file !== 'lib/motion/reducedMotion.ts') {
    for (const m of src.matchAll(/matchMedia\(\s*['"`]\(prefers-reduced-motion/g)) {
      findings.push({ line: lineOf(src, m.index), text: m[0], why: 'reads the OS setting directly — use useReducedMotion()/prefersReducedMotion()' });
    }
  }
  // Tailwind utilities.
  for (const m of src.matchAll(/\btransition-(all|shadow)\b/g)) {
    findings.push({ line: lineOf(src, m.index), text: m[0], why: `transitions ${m[1] === 'shadow' ? 'box-shadow' : 'all'}` });
  }
  for (const m of src.matchAll(/\btransition-\[([^\]]+)\]/g)) {
    for (const prop of m[1].split(',')) {
      const p = prop.trim().split(/[\s_]/)[0];
      if (FORBIDDEN.includes(p)) findings.push({ line: lineOf(src, m.index), text: m[0], why: `transitions ${p}` });
    }
  }
  // Inline transition strings.
  const inline = /(?:\btransition\s*:\s*|\.style\.transition\s*=\s*)(['"`])([^'"`]*)\1/g;
  for (const m of src.matchAll(inline)) {
    const value = m[2].replace(/\$\{[^}]*\}/g, '0ms');
    for (const hit of forbiddenInTransition(value)) {
      findings.push({ line: lineOf(src, m.index), text: m[0], why: `transitions ${hit}` });
    }
  }
  // Web Animations keyframes: the argument list of every `.animate(`.
  for (const m of src.matchAll(/\.animate\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      i += 1;
    }
    const args = src.slice(start, i - 1);
    // Only the keyframes argument: everything before the options object's
    // `duration`/`easing`, which is where timing (never a property) lives.
    for (const key of FORBIDDEN_JS) {
      const re = new RegExp(`[{,\\s]${key}\\s*:`, 'g');
      for (const k of args.matchAll(re)) {
        findings.push({ line: lineOf(src, start + k.index), text: `.animate(… ${key}: …)`, why: `Web Animations keyframe animates ${key}` });
      }
    }
  }
  return findings;
}

const failures = [];
const used = new Set();
let scanned = 0;
for (const full of walk(SRC)) {
  const file = relative(SRC, full).split(sep).join('/');
  const text = readFileSync(full, 'utf8');
  scanned += 1;
  const found = file.endsWith('.css') ? lintCss(file, text) : lintScript(file, text);
  for (const f of found) {
    const allowance = ALLOWED.findIndex(([f2, needle]) => f2 === file && f.text.includes(needle));
    if (allowance >= 0) {
      used.add(allowance);
      continue;
    }
    failures.push(`${file}:${f.line}  ${f.why}\n    ${f.text.slice(0, 160)}`);
  }
}

const stale = ALLOWED.filter((_, i) => !used.has(i)).map(([file, needle]) => `${file} — "${needle}"`);

if (failures.length || stale.length) {
  if (failures.length) {
    console.error(`Motion lint: ${failures.length} animation(s) of a property that may not animate (only transform and opacity may):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error('\nUse a still layer whose opacity crossfades, or a transform. docs/lantern-stage-spec.md §5.2.');
  }
  if (stale.length) {
    console.error(`\nMotion lint: allowances that no longer match anything — remove them:\n  ${stale.join('\n  ')}`);
  }
  process.exit(1);
}
console.log(`Motion lint passed: ${scanned} files animate only transform and opacity (${ALLOWED.length} named allowances, each with its reason).`);
