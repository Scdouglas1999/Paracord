#!/usr/bin/env node
/**
 * The app's identity and window config, checked on every platform's CI
 * (docs/design/index-checkpoints/window-chrome.md):
 *
 *   - one app id: tauri.conf.json `identifier` = the Linux desktop entry's name,
 *     Icon= and StartupWMClass=, the Inno shortcuts' AppUserModelID;
 *   - the Linux bundles install that entry and hicolor icons named after it;
 *   - icon.ico carries 16, 24, 32, 48, 64, 128 and 256; icon.icns carries
 *     16, 32, 128, 256 and 512 at 1x and 2x (the Ember mark is what
 *     `client/brand/render.mjs` writes into all of them);
 *   - the window is frameless on Linux and Windows, and macOS keeps its
 *     traffic lights over the content.
 *
 *   node client/scripts/check-app-identity.mjs
 *
 * Exits non-zero with every problem listed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');
const repo = join(here, '..', '..');
const problems = [];
const fail = (message) => problems.push(message);

const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const mac = JSON.parse(readFileSync(join(tauriDir, 'tauri.macos.conf.json'), 'utf8'));
const id = conf.identifier;
if (id !== 'com.paracord.desktop') fail(`identifier is ${id}, expected com.paracord.desktop`);

// ---- Linux: the entry and its icons ------------------------------------------------
const entryPath = join(tauriDir, 'linux', `${id}.desktop`);
if (!existsSync(entryPath)) fail(`missing ${entryPath}`);
else {
  const entry = readFileSync(entryPath, 'utf8');
  for (const line of [`Icon=${id}`, `StartupWMClass=${id}`, 'MimeType=x-scheme-handler/paracord;']) {
    if (!entry.split('\n').includes(line)) fail(`${id}.desktop lacks ${line}`);
  }
}
const iconSizes = ['32x32', '64x64', '128x128', '256x256', '512x512'];
for (const bundle of ['deb', 'rpm', 'appimage']) {
  const files = conf.bundle?.linux?.[bundle]?.files ?? {};
  const entryKey = `/usr/share/applications/${id}.desktop`;
  if (files[entryKey] !== `linux/${id}.desktop`) fail(`bundle.linux.${bundle}.files does not install ${entryKey}`);
  for (const size of iconSizes) {
    const key = `/usr/share/icons/hicolor/${size}/apps/${id}.png`;
    const source = files[key];
    if (!source) fail(`bundle.linux.${bundle}.files does not install ${key}`);
    else if (!existsSync(join(tauriDir, source))) fail(`${source} (for ${key}) does not exist`);
    else {
      const png = readFileSync(join(tauriDir, source));
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      if (`${w}x${h}` !== size) fail(`${source} is ${w}x${h}, installed as ${size}`);
    }
  }
  if (bundle !== 'appimage' && conf.bundle.linux[bundle].desktopTemplate !== 'linux/bundler-alias.desktop') {
    fail(`bundle.linux.${bundle}.desktopTemplate must hide the bundler's own Paracord.desktop`);
  }
}

// ---- Windows: the .ico and the Inno shortcuts --------------------------------------
const ico = readFileSync(join(tauriDir, 'icons', 'icon.ico'));
const icoSizes = new Set();
for (let i = 0; i < ico.readUInt16LE(4); i++) icoSizes.add(ico[6 + 16 * i] || 256);
for (const size of [16, 24, 32, 48, 64, 128, 256]) if (!icoSizes.has(size)) fail(`icon.ico has no ${size}px image`);
const iss = readFileSync(join(repo, 'installer', 'paracord-client.iss'), 'utf8');
const shortcuts = iss.split(/\r?\n/).filter((line) => /^Name: "\{(group|autodesktop)\}\\Paracord"/.test(line));
if (shortcuts.length !== 2) fail(`expected two Paracord shortcuts in paracord-client.iss, found ${shortcuts.length}`);
for (const line of shortcuts) if (!line.includes(`AppUserModelID: "${id}"`)) fail(`Inno shortcut without AppUserModelID ${id}: ${line}`);

// ---- macOS: the .icns --------------------------------------------------------------
const icns = readFileSync(join(tauriDir, 'icons', 'icon.icns'));
const types = new Set();
for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) types.add(icns.toString('ascii', at, at + 4));
// icp4/ic04 16, ic11 16@2, icp5/ic05 32, ic12 32@2, ic07 128, ic13 128@2, ic08 256, ic14 256@2, ic09 512, ic10 512@2
for (const [label, any] of [
  ['16', ['icp4', 'ic04', 'is32']],
  ['16@2x', ['ic11']],
  ['32@2x', ['ic12']],
  ['128', ['ic07']],
  ['128@2x', ['ic13']],
  ['256', ['ic08']],
  ['256@2x', ['ic14']],
  ['512', ['ic09']],
  ['512@2x', ['ic10']],
]) {
  if (!any.some((type) => types.has(type))) fail(`icon.icns has no ${label} image (${any.join('/')})`);
}

// ---- The window --------------------------------------------------------------------
const win = conf.app.windows[0];
if (win.decorations !== false) fail('the window must be frameless on Linux and Windows (decorations: false)');
if (win.shadow !== true) fail('Windows needs shadow: true (rounded corners, resize border)');
if (win.transparent) fail('the window must stay opaque (frame pacing, window-chrome.md)');
const macWin = mac.app.windows[0];
if (macWin.decorations !== true || macWin.titleBarStyle !== 'Overlay' || macWin.hiddenTitle !== true || !macWin.trafficLightPosition) {
  fail('macOS keeps its traffic lights over the content: decorations true, titleBarStyle Overlay, hiddenTitle, trafficLightPosition');
}

if (problems.length) {
  console.error(`[app-identity] ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`[app-identity] ${id}: Linux entry and icons, .ico ${[...icoSizes].sort((a, b) => a - b).join('/')}, .icns ${[...types].join(' ')}, Inno AppUserModelID, frameless window (macOS overlay): all as expected.`);
