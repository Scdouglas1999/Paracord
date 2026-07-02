import fs from 'node:fs';
import path from 'node:path';

const tokensPath = path.resolve(process.cwd(), 'src/styles/tokens.css');
const css = fs.readFileSync(tokensPath, 'utf8');

function extractBlocks(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'gm');
  const vars = {};
  let match = regex.exec(css);
  while (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const parsed = line.match(/--([\w-]+)\s*:\s*([^;]+);/);
      if (parsed) vars[`--${parsed[1]}`] = parsed[2].trim();
    }
    match = regex.exec(css);
  }
  return vars;
}

function parseColor(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith('#')) {
    let hex = normalized.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6) return null;
    const int = Number.parseInt(hex, 16);
    return {
      r: (int >> 16) & 255,
      g: (int >> 8) & 255,
      b: int & 255,
      a: 1,
    };
  }
  const rgba = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (!rgba) return null;
  const parts = rgba[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return null;
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts[3] != null ? Number(parts[3]) : 1,
  };
}

function resolveVar(name, map, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const value = map[name];
  if (!value) return null;
  const varRef = value.match(/^var\((--[\w-]+)\)$/);
  if (!varRef) return value;
  return resolveVar(varRef[1], map, seen);
}

function toLinear(rgb) {
  const channel = rgb / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (
    0.2126 * toLinear(color.r) +
    0.7152 * toLinear(color.g) +
    0.0722 * toLinear(color.b)
  );
}

function blend(fg, bg) {
  const alpha = Number.isFinite(fg.a) ? fg.a : 1;
  const inv = 1 - alpha;
  return {
    r: fg.r * alpha + bg.r * inv,
    g: fg.g * alpha + bg.g * inv,
    b: fg.b * alpha + bg.b * inv,
    a: 1,
  };
}

function contrastRatio(foreground, background) {
  const fg = foreground.a < 1 ? blend(foreground, background) : foreground;
  const l1 = luminance(fg);
  const l2 = luminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const themeBase = extractBlocks('@theme');
const rootBase = extractBlocks(':root');
const themeBlocks = {
  dark: {},
  light: extractBlocks(":root[data-theme='light']"),
  amoled: extractBlocks(":root[data-theme='amoled']"),
  'high-contrast': extractBlocks(":root[data-theme='high-contrast']"),
};

const checks = [
  { fg: '--text-primary', bg: '--bg-primary', min: 4.5 },
  { fg: '--text-secondary', bg: '--bg-primary', min: 4.5 },
  { fg: '--text-muted', bg: '--bg-primary', min: 3.0 },
  { fg: '--accent-primary', bg: '--bg-primary', min: 3.0 },
];

let hasFailure = false;
for (const [themeName, overrides] of Object.entries(themeBlocks)) {
  const vars = { ...themeBase, ...rootBase, ...overrides };
  for (const check of checks) {
    const fgValue = resolveVar(check.fg, vars);
    const bgValue = resolveVar(check.bg, vars);
    const fg = fgValue ? parseColor(fgValue) : null;
    const bg = bgValue ? parseColor(bgValue) : null;
    if (!fg || !bg) {
      console.error(`[contrast] ${themeName}: unable to resolve ${check.fg} on ${check.bg}`);
      hasFailure = true;
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < check.min) {
      hasFailure = true;
      console.error(
        `[contrast] ${themeName}: ${check.fg} on ${check.bg} ratio ${ratio.toFixed(2)} < ${check.min.toFixed(2)}`,
      );
    }
  }
}

if (hasFailure) {
  process.exit(1);
}

console.log('[contrast] WCAG contrast checks passed for all configured themes.');
