import { describe, expect, it } from 'vitest';

import { chromeKindFor, platformFromUserAgent } from './windowChromeStore';
import { isDragRegion } from './windowDrag';

/** The composed path of a press on `target`: itself, then each ancestor up to the document. */
function pathOf(target: Element): EventTarget[] {
  const path: EventTarget[] = [];
  for (let node: Element | null = target; node; node = node.parentElement) path.push(node);
  path.push(document, window);
  return path;
}

function build(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

describe('window chrome', () => {
  it('knows the desktop shell by its webview', () => {
    expect(platformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('linux');
    expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0')).toBe('windows');
    expect(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('macos');
    expect(platformFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('macos');
    expect(chromeKindFor('linux')).toBe('frameless');
    expect(chromeKindFor('windows')).toBe('frameless');
    expect(chromeKindFor('macos')).toBe('overlay');
    expect(chromeKindFor(null)).toBe('none');
  });

  it('a press on a bare drag region moves the window; on its child, only when the region is deep', () => {
    const root = build(`
      <header id="bar" data-window-drag="">
        <span id="label">Paracord</span>
      </header>
      <header id="deep" data-window-drag="deep">
        <span id="title">general</span>
        <button id="search"><svg id="glyph"></svg></button>
        <div id="chip" role="button">Members</div>
        <div id="focusable" tabindex="0">Card</div>
        <div id="inert" tabindex="-1">Card</div>
        <div id="off" data-window-drag="false"><span id="offChild">x</span></div>
      </header>
      <main id="content"><p id="text">Hello</p></main>`);
    const at = (id: string) => pathOf(root.querySelector(`#${id}`)!);
    expect(isDragRegion(at('bar'))).toBe(true);
    expect(isDragRegion(at('label'))).toBe(false);
    expect(isDragRegion(at('deep'))).toBe(true);
    expect(isDragRegion(at('title'))).toBe(true);
    expect(isDragRegion(at('inert'))).toBe(true);
    // Controls never drag, whatever is inside them.
    expect(isDragRegion(at('search'))).toBe(false);
    expect(isDragRegion(at('glyph'))).toBe(false);
    expect(isDragRegion(at('chip'))).toBe(false);
    expect(isDragRegion(at('focusable'))).toBe(false);
    expect(isDragRegion(at('offChild'))).toBe(false);
    // Outside any region: never.
    expect(isDragRegion(at('text'))).toBe(false);
  });
});
