import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion/reducedMotion';
import { CordMark, CordSpinner } from './CordMark';
import { cordArtSrc, cordLevel, cordLoops, cordMotion, CORD_MOTIONS } from './cordMarkModel';

afterEach(() => {
  resetMotionSwitchForTests();
});

describe('cordLevel', () => {
  it('draws the full braid from 64 px, the coarser braid from 24 px and the flat cord below', () => {
    expect(cordLevel(16)).toBe('flat');
    expect(cordLevel(20)).toBe('flat');
    expect(cordLevel(23.9)).toBe('flat');
    expect(cordLevel(24)).toBe('mid');
    expect(cordLevel(34)).toBe('mid');
    expect(cordLevel(48)).toBe('mid');
    expect(cordLevel(63)).toBe('mid');
    expect(cordLevel(64)).toBe('full');
    expect(cordLevel(1024)).toBe('full');
  });

  it('refuses a size that is not a positive number of pixels', () => {
    expect(() => cordLevel(0)).toThrow(/positive size/);
    expect(() => cordLevel(-4)).toThrow(/positive size/);
    expect(() => cordLevel(Number.NaN)).toThrow(/positive size/);
  });
});

describe('cordMotion', () => {
  it('runs the asked motion, or none at all under reduced motion', () => {
    for (const motion of CORD_MOTIONS) {
      expect(cordMotion(motion, false)).toBe(motion);
      expect(cordMotion(motion, true)).toBe('none');
    }
  });

  it('only the endless motions pause offscreen', () => {
    expect(cordLoops('loading')).toBe(true);
    expect(cordLoops('working')).toBe(true);
    expect(cordLoops('draw')).toBe(false);
    expect(cordLoops('none')).toBe(false);
  });
});

describe('cordArtSrc', () => {
  it('names the rendered art for each level and half', () => {
    expect(cordArtSrc('full')).toBe('/brand/cord-full.svg');
    expect(cordArtSrc('mid', 'under')).toBe('/brand/cord-mid-under.svg');
    expect(cordArtSrc('flat', 'whole')).toBe('/brand/cord-flat.svg');
  });
});

describe('CordMark', () => {
  it('draws the still mark as one image of its level', () => {
    const { container } = render(<CordMark size={20} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/brand/cord-flat.svg');
    expect(img).toHaveAttribute('width', '20');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });

  it('is an image named by its label', () => {
    const { getByRole } = render(<CordMark size={40} label="Paracord" />);
    expect(getByRole('img', { name: 'Paracord' })).toHaveAttribute('src', '/brand/cord-mid.svg');
  });

  it('reveals two halves of the art through masks when it moves', () => {
    const { container } = render(<CordMark size={72} motion="loading" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('pc-cord', 'pc-cord--loading');
    expect(svg).toHaveAttribute('data-level', 'full');
    const hrefs = [...svg.querySelectorAll('image')].map((image) => image.getAttribute('href'));
    expect(hrefs).toEqual(['/brand/cord-full-under.svg', '/brand/cord-full.svg']);
    // The over half, the under half, and the gap the stem cuts from the under half.
    expect(svg.querySelectorAll('mask .pc-cord__o')).toHaveLength(1);
    expect(svg.querySelectorAll('mask .pc-cord__u')).toHaveLength(1);
    expect(svg.querySelectorAll('mask .pc-cord__h')).toHaveLength(1);
    // Every mask reference resolves inside this mark.
    for (const g of svg.querySelectorAll('[mask]')) {
      const id = g.getAttribute('mask')!.slice(5, -1);
      expect(svg.querySelector(`mask[id="${id}"]`)).not.toBeNull();
    }
  });

  it('gives each mark its own mask ids', () => {
    const { container } = render(
      <>
        <CordMark size={40} motion="draw" />
        <CordMark size={40} motion="draw" />
      </>,
    );
    const ids = [...container.querySelectorAll('mask')].map((mask) => mask.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('runs the working highlight along both halves', () => {
    const { container } = render(<CordMark size={44} motion="working" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('pc-cord--working');
    expect(svg.querySelectorAll('[class^="pc-cord__wo"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[class^="pc-cord__wu"]')).toHaveLength(3);
  });

  it('holds a paused loop on its first frame', () => {
    const { container } = render(<CordMark size={160} motion="loading" paused />);
    expect(container.querySelector('svg')).toHaveAttribute('data-paused', 'true');
  });

  it('draws the still mark under reduced motion', () => {
    configureMotion('reduced');
    const { container } = render(<CordMark size={56} motion="loading" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', '/brand/cord-mid.svg');
  });

  it('draws the inline spinner in the text color, from the flat geometry', () => {
    const { container } = render(<CordSpinner />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('data-level', 'mono');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('image')).toBeNull();
    // One fill in the text's color, cut to the cord by a mask.
    expect(svg.querySelector('rect')).toHaveAttribute('fill', 'currentColor');
    expect([...svg.querySelectorAll('mask path')].map((path) => path.getAttribute('class'))).toEqual([
      'pc-cord__u',
      'pc-cord__h',
      'pc-cord__o',
    ]);
  });
});
