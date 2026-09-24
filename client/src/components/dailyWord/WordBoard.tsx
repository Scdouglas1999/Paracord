import type { CSSProperties } from 'react';
import type { DailyWordGuess, LetterState } from '../../api/dailyWord';
import { cn } from '../../lib/utils';
import { describeGuess, MAX_GUESSES, WORD_LENGTH } from './model';

export interface WordBoardProps {
  guesses: readonly DailyWordGuess[];
  /** Letters typed into the current row, not yet sent. */
  input: string;
  /** The row turning over right now, or null. */
  revealRow: number | null;
  /** The current row shakes: the last word was refused. */
  shaking: boolean;
  /** No input row: the game is over or not loaded. */
  locked: boolean;
}

/** Six rows of five tiles. Sent rows show their states; the next row shows what you type. */
export function WordBoard({ guesses, input, revealRow, shaking, locked }: WordBoardProps) {
  const rows = Array.from({ length: MAX_GUESSES }, (_, index) => index);
  const inputRow = locked ? -1 : guesses.length;
  return (
    <div className="pc-word-board" role="group" aria-label="Board">
      {rows.map((rowIndex) => {
        const guess = guesses[rowIndex];
        if (guess) {
          return (
            <SentRow
              key={rowIndex}
              guess={guess}
              revealing={revealRow === rowIndex}
            />
          );
        }
        if (rowIndex === inputRow) {
          return (
            <div
              key={rowIndex}
              className={cn('pc-word-row', shaking && 'is-shaking')}
              aria-label={input ? `Typing ${input.toUpperCase()}` : 'Next guess, empty'}
              role="group"
            >
              {Array.from({ length: WORD_LENGTH }, (_, index) => {
                const letter = input[index] ?? '';
                return (
                  <span
                    key={`${index}-${letter}`}
                    className={cn('pc-word-tile', letter && 'is-typed')}
                    data-filled={letter ? 'true' : undefined}
                    aria-hidden
                  >
                    {letter}
                  </span>
                );
              })}
            </div>
          );
        }
        return (
          <div key={rowIndex} className="pc-word-row" aria-hidden>
            {Array.from({ length: WORD_LENGTH }, (_, index) => (
              <span key={index} className="pc-word-tile" />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SentRow({ guess, revealing }: { guess: DailyWordGuess; revealing: boolean }) {
  return (
    <div className="pc-word-row" role="group" aria-label={describeGuess(guess)}>
      {guess.word.split('').map((letter, index) => {
        const state: LetterState | undefined = guess.states[index];
        return (
          <span
            key={index}
            className={cn('pc-word-tile', revealing && 'is-revealing')}
            data-state={state}
            style={revealing ? ({ '--i': index } as CSSProperties) : undefined}
            aria-hidden
          >
            {letter}
          </span>
        );
      })}
    </div>
  );
}
