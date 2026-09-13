/**
 * The product says "building" (docs/lantern-stage-spec.md §7.1, §6.9).
 *
 * A building is the thing you belong to; a room is the thing inside it. The
 * API, the routes and the code still say `guild` — that is a wire word and it
 * is fine. What is not fine is a THIRD word: guild settings said "space"
 * throughout, the invite page said "this space's rules" and the phone tab bar
 * said "Space", so the same object had two user-facing names depending on which
 * screen you were on.
 *
 * This test reads the source and fails on "space" / "spaces" in anything a
 * person can read — string literals and JSX text — with an allow-list for the
 * word's other, legitimate meanings (a gap, the space bar, whitespace).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose strings are not user-facing copy. */
const SKIP = [
  '.test.',
  '/test/',
  '/api/generated/',
  '/types/',
  'bip39-wordlist.ts',
  'vocabulary.test.ts',
];

/**
 * The word's other meanings. Each is matched against the whole string literal,
 * so a phrase here excuses that literal and nothing else.
 */
const ALLOWED = [
  /separated by spaces/i,
  /symbol or space/i,
  /or space\./i,
  /spacebar/i,
  /no spaces\)/i, // "Name (lowercase, no spaces)" — the character, not the place
  /^space$/, // the key name, normalised for keybinds — lowercase, exactly
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (SKIP.some((skip) => full.includes(skip))) continue;
    out.push(full);
  }
  return out;
}

/**
 * Source with every comment removed — a comment may say whatever it likes.
 *
 * Lexed rather than regexed: `accept="image/*"` is a string, not the start of a
 * block comment, and a regex that thinks otherwise swallows the labels after it.
 */
function withoutComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; ) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * Every string literal and every run of JSX text. Deliberately rough: it over-
 * collects (a class list is a string too), and the class-list shape is filtered
 * out below rather than parsed around.
 */
function readableStrings(source: string): string[] {
  const strings: string[] = [];
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of source.matchAll(literal)) {
    strings.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  const jsxText = />([^<>{}]*[A-Za-z][^<>{}]*)</g;
  for (const match of source.matchAll(jsxText)) strings.push(match[1]);
  return strings;
}

/** A Tailwind class list is a string, but nobody reads it. */
function isClassList(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return (
    words.length > 0
    && words.every((word) => /^[a-z0-9:[\]()_./+-]+$/.test(word) && /[-:[]/.test(word))
  );
}

/** The place, not the gap: "space" as its own word, never "space-y-2". */
const PLACE = /(^|[^A-Za-z.-])[Ss]paces?(?![A-Za-z-])/;

/**
 * Presence is light (§1.5), and §6.9 names "Online" as a thing the product
 * never says. The words live in `lib/presence` — "Lights on", "Away", "Lights
 * off" — and a surface that writes its own is a surface that will drift.
 */
const PRESENCE = /(^|[^A-Za-z-])(Online|Offline)(?![A-Za-z-])/;

/** Where the banned presence words are still the right ones. */
const PRESENCE_ALLOWED = [
  /^offline$/i, // a status id on the wire, not a label
  /offline-first/i,
];

function sweep(
  word: RegExp,
  allowed: readonly RegExp[],
): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const value of readableStrings(source)) {
      if (!word.test(value)) continue;
      if (isClassList(value)) continue;
      // A JSX text run can swallow a comment; a comment may say what it likes.
      if (value.includes('//') || value.includes('/*')) continue;
      if (allowed.some((rule) => rule.test(value.trim()))) continue;
      offenders.push(`${file.slice(SRC.length + 1)}: ${value.trim().slice(0, 90)}`);
    }
  }
  return offenders;
}

describe('the product calls a building a building', () => {
  it('never says "space" where it means a building', () => {
    expect(sweep(PLACE, ALLOWED)).toEqual([]);
  });
});

describe('presence is light, not a status word', () => {
  it('never says "Online" or "Offline" at a person', () => {
    expect(sweep(PRESENCE, PRESENCE_ALLOWED)).toEqual([]);
  });
});
