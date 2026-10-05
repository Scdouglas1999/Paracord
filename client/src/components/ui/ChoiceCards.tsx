import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ChoiceOption<T extends string> {
  id: T;
  label: string;
  hint: ReactNode;
}

export interface ChoiceCardsProps<T extends string> {
  /** Id of the visible element that names the question. */
  labeledBy: string;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  /** Side by side from `sm` up, or always stacked. */
  layout?: 'row' | 'column';
  className?: string;
}

/**
 * One answer out of a few, each with a line saying what it means: quiet cards
 * (radius 18, the action-card fill), the chosen one lit with the hue selection,
 * a check and the word "Selected", so the choice never depends on color. The
 * arrow keys a radio group is expected to answer to: one tab stop for the whole
 * group, arrows to move and choose.
 */
export function ChoiceCards<T extends string>({
  labeledBy,
  options,
  value,
  onChange,
  disabled,
  layout = 'column',
  className,
}: ChoiceCardsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labeledBy}
      className={cn(
        'flex flex-col gap-2',
        layout === 'row' && 'sm:flex-row',
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'pc-focusable flex flex-1 flex-col gap-1 rounded-[18px] px-4 py-3 text-left',
              'transition-[color,background-color] duration-[120ms] ease-[var(--ix-ease)]',
              'disabled:cursor-not-allowed disabled:opacity-[.45]',
              active
                ? 'ix-hue-selected'
                : 'bg-[var(--ix-fill-card)] shadow-[inset_0_0_0_1px_var(--ix-line)] hover:bg-[var(--ix-fill-card-hover)] active:bg-[var(--ix-fill-2)]',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-[var(--ix-ink)]">{option.label}</span>
              {active && (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-[var(--ix-ink)]">
                  <Check size={14} aria-hidden />
                  Selected
                </span>
              )}
            </span>
            <span className="text-[13px] leading-[1.4] text-[var(--ix-ink-3)]">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
