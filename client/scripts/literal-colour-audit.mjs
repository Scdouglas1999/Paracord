#!/usr/bin/env node
/**
 * The literal-colour lint (docs/lantern-stage-spec.md §0, §1, §8).
 *
 * "Consume tokens, never hard-code hex." WP0 pinned that for the `ui/`
 * primitives with a render test that walks the DOM; this is the repo-wide
 * version, so the rule cannot come back one component at a time.
 *
 * A literal colour is a hex triplet, `rgb()`/`rgba()`, `hsl()`/`hsla()`, or a
 * CSS named colour used as a value. It is allowed in exactly two places:
 *
 *   1. `src/styles/tokens.css`, which IS the palette.
 *   2. The named exceptions below, each with the reason it cannot be a token.
 *
 * Tests, fixtures and generated API types are out of scope: a test asserting
 * that sanitisation preserves `#1a1a2e` is testing a string, not painting a
 * surface.
 *
 * Run: `npm run test:tokens`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');

/** Files that may hold a literal colour, and why no token can replace it. */
const ALLOWED = new Map([
  [
    'styles/tokens.css',
    'the palette itself — every literal in the product lives here',
  ],
  [
    'hooks/useTheme.ts',
    'ACCENT_PRESETS: the hover and active steps are computed from the picked '
      + 'value, so the numbers cannot be custom properties',
  ],
  [
    'lib/colors.ts',
    'DEFAULT_ROLE_COLOR / UNSET_ROLE_COLOR: a role colour is data sent to the '
      + 'server, not a surface this app paints',
  ],
  [
    'lib/media/video/canvasRenderer.ts',
    'canvas 2D fillStyle for the letterbox behind a video frame — a canvas '
      + 'cannot read a custom property',
  ],
  [
    'components/customization/CustomCSS.tsx',
    'the example CSS shown in the editor placeholder, which has to look like CSS',
  ],
  [
    'lib/nativeGround.ts',
    'SENTINEL: a magenta painted into a 1x1 canvas and read back to prove the '
      + 'canvas can parse a colour at all, before the real ground is offered to '
      + 'it. Its whole job is to be a colour no theme defines, so a token is '
      + 'exactly what it must not be',
  ],
]);

/** A file is skipped entirely when its path matches one of these. */
const SKIP = [
  /\.test\.[tj]sx?$/,
  /[\\/]__tests__[\\/]/,
  /[\\/]test[\\/]/,
  /[\\/]api[\\/]generated[\\/]/,
  /\.d\.ts$/,
  /\.svg$/,
];

const EXTENSIONS = ['.ts', '.tsx', '.css'];

/**
 * Colour literals. Hex needs a boundary on both sides so a snowflake, a hash
 * route or a `#{n}` template does not count; the functional notations and the
 * named colours are matched as values only (after `:` or inside a CSS function
 * argument list), which is why each pattern carries its own lead-in.
 */
const PATTERNS = [
  { name: 'hex', re: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{1}|[0-9a-fA-F]{3}|[0-9a-fA-F]{5})?\b/g },
  { name: 'rgb()', re: /\brgba?\(\s*[\d.]+[\s,]/g },
  { name: 'hsl()', re: /\bhsla?\(\s*[\d.]+[\s,]/g },
  {
    name: 'named colour',
    re: /(?:^|[:\s(,])(?:white|black|red|blue|green|yellow|orange|purple|pink|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?=\s*[;,)'"`]|$)/gm,
  },
];

/** A Tailwind utility naming a colour the theme defines is not a literal. */
const TAILWIND_COLOUR_CLASS = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|caret|accent|placeholder)-(?:white|black)\b/g;

/** Strip comments so a hex in prose is not a finding. */
function stripComments(source, isCss) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (!isCss) {
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
  }
  return out;
}

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      yield full;
    }
  }
}

const findings = [];
let scanned = 0;

for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split(sep).join('/');
  if (SKIP.some((re) => re.test(rel))) continue;
  if (ALLOWED.has(rel)) continue;
  scanned += 1;

  const isCss = rel.endsWith('.css');
  const cleaned = stripComments(readFileSync(file, 'utf8'), isCss)
    // `text-white` is a theme utility, not a literal; so is `bg-black`.
    .replace(TAILWIND_COLOUR_CLASS, (m) => ' '.repeat(m.length));

  const lines = cleaned.split('\n');
  lines.forEach((line, index) => {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        findings.push({ rel, line: index + 1, kind: name, text: match[0].trim() });
      }
    }
  });
}

if (findings.length > 0) {
  console.error('Literal colours outside src/styles/tokens.css:\n');
  for (const finding of findings) {
    console.error(`  src/${finding.rel}:${finding.line}  ${finding.kind}  ${finding.text}`);
  }
  console.error(
    `\n${findings.length} literal colour${findings.length === 1 ? '' : 's'} in ${
      new Set(findings.map((f) => f.rel)).size
    } file(s).`
    + '\nConsume a token from src/styles/tokens.css, or add the file to ALLOWED'
    + '\nin scripts/literal-colour-audit.mjs with the reason no token can serve.',
  );
  process.exit(1);
}

console.log(
  `Literal-colour audit passed: ${scanned} files hold no hex, rgb(), hsl() or named colour.`
  + ` ${ALLOWED.size} files are allowed one, each for a stated reason`
  + ' (docs/lantern-stage-spec.md §1).',
);
