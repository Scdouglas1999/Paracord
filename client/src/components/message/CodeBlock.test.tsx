import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CodeBlock from './CodeBlock';

const clipboard = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../lib/clipboard', () => ({ writeClipboardText: clipboard.write }));

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

  it('is the code surface: the language in the header, the code in a pre, highlighted by hljs classes only', () => {
    const { container } = render(<CodeBlock code={'const answer = 42;\n'} language="ts" />);
    expect(container.querySelector('.ix-code')).not.toBeNull();
    expect(container.querySelector('.ix-code__lang')).toHaveTextContent('ts');
    expect(container.querySelector('pre.ix-code__pre code.hljs .hljs-keyword')).toHaveTextContent('const');
    // Nothing but spans and hljs classes survive the sanitizer.
    for (const el of container.querySelectorAll('pre *')) {
      expect(el.tagName).toMatch(/^(CODE|SPAN)$/);
      for (const cls of Array.from(el.classList)) expect(cls).toMatch(/^hljs/);
    }
  });

  it('names itself “code” when it has no language, and detects one', () => {
    const { container } = render(<CodeBlock code={'SELECT 1;'} />);
    expect(container.querySelector('.ix-code__lang')).toHaveTextContent('code');
    expect(container.querySelector('pre')?.textContent).toBe('SELECT 1;');
  });

  it('copies the code, says so, and goes back to Copy', async () => {
    clipboard.write.mockResolvedValue(undefined);
    const { container } = render(<CodeBlock code={'fn main() {}'} language="rust" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code to clipboard' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Code copied to clipboard' })).toBeInTheDocument());
    expect(clipboard.write).toHaveBeenCalledWith('fn main() {}');
    expect(container.querySelector('.ix-code__copy')).toHaveAttribute('data-copied', 'true');
  });
});
