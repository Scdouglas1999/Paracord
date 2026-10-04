import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GlyphFrame, IX_GLYPH_NAMES, IxGlyph } from './index';

/**
 * The prototype's path data (output/design-reference/index/paracord-index.html,
 * the `I` table and the inline icons), verbatim. The prototype is not in the
 * repository, so the strings are here.
 */
const PROTOTYPE_PATHS: Record<string, string[]> = {
  speaker: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7'],
  mic: ['M5 11a7 7 0 0 0 14 0M12 18v3'],
  camera: ['m16 10.5 5-3v9l-5-3z'],
  screen: ['M8 21h8M12 17v4'],
  x: ['M6 6l12 12M18 6 6 18'],
  search: ['m20 20-4-4'],
  people: ['M2.5 20c.6-3.8 3.3-6 6.5-6s5.9 2.2 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .6 3.3 2.6 3.5 6'],
  invite: ['M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 8v6M23 11h-6'],
  plan: ['M3 10h18M8 3v4M16 3v4'],
  hello: ['M4 5h16v11H9l-5 4z'],
  attach: ['M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19'],
  poll: ['M5 20V10M12 20V4M19 20v-7'],
  event: ['M3 10h18'],
  send: ['M12 19V5M6 11l6-6 6 6'],
  plus: ['M12 5v14M5 12h14'],
  chevron: ['m6 9 6 6 6-6'],
};

const paths = (svg: Element) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'));

describe('IxGlyph', () => {
  it('draws every glyph on a 24 grid with a 1.7 round stroke, in currentColor', () => {
    for (const name of IX_GLYPH_NAMES) {
      const { container, unmount } = render(<IxGlyph name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg, name).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg, name).toHaveAttribute('stroke-width', '1.7');
      expect(svg, name).toHaveAttribute('stroke-linecap', 'round');
      expect(svg, name).toHaveAttribute('stroke-linejoin', 'round');
      expect(svg, name).toHaveAttribute('fill', 'none');
      expect(svg, name).toHaveAttribute('stroke', 'currentColor');
      expect(svg, name).toHaveAttribute('data-glyph', name);
      expect(svg.children.length, name).toBeGreaterThan(0);
      unmount();
    }
  });

  it('holds the prototype paths verbatim', () => {
    for (const [name, expected] of Object.entries(PROTOTYPE_PATHS)) {
      const { container, unmount } = render(<IxGlyph name={name as never} />);
      const drawn = paths(container.querySelector('svg')!);
      for (const d of expected) expect(drawn, name).toContain(d);
      unmount();
    }
  });

  it('keeps the prototype shapes that are not paths', () => {
    const shape = (name: string, selector: string) => {
      const { container, unmount } = render(<IxGlyph name={name as never} />);
      const found = container.querySelector(selector);
      unmount();
      return found;
    };
    expect(shape('mic', 'rect[x="9"][y="3"][width="6"][height="11"][rx="3"]')).not.toBeNull();
    expect(shape('camera', 'rect[x="3"][y="6"][width="13"][height="12"][rx="2.5"]')).not.toBeNull();
    expect(shape('screen', 'rect[x="3"][y="4"][width="18"][height="13"][rx="2"]')).not.toBeNull();
    expect(shape('search', 'circle[cx="11"][cy="11"][r="7"]')).not.toBeNull();
    expect(shape('people', 'circle[cx="9"][cy="8"][r="3.5"]')).not.toBeNull();
    expect(shape('plan', 'rect[x="3"][y="5"][width="18"][height="16"][rx="2"]')).not.toBeNull();
    expect(shape('event', 'rect[x="3"][y="5"][width="18"][height="16"][rx="2"]')).not.toBeNull();
  });

  it('draws the dots as three filled circles (the prototype keeps their stroke)', () => {
    const { container } = render(<IxGlyph name="dots" />);
    const circles = [...container.querySelectorAll('circle')];
    expect(circles.map((c) => c.getAttribute('cx'))).toEqual(['5', '12', '19']);
    for (const circle of circles) {
      expect(circle).toHaveAttribute('r', '1');
      expect(circle).toHaveAttribute('fill', 'currentColor');
    }
  });

  it('is 18px by default and takes any size', () => {
    const { container, rerender } = render(<IxGlyph name="plus" />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '18');
    expect(container.querySelector('svg')).toHaveAttribute('height', '18');
    rerender(<IxGlyph name="plus" size={12} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '12');
  });

  it('is decorative unless it has a title', () => {
    const { container, rerender } = render(<IxGlyph name="lock" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg')).toHaveAttribute('focusable', 'false');
    expect(container.querySelector('svg')).not.toHaveAttribute('role');
    rerender(<IxGlyph name="lock" title="Encrypted" />);
    expect(container.querySelector('svg')).toHaveAttribute('role', 'img');
    expect(container.querySelector('svg')).toHaveAttribute('aria-label', 'Encrypted');
    expect(container.querySelector('svg')).not.toHaveAttribute('aria-hidden');
  });

  it('carries the .ix-glyph class so it never shrinks in a row', () => {
    const { container } = render(<IxGlyph name="send" className="extra" />);
    expect(container.querySelector('svg')).toHaveClass('ix-glyph', 'extra');
  });

  it('includes the verb glyphs the call view keeps, restroked to 1.7', () => {
    for (const name of ['listen', 'watch', 'clip', 'flame', 'theater'] as const) {
      expect(IX_GLYPH_NAMES).toContain(name);
      const { container, unmount } = render(<IxGlyph name={name} />);
      expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '1.7');
      unmount();
    }
    // A solid shape has no stroke: listen's dot, watch's pupil, the flame's ember.
    const listen = render(<IxGlyph name="listen" />);
    expect(listen.container.querySelector('circle')).toHaveAttribute('stroke', 'none');
  });
});

describe('GlyphFrame', () => {
  it('frames a one-off glyph the same way', () => {
    const { container } = render(
      <GlyphFrame size={16}>
        <path d="M1 1h2" />
      </GlyphFrame>,
    );
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('stroke-width', '1.7');
    expect(svg).toHaveAttribute('width', '16');
    expect(paths(svg)).toEqual(['M1 1h2']);
  });
});
