/**
 * The one place custom CSS is written into the document.
 *
 * Both the live preview in Settings › Appearance and the committed value
 * rendered by `useTheme()` come through here, so there is exactly one
 * `<style>` element and one answer to "did it take".
 *
 * ## Why this is not just `document.head.appendChild(style)`
 *
 * It was, and in the desktop app it did nothing at all: the CSS saved, the
 * toast said "saved", and the interface never changed. Tauri stamps a CSP
 * nonce onto every `<style>` in `index.html` and adds `'nonce-…'` to the
 * `style-src` directive it serves. Per the CSP spec a nonce *disables*
 * `'unsafe-inline'` for that directive — so the policy the app declares
 * (`style-src 'self' 'unsafe-inline'`) stops applying, and a `<style>` created
 * at runtime without that nonce is refused. The element sat in the head with
 * the right text and `sheet === null`.
 *
 * So the element is minted carrying the same nonce the document's own styles
 * carry, before it is inserted. In a plain browser there is no nonce, nothing
 * is copied, and `'unsafe-inline'` applies as before.
 *
 * And because "it was refused" is invisible by design, {@link renderCustomCss}
 * reports whether the sheet actually attached. The caller must not claim
 * success it did not get.
 */

/** Shared by the preview and the committed render: one element, one owner. */
export const CUSTOM_CSS_STYLE_ID = 'paracord-custom-css';

/**
 * The CSP nonce the document's own inline styles carry, or `''` when the page
 * is served without one.
 *
 * Read through the `nonce` IDL property rather than `getAttribute`: browsers
 * blank the content attribute after parsing precisely so that markup injection
 * cannot read it back, while same-origin script (this file) still can.
 */
function documentStyleNonce(): string {
  const source = document.querySelector<HTMLElement>(
    `style[nonce]:not(#${CUSTOM_CSS_STYLE_ID}), script[nonce]`,
  );
  return source?.nonce ?? '';
}

function existingElement(): HTMLStyleElement | null {
  return document.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null;
}

/** Drop the custom-CSS element entirely (nothing committed, nothing previewed). */
export function clearCustomCss(): void {
  existingElement()?.remove();
}

/**
 * Render `css` (already sanitized) as the document's custom CSS.
 *
 * Returns `true` when the stylesheet is attached and live — empty input counts,
 * since "no custom CSS" is a state the document can hold faithfully. Returns
 * `false` when the document refused the stylesheet; the caller is expected to
 * say so rather than report success.
 */
export function renderCustomCss(css: string): boolean {
  if (!css) {
    clearCustomCss();
    return true;
  }

  // A fresh element every time: the nonce and the content are both checked
  // when the element is inserted, so mutating an already-refused element in
  // place would leave it refused.
  const nonce = documentStyleNonce();
  const styleEl = document.createElement('style');
  styleEl.id = CUSTOM_CSS_STYLE_ID;
  if (nonce) styleEl.nonce = nonce;
  styleEl.textContent = css;

  existingElement()?.remove();
  document.head.appendChild(styleEl);

  // `sheet` is null for a stylesheet the document declined to apply. jsdom
  // never populates it, so treat "no CSSOM at all" as "cannot tell" rather
  // than as a refusal.
  if (typeof CSSStyleSheet === 'undefined') return true;
  return styleEl.sheet !== null;
}
