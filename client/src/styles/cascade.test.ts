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

  it('gives a well the §9 ring from an unlayered rule, not from a utility', () => {
    // `.pc-well` sets box-shadow from primitives.css, which is unlayered, so a
    // `focus-visible:shadow-[…]` / `focus-within:shadow-[…]` utility on a
    // pc-well element cannot win. The recipe has to live beside the class.
    const css = read('primitives.css');
    expect(css).toMatch(/\.pc-well:focus-visible\s*\{/);
    expect(css).toMatch(/\.pc-well:has\(\s*>\s*input:focus-visible/);
  });
});
