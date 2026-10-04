/**
 * The letter on an avatar or a server mark (docs/index-spec.md §2.3): one
 * grapheme of the name, uppercase. Never two letters, and a leading symbol or
 * emoji does not stand for a person or a server if the name has a letter or a
 * digit after it.
 */

type SegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => { segment(input: string): Iterable<{ segment: string }> };

const segmenter: InstanceType<SegmenterCtor> | null = (() => {
  const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

/** The grapheme clusters of a string (a letter with its accents, an emoji with its modifiers). */
export function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
  return Array.from(text);
}

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The monogram for a display name or a server name: the first grapheme that is
 * a letter or a digit, uppercased, and if there is none (a name made only of
 * symbols or emoji) the first non-space grapheme as it is. `?` for an empty
 * name. `ß` uppercases to `SS`; the monogram keeps the first grapheme only.
 */
export function monogramOf(name: string | null | undefined): string {
  const parts = graphemes((name ?? '').trim()).filter((part) => part.trim() !== '');
  if (parts.length === 0) return '?';
  const pick = parts.find((part) => HAS_LETTER_OR_DIGIT.test(part)) ?? parts[0];
  const upper = pick.toLocaleUpperCase();
  return graphemes(upper)[0] ?? pick;
}

export type MonogramShape = 'person' | 'server';

/**
 * The monogram's font size for a mark of `size` px (§2.3): 44% of the size,
 * rounded; a person at 88px and above takes 36% (a large face carries a
 * smaller letter). A server mark is 44% at every size.
 */
export function monogramFontSize(size: number, shape: MonogramShape): number {
  return Math.round(size * (shape === 'person' && size >= 88 ? 0.36 : 0.44));
}
