import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cssColorToHex,
  readCssColor,
  reportGroundColor,
  resetGroundColorReport,
  resolveGroundColor,
} from './nativeGround';

vi.mock('./tauriEnv', () => ({ isTauri: () => true }));
vi.mock('./desktopDiagnostics', () => ({ logVoiceDiagnostic: vi.fn() }));

type Pixel = [number, number, number, number];

/**
 * jsdom has no 2D canvas, and the ground color is resolved through one on
 * purpose (`getComputedStyle` hands back `oklch(...)`, the shell needs sRGB
 * bytes). So the engine is stood in for: a canvas that starts BLACK like a real
 * one, parses the colors a real one parses, and refuses the ones a real one
 * refuses by leaving `fillStyle` where it was.
 *
 * `setterWorks: false` is the engine that produced the bug this module was
 * rewritten for — one whose `fillStyle` setter silently does nothing, leaving
 * the canvas's own opaque black standing.
 */
function installCanvas(
  known: Record<string, Pixel>,
  { setterWorks = true }: { setterWorks?: boolean } = {},
) {
  const getContext = vi.fn(() => {
    let fill = '#000000';
    let painted: Pixel = [0, 0, 0, 0];
    return {
      get fillStyle() {
        return fill;
      },
      set fillStyle(value: string) {
        if (!setterWorks) return;
        // A real canvas keeps its previous value when handed something it
        // cannot parse.
        if (known[value]) fill = value;
      },
      clearRect: () => {
        painted = [0, 0, 0, 0];
      },
      fillRect: () => {
        painted = known[fill] ?? [0, 0, 0, 255];
      },
      getImageData: () => ({ data: Uint8ClampedArray.from(painted) }),
    };
  });
  // @ts-expect-error — standing in for an engine jsdom does not ship.
  HTMLCanvasElement.prototype.getContext = getContext;
}

/**
 * jsdom does not substitute `var()` either, so the probe reads back empty.
 * Stand in for that too: the probe asks for `var(--bg-base)`, so hand it back
 * whatever `--bg-base` is set to on `<html>` — which is what an engine does,
 * and is the behavior this module is written against.
 */
function installVarSubstitution() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
    const declared = el instanceof HTMLElement ? el.style.backgroundColor : '';
    if (declared.includes('var(--bg-base)')) {
      return {
        backgroundColor: document.documentElement.style.getPropertyValue('--bg-base').trim(),
      } as CSSStyleDeclaration;
    }
    return real(el);
  }) as typeof window.getComputedStyle);
}

const PALETTE: Record<string, Pixel> = {
  '#ff00ff': [255, 0, 255, 255],
  '#000000': [0, 0, 0, 255],
  'oklch(0.165 0.007 65)': [17, 14, 11, 255],
  'rgb(10, 12, 16)': [10, 12, 16, 255],
  'rgba(0, 0, 0, 0)': [0, 0, 0, 0],
};

/** The ground as the app publishes it: a theme on <html> and a base declared. */
function ground(value: string, theme = 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.setProperty('--bg-base', value);
}

describe('the ground color the shell is told', () => {
  beforeEach(() => {
    resetGroundColorReport();
    installVarSubstitution();
    installCanvas(PALETTE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--bg-base');
    document.documentElement.removeAttribute('data-theme');
  });

  it('turns a color written in any space into the sRGB bytes the shell can paint', () => {
    expect(cssColorToHex('oklch(0.165 0.007 65)')).toBe('#110e0b');
    expect(cssColorToHex('rgb(10, 12, 16)')).toBe('#0a0c10');
  });

  it('says it could not read a color rather than reporting black', () => {
    // An engine with no `oklch()` in canvas leaves the sentinel standing.
    expect(readCssColor('oklch(0.42 0.1 250)')).toMatchObject({
      hex: null,
      why: expect.stringContaining('refused'),
    });
    expect(cssColorToHex('')).toBeNull();
    // Nothing painted at all is not a ground color either.
    expect(readCssColor('rgba(0, 0, 0, 0)')).toMatchObject({
      hex: null,
      why: expect.stringContaining('transparent'),
    });
  });

  /**
   * The regression. A `fillStyle` setter that silently does nothing leaves a
   * fresh canvas at its own opaque black; the first version of this module read
   * that back and reported `#000000` — a color no theme defines — and the
   * shell painted the window with it.
   */
  it('refuses a canvas that cannot paint, instead of reading back its black', () => {
    installCanvas(PALETTE, { setterWorks: false });
    expect(readCssColor('oklch(0.165 0.007 65)')).toMatchObject({
      hex: null,
      why: expect.stringContaining('#ff00ff'),
    });
    ground('oklch(0.165 0.007 65)');
    expect(resolveGroundColor().hex).toBeNull();
  });

  it('reads the ground off the document, not off a literal', () => {
    ground('rgb(10, 12, 16)');
    expect(resolveGroundColor().hex).toBe('#0a0c10');
    ground('oklch(0.165 0.007 65)');
    expect(resolveGroundColor().hex).toBe('#110e0b');
    // …and leaves nothing of its own behind in the tree it measured against.
    expect(document.documentElement.querySelectorAll('div')).toHaveLength(0);
  });

  it('waits rather than reporting, while the app is still booting', () => {
    // No theme published yet: the ground on screen is not decided.
    document.documentElement.style.setProperty('--bg-base', 'rgb(10, 12, 16)');
    expect(resolveGroundColor()).toMatchObject({ hex: null, why: expect.stringContaining('theme') });

    // Theme published, but the stylesheet is not in effect: nothing declares
    // the ground, so `var(--bg-base)` would paint nothing.
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.removeProperty('--bg-base');
    expect(resolveGroundColor()).toMatchObject({ hex: null, why: expect.stringContaining('--bg-base') });
  });

  it('tells the shell once per color, and again when the color changes', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    ground('rgb(10, 12, 16)');
    await reportGroundColor(invoke);
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('native_render_set_ground_color', { color: '#0a0c10' });

    ground('oklch(0.165 0.007 65)');
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenNthCalledWith(2, 'native_render_set_ground_color', { color: '#110e0b' });
  });

  it('a boot that could not see the ground does not poison the next report', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    // Boot: nothing readable. It waits, gives up, and says nothing to the shell.
    await reportGroundColor(invoke);
    expect(invoke).not.toHaveBeenCalled();
    // And the real ground still gets through afterwards.
    ground('oklch(0.165 0.007 65)');
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenCalledWith('native_render_set_ground_color', { color: '#110e0b' });
  });

  it('picks the ground up as soon as it becomes readable', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const pending = reportGroundColor(invoke);
    // The app finishes booting a few frames later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    ground('rgb(10, 12, 16)');
    await pending;
    expect(invoke).toHaveBeenCalledWith('native_render_set_ground_color', { color: '#0a0c10' });
  });

  it('retries the next time when the shell refused the last one', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no'));
    ground('rgb(10, 12, 16)');
    await reportGroundColor(invoke);
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
