// Artwork for the Glass reference scene, lifted from the reference source
// (output/design-reference/glass/source/GlassV14*.dc.html) so the live scene
// carries the same faces, server icons and images the reference renders show.
//
// Everything here is an SVG string. `renderPng` in assets.mjs turns each one
// into PNG bytes with the Chromium the driver already has running.

const HAIR = {
  short: 'M20.6 27c-.8-8.6 4.6-14.2 11.4-14.2 7.2 0 12.4 5.6 11.4 14.2-1-3.4-3-6-5.6-7.2-3.6 1.8-9.6 2.2-14.4.6-1.6 1.6-2.4 3.8-2.8 6.6z',
  quiff: 'M20.8 26.5C20 17 25 12 32.5 12c6 0 11 3.5 11.2 10.5.1 1.6-.1 3-.5 4.3-1.3-3.8-3.6-6.3-7-7.2-4.5 2.3-10.6 2.8-15.4 6.9z',
  long: 'M19.5 42V27c0-9 5.5-15 12.5-15s12.5 6 12.5 15v15c-1.6-.4-2.8-1.8-3-3.8V25.5c-2.2-3-5.8-4.6-9.5-4.6s-7.3 1.6-9.5 4.6v12.7c-.2 2-1.4 3.4-3 3.8z',
  buzz: 'M21.2 25.5c0-7 4.8-11.5 10.8-11.5s10.8 4.5 10.8 11.5c-2.3-3.2-6.2-4.8-10.8-4.8s-8.5 1.6-10.8 4.8z',
  curly: 'M19.5 28c-2-4-1-9 2.5-11.5 1-4 5-6.5 9-5.5 3-2 8-1 10 2 3.5 1.5 5 5.5 4 9 1 2.5.5 5-1 6.5-1-3-2.5-5.5-5-6.5-4 1.5-10 1.5-14 0-2.5 1-4 3.5-5 6z',
  side: 'M20.7 27.5c-1-9 4.5-15 11.8-15 6.8 0 12 5 11.6 13.5-2-4-5-6.5-9-7.3-.8 1.5-2.5 2.6-4.6 3-3.5.7-7.2 2.5-9.8 5.8z',
  beanie: 'M20.5 23.5C21 16.5 26 11.5 32 11.5s11 5 11.5 12H45v5H19v-5z',
};
const BEARD = 'M21.5 30c.5 7 4.8 11 10.5 11s10-4 10.5-11c-2 2.6-5.5 3.6-10.5 3.6S23.5 32.6 21.5 30z';
const GLASSES = 'M23 26.5h6.5v5H23zM34.5 26.5H41v5h-6.5zM29.5 28h5';
const CUPS = 'M16.5 25.5h5.5v11h-5.5zM42 25.5h5.5v11H42z';
const BAND = 'M19.2 29c0-11 5.8-17.5 12.8-17.5S44.8 18 44.8 29';

function face(bg, skin, neck, hair, hairC, shirt, extra = {}) {
  return { bg, skin, neck, hair: HAIR[hair], hairC, shirt, fx: '', fxC: 'none', sx: '', sxC: 'none', sw: 2, ...extra };
}

/** The seven faces of the reference, by first name. Also shipped to the browser for Brendan's camera. */
export const FACES = {
  Brendan: face('#3d4a5c', '#e9bd98', '#d6a680', 'short', '#2b1d14', '#1f2630', { fx: CUPS, fxC: '#dcdcdc', sx: BAND, sxC: '#dcdcdc', sw: 2.6 }),
  Vincent: face('#5a4636', '#c68b62', '#b07650', 'quiff', '#1a120d', '#2c2622', { fx: BEARD, fxC: '#1a120d' }),
  Nick: face('#4d4152', '#f2c9aa', '#dfb190', 'long', '#6b4428', '#2a2430', { sx: GLASSES, sxC: '#1d1d1f', sw: 1.6 }),
  Eric: face('#3c4d44', '#8a5a3c', '#7a4e33', 'buzz', '#140d09', '#223029'),
  Luke: face('#5a5238', '#f5d6bf', '#e4c0a6', 'curly', '#a8702f', '#2d2a22'),
  Jeremy: face('#553f36', '#d9a47f', '#c79271', 'beanie', '#8c7c62', '#2a2420', { fx: BEARD, fxC: '#5a3a24' }),
  Sean: face('#36505a', '#ebc2a0', '#d8ab88', 'side', '#4a3020', '#1f2a2e'),
};

export function avatarSvg(name) {
  const a = FACES[name];
  if (!a) throw new Error(`no face for ${name}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256">
<rect width="64" height="64" fill="${a.bg}"/>
<path d="M6 64c2-14 13-20 26-20s24 6 26 20z" fill="${a.shirt}"/>
<path d="M27 37h10v8c0 3.2-10 3.2-10 0z" fill="${a.neck}"/>
<ellipse cx="32" cy="28" rx="11" ry="12.5" fill="${a.skin}"/>
<path d="${a.hair}" fill="${a.hairC}"/>
${a.fx ? `<path d="${a.fx}" fill="${a.fxC}"/>` : ''}
${a.sx ? `<path d="${a.sx}" fill="none" stroke="${a.sxC}" stroke-width="${a.sw}" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
</svg>`;
}

/** Server icons, 40×40 in the reference, rendered at 256. */
export const ICONS = {
  gameNight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b3f46"/><stop offset="1" stop-color="#1c1e22"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><rect x="9" y="14" width="22" height="13" rx="6.5" fill="none" stroke="#f1e9dc" stroke-width="2"/><path d="M15 17.8v5.4M12.3 20.5h5.4" stroke="#f1e9dc" stroke-width="2" stroke-linecap="round"/><circle cx="25" cy="19.2" r="1.3" fill="#ffc27e"/><circle cx="27.4" cy="21.8" r="1.3" fill="#f1e9dc"/></svg>`,
  basecamp: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5a66"/><stop offset="1" stop-color="#27313a"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><circle cx="28" cy="11" r="3" fill="#e9e4d8" opacity=".85"/><path d="M0 31 11 16l6 7 5-6 18 14v9H0z" fill="#1b2228"/><path d="M11 16l3 3.5-3-.5-2 1.5zM22 17l3 2.5h-3.2z" fill="#dfe6ea" opacity=".8"/></svg>`,
  sundayLeague: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d4b41"/><stop offset="1" stop-color="#222b25"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><path d="M0 26h40M20 26v14M13 40a7 7 0 0 1 14 0" fill="none" stroke="#e8efe9" opacity=".22" stroke-width="1.2"/><circle cx="20" cy="17" r="7" fill="#eef1ec"/><path d="m20 13.2 3.3 2.4-1.3 3.9h-4l-1.3-3.9z" fill="#27302a"/></svg>`,
};

/**
 * Basecamp's banner: the cool dawn ridge the reference's quiet state takes its
 * room light from (blue-gray, a low warm band at the horizon).
 */
export const BASECAMP_BANNER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="1600" height="600" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#27394b"/><stop offset=".6" stop-color="#5d7282"/><stop offset="1" stop-color="#a9927a"/></linearGradient>
<radialGradient id="sun" cx=".74" cy=".78" r=".4"><stop offset="0" stop-color="#ffd9a8" stop-opacity=".55"/><stop offset="1" stop-color="#ffd9a8" stop-opacity="0"/></radialGradient>
</defs>
<rect width="320" height="120" fill="url(#sky)"/><rect width="320" height="120" fill="url(#sun)"/>
<circle cx="236" cy="30" r="5" fill="#e9e4d8" opacity=".7"/>
<path d="M0 92 40 64l24 18 30-30 34 26 26-16 40 32 36-40 44 30 46-24v60H0z" fill="#33424f"/>
<path d="M94 52l8 7-7-1-4 3zM190 54l7 6h-6zM234 48l6 6-5-1z" fill="#dfe6ea" opacity=".7"/>
<path d="M0 104 60 86l40 12 50-18 60 22 50-14 60 16v16H0z" fill="#1b2430"/>
</svg>`;

/** Nick's personal best, the reference's 41:07 card (320×180 source, rendered 1280×720). */
export const MISSION_COMPLETE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="1280" height="720"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f3238"/><stop offset="1" stop-color="#091012"/></linearGradient><radialGradient id="b" cx=".85" cy=".2" r=".6"><stop offset="0" stop-color="#ffb766" stop-opacity=".35"/><stop offset="1" stop-color="#ffb766" stop-opacity="0"/></radialGradient></defs><rect width="320" height="180" fill="url(#a)"/><rect width="320" height="180" fill="url(#b)"/><path d="M0 150L60 122L120 140L190 108L250 130L320 112V180H0Z" fill="#081012"/><text x="24" y="42" style="font:700 8.5px ui-monospace,monospace;letter-spacing:2.5px;fill:#9fe0b4">MISSION COMPLETE</text><text x="21" y="92" style="font:800 50px system-ui,sans-serif;fill:#f3f1ea;letter-spacing:-1px">41:07</text><text x="24" y="112" style="font:600 7px ui-monospace,monospace;letter-spacing:1px;fill:#f3f1ea;opacity:.6">HAZARD 5 · 0 DOWNS · 4/4 EXTRACTED</text><rect x="212" y="38" width="84" height="6" rx="3" fill="#f3f1ea" opacity=".12"/><rect x="212" y="38" width="70" height="6" rx="3" fill="#ffb766"/><rect x="212" y="52" width="84" height="6" rx="3" fill="#f3f1ea" opacity=".12"/><rect x="212" y="52" width="52" height="6" rx="3" fill="#9fe0b4"/></svg>`;

/** Brendan's revive clip still, the reference's 38:12 card. */
export const TRIPLE_REVIVE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="1280" height="720"><defs><linearGradient id="rv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2233"/><stop offset="1" stop-color="#0c0b10"/></linearGradient><radialGradient id="rv2" cx=".3" cy=".6" r=".5"><stop offset="0" stop-color="#ffb766" stop-opacity=".45"/><stop offset="1" stop-color="#ffb766" stop-opacity="0"/></radialGradient></defs><rect width="320" height="180" fill="url(#rv)"/><rect width="320" height="180" fill="url(#rv2)"/><path d="M0 140L70 118L140 132L210 104L320 126V180H0Z" fill="#08070b"/><text x="24" y="42" style="font:700 8.5px ui-monospace,monospace;letter-spacing:2.5px;fill:#ffcf99">TRIPLE REVIVE</text><text x="21" y="92" style="font:800 44px system-ui,sans-serif;fill:#f3f1ea;letter-spacing:-1px">38:12</text><circle cx="262" cy="70" r="22" fill="none" stroke="#ffb766" stroke-width="3" opacity=".8"/><path d="M262 58v24M250 70h24" stroke="#ffb766" stroke-width="3" stroke-linecap="round"/></svg>`;

/** Trail photos for Basecamp › Photos: the reference's dawn landscape with variations. */
export function trailPhoto(variant) {
  const skies = [
    ['#2c3e52', '#6d7f8c', '#c7a27a'],
    ['#233447', '#56697a', '#b59373'],
    ['#31465a', '#7d8f99', '#d2b08a'],
    ['#1f2d3d', '#4c5f70', '#a38366'],
  ][variant % 4];
  const ridge = [
    'M0 140 70 80l40 38 36-30 80 56 94-40v76H0z',
    'M0 130 50 96l46 30 50-52 60 44 40-20 74 40v42H0z',
    'M0 150 90 70l30 30 40-24 70 60 90-50v94H0z',
    'M0 136 40 110l60-40 50 46 44-26 60 40 66-30v80H0z',
  ][variant % 4];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="1280" height="720" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="dawn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skies[0]}"/><stop offset=".55" stop-color="${skies[1]}"/><stop offset="1" stop-color="${skies[2]}"/></linearGradient><radialGradient id="sun" cx="${0.3 + (variant % 3) * 0.2}" cy=".62" r=".35"><stop offset="0" stop-color="#ffd9a8" stop-opacity=".8"/><stop offset="1" stop-color="#ffd9a8" stop-opacity="0"/></radialGradient></defs><rect width="320" height="180" fill="url(#dawn)"/><rect width="320" height="180" fill="url(#sun)"/><path d="${ridge}" fill="#1c2630"/></svg>`;
}

/**
 * The stream Vincent shares, as drawing instructions for a 2D canvas (the
 * reference's `sar8` scene, 320×180 units). media-init.js animates it: the
 * headlamp beam sways, the glow breathes, the crystals shimmer, dust drifts and
 * the HUD counter ticks, so consecutive frames always differ.
 */
export const STREAM_SCENE = {
  ridgeFar: 'M0 96L30 88L64 97L104 84L150 92L196 80L240 90L290 82L320 88V140H0Z',
  ceiling: 'M0 0H320V30L304 44L296 30L276 52L262 28L240 40L226 24L200 46L186 26L160 38L146 20L124 42L110 26L86 40L70 22L50 44L34 26L16 38L0 28Z',
  floor: 'M0 180V136L40 128L78 138L122 130L170 142L214 131L262 140L320 132V180Z',
  crystalA: 'M30 132L40 92L48 130Z',
  crystalB: 'M44 131L53 104L59 132Z',
  body: 'M196 141L198 116Q203 106 209 116L211 141Z',
};
