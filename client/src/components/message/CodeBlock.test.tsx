import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CodeBlock from './CodeBlock';

describe('CodeBlock', () => {
  it('carries the copy chip a 44px hit area on a coarse pointer', () => {
    // §9: on a phone the header chip is the *only* way to copy a code block —
    // there is no hover row and no context menu behind it — and its ink is 25px.
    // `pc-touch` (primitives.css, `@media (pointer: coarse)`) keeps that ink and
    // grows the hit area to 44px. jsdom has no layout, so the guard is that the
    // class is on the chip: without it there is no hit area to grow.
    render(<CodeBlock code={'fn main() {}\n'} language="rust" />);
    const copy = screen.getByRole('button', { name: 'Copy code to clipboard' });
    expect(copy.className).toContain('pc-touch');
  });
});
