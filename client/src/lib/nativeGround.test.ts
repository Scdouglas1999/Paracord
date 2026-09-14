import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cssColorToHex, reportGroundColor, resetGroundColorReport, resolveGroundColor } from './nativeGround';

vi.mock('./tauriEnv', () => ({ isTauri: () => true }));

/**
 * jsdom has no 2D canvas, and the ground colour is resolved through one on
 * purpose (`getComputedStyle` hands back `oklch(...)`, the shell needs sRGB
 * bytes). So the engine is stood in for: a context that parses the colours a
 * real one parses, refuses the ones a real one refuses by leaving `fillStyle`
 * where it was, and hands back the pixel it was told to paint.
 */
function installCanvas(known: Record<string, [number, number, number, number]>) {
  const getContext = vi.fn(() => {
    let fill = '#000000';
    let painted: [number, number, number, number] = [0, 0, 0, 0];
    return {
      get fillStyle() {
        return fill;
      },
      set fillStyle(value: string) {
        // A real canvas keeps its previous value when handed something it
        // cannot parse — that is the case the sentinel exists to catch.
        if (known[value]) fill = value;
      },
      fillRect: () => {
        painted = known[fill] ?? [0, 0, 0, 0];
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
 * whatever `--bg-base` is set to on `<html>` — which is exactly what an engine
 * does, and is the behaviour this module is written against.
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

describe('the ground colour the shell is told', () => {
  beforeEach(() => {
    resetGroundColorReport();
    installVarSubstitution();
    installCanvas({
      '#ff00ff': [255, 0, 255, 255],
      'oklch(0.165 0.007 65)': [16, 15, 12, 255],
      'rgb(10, 12, 16)': [10, 12, 16, 255],
      'rgba(0, 0, 0, 0)': [0, 0, 0, 0],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--bg-base');
  });

  it('turns a colour written in any space into the sRGB bytes the shell can paint', () => {
    expect(cssColorToHex('oklch(0.165 0.007 65)')).toBe('#100f0c');
    expect(cssColorToHex('rgb(10, 12, 16)')).toBe('#0a0c10');
  });

  it('says it could not read a colour rather than reporting black', () => {
    // An engine with no `oklch()` in canvas leaves `fillStyle` alone; without
    // the sentinel that reads back as the default black with full confidence.
    expect(cssColorToHex('oklch(0.42 0.1 250)')).toBeNull();
    expect(cssColorToHex('')).toBeNull();
    // Nothing painted at all is not a ground colour either.
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull();
  });

  it('reads the ground off the document, not off a literal', () => {
    document.documentElement.style.setProperty('--bg-base', 'rgb(10, 12, 16)');
    expect(resolveGroundColor()).toBe('#0a0c10');
    document.documentElement.style.setProperty('--bg-base', 'oklch(0.165 0.007 65)');
    expect(resolveGroundColor()).toBe('#100f0c');
    // …and leaves nothing of its own behind in the tree it measured against.
    expect(document.documentElement.querySelectorAll('div')).toHaveLength(0);
  });

  it('tells the shell once per colour, and again when the colour changes', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    document.documentElement.style.setProperty('--bg-base', 'rgb(10, 12, 16)');
    await reportGroundColor(invoke);
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('native_render_set_ground_color', { color: '#0a0c10' });

    document.documentElement.style.setProperty('--bg-base', 'oklch(0.165 0.007 65)');
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenNthCalledWith(2, 'native_render_set_ground_color', { color: '#100f0c' });
  });

  it('does not tell the shell a colour it could not read', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.documentElement.style.setProperty('--bg-base', 'oklch(0.42 0.1 250)');
    await reportGroundColor(invoke);
    expect(invoke).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('retries the next time when the shell refused the last one', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.documentElement.style.setProperty('--bg-base', 'rgb(10, 12, 16)');
    await reportGroundColor(invoke);
    await reportGroundColor(invoke);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
