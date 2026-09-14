import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cascade-layer guard for the app's own stylesheets.
 *
 * `globals.css` imports Tailwind and then five stylesheets of our own. Ours are
 * unlayered, and an unlayered declaration outranks *every* rule in a cascade
 * layer whatever its specificity — so anything we write unlayered beats the
 * whole `utilities` layer. That is right for the component recipes (a control's
 * ring has to win) and catastrophic for a blanket element rule: an unlayered
 * `:focus-visible { outline: … }` meant `focus-visible:outline-none` could never
 * win anywhere in the app, and an unlayered `text + button { margin-top: 1rem }`
 * meant no utility could straighten a row it had bent.
 *
 * These are the two rules that bit us. Keep the blanket ones layered.
 */

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), 'src/styles', file), 'utf8');

const SHEETS = ['tokens.css', 'primitives.css', 'layout.css', 'components.css', 'utilities.css'];

/** The @layer blocks of a stylesheet. */
function layerBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@layer\s+[\w\s,]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(m.index, i));
    re.lastIndex = i;
  }
  return out;
}

/** Everything that is NOT inside an @layer block. */
function unlayered(css: string): string {
  let rest = css;
  for (const block of layerBlocks(css)) rest = rest.replace(block, '');
  return rest;
}

const layeredParts = (css: string) => layerBlocks(css).join('\n');

describe('stylesheet cascade layers', () => {
  it('keeps the generic :focus-visible fallback inside @layer base', () => {
    const css = read('layout.css');
    const generic = /(^|\n)\s*:focus-visible\s*\{/;
    expect(generic.test(css), 'layout.css no longer declares the fallback').toBe(true);
    expect(
      generic.test(layeredParts(css)),
      'the generic :focus-visible fallback must live in @layer base, or it outranks '
        + 'every outline utility in the app and a composed surface draws two rings',
    ).toBe(true);
  });

  it('declares no blanket :focus-visible outline outside a layer, in any sheet', () => {
    for (const file of SHEETS) {
      expect(
        /(^|\n)\s*:focus-visible\s*\{/.test(unlayered(read(file))),
        `${file} declares an unlayered generic :focus-visible rule`,
      ).toBe(false);
    }
  });

  it('carries no universal vertical-rhythm margin', () => {
    // A blanket "a button after text gets 1rem of air" rule cannot know whether
    // it is in a block column or a centred flex row. Every place it fired in the
    // running app was a row, where it read as an 8px misalignment — and no
    // utility could undo it. Spacing belongs to the call site.
    for (const file of SHEETS) {
      expect(
        /\+\s*:is\(\s*button/.test(read(file)),
        `${file} re-introduces a universal text + button margin`,
      ).toBe(false);
    }
  });

  it('imports the component recipes into @layer components', () => {
    // The whole point: a `.pc-*` recipe must NOT outrank a utility written at
    // the call site. That is what lets `shadow-[…,0_0_0_1px_var(--accent-danger)]`
    // draw an error edge on a `.pc-well`, and `[&>button]:mt-0` straighten a row.
    const globals = read('globals.css');
    expect(globals).toMatch(/@import\s+'\.\/primitives\.css'\s+layer\(components\)/);
    expect(globals).toMatch(/@import\s+'\.\/components\.css'\s+layer\(components\)/);
    // tokens.css and utilities.css stay unlayered on purpose — the first is the
    // token/element baseline, the second is all `!important`, and important
    // declarations reverse the layer order.
    expect(globals).toMatch(/@import\s+'\.\/tokens\.css';/);
    expect(globals).toMatch(/@import\s+'\.\/utilities\.css';/);
  });

  it('keeps the §9 ring in one layer above the utilities', () => {
    // A resting-state `shadow-*` utility replaces box-shadow wholesale. If the
    // ring lived in `components` it would lose to one, and a keyboard user
    // would simply lose the control. So it sits in `@layer focus`, declared
    // after `utilities`, and nowhere else.
    const globals = read('globals.css');
    const utilitiesAt = globals.indexOf("'./utilities.css'");
    const focusAt = globals.indexOf("'./focus.css'");
    expect(focusAt, 'focus.css is not imported').toBeGreaterThan(-1);
    expect(
      focusAt,
      'focus.css must be imported last, so `focus` is ordered after `utilities`',
    ).toBeGreaterThan(utilitiesAt);

    const focus = read('focus.css');
    expect(focus).toMatch(/@layer\s+focus\s*\{/);
    for (const recipe of [
      '.pc-focusable:focus-visible',
      '.pc-focusable-composed:focus-visible',
      '.pc-checkbox:focus-visible',
      '.btn-primary:focus-visible',
      '.input-field:focus-visible',
      '.icon-btn:focus-visible',
      '.context-menu-item:focus-visible',
      '.command-icon-btn:focus-visible',
    ]) {
      expect(focus.includes(recipe), `${recipe} is not in focus.css`).toBe(true);
    }

    // …and the recipe files must not keep a second copy, which would sit in
    // `components` and lose to the very utilities this layer exists to beat.
    for (const file of ['primitives.css', 'components.css', 'layout.css']) {
      const stray = read(file).match(/^\s*\.[\w-]+(\[[^\]]*\])?:focus-visible[^{]*\{/gm);
      expect(stray, `${file} still declares a class :focus-visible ring`).toBeNull();
    }
  });

  it('leaves a pc-well field its own error edge', () => {
    // The danger edge and the ring are one declaration at the call site
    // (`shadow-[…danger] focus-visible:shadow-[…danger,ring]`). A `.pc-well`
    // focus rule in the focus layer would flatten the edge the moment the field
    // took focus, so there must not be one.
    expect(read('primitives.css')).not.toMatch(/\.pc-well:focus-visible/);
    expect(read('focus.css')).not.toMatch(/\.pc-well:focus-visible/);
  });
});
