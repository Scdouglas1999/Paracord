import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomCSS } from './CustomCSS';

const STYLE_ID = 'paracord-custom-css';
const WARNING = /Unsafe CSS directives were removed/i;

function customStyleElements(): HTMLStyleElement[] {
  return Array.from(document.querySelectorAll<HTMLStyleElement>(`style#${STYLE_ID}`));
}

afterEach(() => {
  // The preview <style> lives outside the React tree; clear any leftover between tests.
  customStyleElements().forEach((el) => el.remove());
});

describe('CustomCSS', () => {
  it('does not warn when safe CSS is only reformatted by sanitization', () => {
    // sanitizeCustomCss reformats this to ":root { --bg-primary: #111; }" — a string
    // difference, but no declaration or rule is dropped.
    render(<CustomCSS initialCSS=":root{--bg-primary:#111}" />);

    expect(screen.queryByText(WARNING)).toBeNull();
    expect(customStyleElements()[0].textContent).toContain('--bg-primary: #111');
  });

  it('warns when a declaration is genuinely dropped as unsafe', () => {
    render(<CustomCSS initialCSS="body { color: red; behavior: url(evil); }" />);

    expect(screen.getByText(WARNING)).toBeInTheDocument();
    const rendered = customStyleElements()[0].textContent ?? '';
    expect(rendered).toContain('color: red');
    expect(rendered).not.toContain('behavior');
  });

  it('warns when a whole at-rule is stripped', () => {
    render(<CustomCSS initialCSS="@import url(evil); body { color: red; }" />);

    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it('drives preview through exactly one custom-css style element while mounted', () => {
    render(<CustomCSS initialCSS="body { color: red; }" />);

    expect(customStyleElements()).toHaveLength(1);
  });

  it('removes the preview style element on unmount when nothing is committed', () => {
    // Empty initialCSS === nothing persisted; the element exists only for live preview and
    // must be torn down on unmount so no stray custom-css element leaks.
    const { unmount } = render(<CustomCSS initialCSS="" />);
    expect(customStyleElements()).toHaveLength(1);

    unmount();

    expect(customStyleElements()).toHaveLength(0);
  });

  it('reverts unsaved preview edits to the committed value on unmount', () => {
    // A parent that has already persisted custom CSS passes it as initialCSS. The user
    // types an unsaved edit (live-previewed), then closes the panel without saving: the
    // shared style element must revert to the committed value, not keep the preview edit.
    const { unmount } = render(<CustomCSS initialCSS="body { color: red; }" />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'body { color: blue; }' },
    });
    expect(customStyleElements()[0].textContent).toContain('color: blue');

    unmount();

    const rendered = customStyleElements()[0]?.textContent ?? '';
    expect(rendered).toContain('color: red');
    expect(rendered).not.toContain('color: blue');
  });
});
