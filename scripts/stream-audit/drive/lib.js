// Helpers for command modules.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const text = (el) => (el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : null);
export const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** A visible button (or role=button/menuitem/link) whose accessible name or text matches. */
export function btn(name, root = document) {
  const all = $$('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], a', root);
  const match = (el) => {
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
    return name instanceof RegExp ? name.test(label) : label === name;
  };
  return all.find((el) => match(el) && visible(el)) ?? null;
}

export async function waitFor(fn, timeoutMs = 15000, every = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${fn.toString().slice(0, 120)}`);
    await sleep(every);
  }
}

export async function click(target, timeoutMs = 15000) {
  const el = typeof target === 'string' || target instanceof RegExp
    ? await waitFor(() => btn(target), timeoutMs)
    : target;
  if (!el) throw new Error(`nothing to click: ${String(target)}`);
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerType: 'mouse', isPrimary: true, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return text(el);
}

export function fill(target, value) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) throw new Error(`no input ${target}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function key(k, opts = {}, target = document.activeElement || document.body) {
  const init = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ...opts };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}
