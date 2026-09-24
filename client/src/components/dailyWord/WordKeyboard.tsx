import type { PointerEvent } from 'react';
import { Delete } from 'lucide-react';
import type { LetterState } from '../../api/dailyWord';
import { KEYBOARD_ROWS } from './model';

const STATE_WORDS: Record<LetterState, string> = {
  correct: 'in place',
  present: 'in the word',
  absent: 'not in the word',
};

export interface WordKeyboardProps {
  states: Record<string, LetterState>;
  disabled: boolean;
  onKey: (key: string) => void;
}

/** The on-screen keyboard. Letters wear the best state they have earned. */
export function WordKeyboard({ states, disabled, onKey }: WordKeyboardProps) {
  // A tap or click must not leave focus on the key: the next physical Enter
  // would press that key again instead of sending the guess. Tab still reaches them.
  const keepFocus = (event: PointerEvent<HTMLButtonElement>) => event.preventDefault();
  return (
    <div className="pc-word-keyboard" role="group" aria-label="Keyboard">
      {KEYBOARD_ROWS.map((row, rowIndex) => (
        <div key={rowIndex} className="pc-word-keyrow">
          {row.map((key) => {
            if (key === 'enter') {
              return (
                <button
                  key={key}
                  type="button"
                  onPointerDown={keepFocus}
                  className="pc-word-key pc-focusable"
                  data-wide="true"
                  disabled={disabled}
                  onClick={() => onKey('enter')}
                >
                  Enter
                </button>
              );
            }
            if (key === 'backspace') {
              return (
                <button
                  key={key}
                  type="button"
                  onPointerDown={keepFocus}
                  className="pc-word-key pc-focusable"
                  data-wide="true"
                  aria-label="Delete letter"
                  disabled={disabled}
                  onClick={() => onKey('backspace')}
                >
                  <Delete size={18} aria-hidden />
                </button>
              );
            }
            const state = states[key];
            return (
              <button
                key={key}
                type="button"
                onPointerDown={keepFocus}
                className="pc-word-key pc-focusable"
                data-state={state}
                aria-label={state ? `${key.toUpperCase()}, ${STATE_WORDS[state]}` : key.toUpperCase()}
                disabled={disabled}
                onClick={() => onKey(key)}
              >
                {key}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
