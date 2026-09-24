import type { DailyWordBoardUser, DailyWordGuess, LetterState } from '../../api/dailyWord';
import { displayName } from '../../lib/displayName';

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

/** The on-screen keyboard, top row first. */
export const KEYBOARD_ROWS: readonly (readonly string[])[] = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['enter', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
];

const RANK: Record<LetterState, number> = { absent: 0, present: 1, correct: 2 };

/**
 * What each letter key shows: the best state that letter has earned in any
 * guess. A letter found in place stays green even if a later guess put it
 * somewhere wrong.
 */
export function keyboardStates(guesses: readonly DailyWordGuess[]): Record<string, LetterState> {
  const out: Record<string, LetterState> = {};
  for (const guess of guesses) {
    for (let index = 0; index < guess.word.length; index += 1) {
      const letter = guess.word[index];
      const state = guess.states[index];
      if (!letter || !state) continue;
      const current = out[letter];
      if (!current || RANK[state] > RANK[current]) out[letter] = state;
    }
  }
  return out;
}

/** The two square sets: the usual one, and the color-blind friendly one. */
export type WordPalette = 'standard' | 'contrast';

const SQUARES: Record<WordPalette, Record<LetterState, string>> = {
  standard: { correct: '\u{1F7E9}', present: '\u{1F7E8}', absent: '⬛' },
  contrast: { correct: '\u{1F7E7}', present: '\u{1F7E6}', absent: '⬛' },
};

/**
 * The spoiler-free result a person posts: the puzzle number, the score, and
 * one row of colored squares per guess. No letters.
 *
 *   Daily word 267 · 4/6
 *
 *   ⬛🟨⬛⬛⬛
 *   ...
 */
export function shareText(
  puzzle: number,
  guesses: readonly DailyWordGuess[],
  solved: boolean,
  palette: WordPalette = 'standard',
  maxGuesses = MAX_GUESSES,
): string {
  const score = solved ? `${guesses.length}/${maxGuesses}` : `X/${maxGuesses}`;
  const squares = SQUARES[palette];
  const rows = guesses.map((guess) => guess.states.map((state) => squares[state]).join(''));
  return [`Daily word ${puzzle} · ${score}`, '', ...rows].join('\n');
}

/** "5 h 12 min", "12 min", "less than a minute". */
export function timeUntil(targetIso: string, nowMs: number): string {
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return '';
  const minutes = Math.floor((target - nowMs) / 60_000);
  if (minutes < 1) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

/** The next word's arrival in the reader's own clock: "5:00 PM" style, local time. */
export function localTime(targetIso: string): string {
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) return '';
  return target.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function boardName(user: DailyWordBoardUser): string {
  return displayName(user, user.nick);
}

/** How a finished day reads in one phrase. */
export function resultPhrase(solved: boolean, guessCount: number): string {
  if (!solved) return 'Missed';
  return guessCount === 1 ? 'Solved in 1' : `Solved in ${guessCount}`;
}

/** "Today's word · 6 of you solved it". */
export function solvedCaption(solved: number): string {
  if (solved === 0) return 'No one has solved it yet';
  if (solved === 1) return '1 person solved it';
  return `${solved} of you solved it`;
}

/** One sentence per guess for screen readers: "crane: c correct, r absent, …". */
export function describeGuess(guess: DailyWordGuess): string {
  const letters = guess.word.split('').map((letter, index) => {
    const state = guess.states[index];
    const word = state === 'correct' ? 'in place' : state === 'present' ? 'in the word' : 'not in the word';
    return `${letter.toUpperCase()} ${word}`;
  });
  return `${guess.word.toUpperCase()}: ${letters.join(', ')}`;
}

const PALETTE_KEY = 'paracord.dailyWord.palette';

/** The palette this viewer picked, or null to follow the theme. */
export function readPalette(): WordPalette | null {
  try {
    const raw = window.localStorage.getItem(PALETTE_KEY);
    return raw === 'standard' || raw === 'contrast' ? raw : null;
  } catch {
    return null;
  }
}

export function writePalette(palette: WordPalette): void {
  try {
    window.localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // A viewer convenience: the page still works without it.
  }
}

/** High contrast theme means the color-blind friendly squares, unless the viewer chose. */
export function effectivePalette(choice: WordPalette | null, theme: string | null | undefined): WordPalette {
  if (choice) return choice;
  return theme === 'high-contrast' ? 'contrast' : 'standard';
}

export function dailyWordHref(guildId: string): string {
  return `/app/guilds/${guildId}/daily-word`;
}

export function isDailyWordPath(guildId: string, pathname = typeof window === 'undefined' ? '' : window.location.pathname): boolean {
  return pathname === dailyWordHref(guildId) || pathname.startsWith(`${dailyWordHref(guildId)}/`);
}
