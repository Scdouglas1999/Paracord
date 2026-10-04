import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PALETTE_HUES } from '../../../lib/identityHue';
import { IX_GLYPH_NAMES } from '../glyphs';
import { IndexShowcase } from './IndexShowcase';

describe('IndexShowcase (the Index section of /design-tokens)', () => {
  it('shows every palette hue, every glyph and both themes', () => {
    const { container } = render(<IndexShowcase />);
    for (const name of IX_GLYPH_NAMES) {
      expect(container.querySelector(`[data-glyph="${name}"]`), name).not.toBeNull();
    }
    for (const hue of PALETTE_HUES) {
      expect(container.textContent).toContain(String(hue));
    }
    expect(container.querySelectorAll('[data-theme="glass"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-theme="glass-contrast"]').length).toBeGreaterThan(0);
  });

  it('draws avatars, server marks, presence and the primitives', () => {
    const { container } = render(<IndexShowcase />);
    expect(container.querySelectorAll('.ix-av').length).toBeGreaterThan(20);
    expect(container.querySelectorAll('.ix-sq').length).toBeGreaterThan(20);
    expect(container.querySelector('.ix-presence--online')).not.toBeNull();
    expect(container.querySelector('.ix-presence--idle')).not.toBeNull();
    expect(container.querySelector('.ix-presence--dnd')).not.toBeNull();
    expect(container.querySelector('.ix-cream')).not.toBeNull();
    expect(container.querySelector('.ix-ctl--danger')).not.toBeNull();
    expect(container.querySelector('.ix-chip')).not.toBeNull();
  });
});
