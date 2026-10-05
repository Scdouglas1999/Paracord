// Turn the scene's SVG artwork into PNG bytes with the Chromium the driver
// already uses: one blank page, the SVG as its only content, a screenshot.

import * as art from './art.mjs';

/** Images posted as attachments, by name → art source. */
const IMAGES = {
  'mission-complete': { art: 'MISSION_COMPLETE', width: 1280, height: 720 },
  'triple-revive': { art: 'TRIPLE_REVIVE', width: 1280, height: 720 },
  'photo-0': { art: 'trailPhoto', variant: 0, width: 1280, height: 720 },
  'photo-1': { art: 'trailPhoto', variant: 1, width: 1280, height: 720 },
  'photo-2': { art: 'trailPhoto', variant: 2, width: 1280, height: 720 },
  'photo-3': { art: 'trailPhoto', variant: 3, width: 1280, height: 720 },
};

export async function createRenderer(browser) {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();

  async function renderPng(svg, width, height) {
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#000">` +
      `<div id="art" style="width:${width}px;height:${height}px">${svg.replace(/width="\d+" height="\d+"/, `width="${width}" height="${height}"`)}</div>` +
      `</body></html>`,
    );
    return page.locator('#art').screenshot({ type: 'png' });
  }

  return {
    avatar: name => renderPng(art.avatarSvg(name), 256, 256),
    icon: key => renderPng(art.ICONS[key], 256, 256),
    banner: () => renderPng(art.BASECAMP_BANNER, 1600, 600),
    image(name) {
      const spec = IMAGES[name];
      if (!spec) throw new Error(`no scene image named ${name}`);
      const svg = spec.art === 'trailPhoto' ? art.trailPhoto(spec.variant) : art[spec.art];
      return renderPng(svg, spec.width, spec.height);
    },
    close: () => context.close(),
  };
}

export function pngDataUrl(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}
