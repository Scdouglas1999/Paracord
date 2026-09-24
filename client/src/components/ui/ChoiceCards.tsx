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
 * One answer out of a few, each with a line saying what it means. The same
 * raised-card radio the Appearance page uses for motion, with the arrow keys a
 * radio group is expected to answer to: one tab stop for the whole group,
 * arrows to move and choose.
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
              'pc-focusable flex flex-1 flex-col gap-1 rounded-[var(--radius-card)] px-4 py-3 text-left',
              'transition-[color,background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] active:scale-[0.98]',
              'disabled:cursor-not-allowed disabled:opacity-60',
              active
                ? 'bg-bg-raised shadow-[var(--shadow-raised),0_0_0_1px_var(--accent-primary)]'
                : 'bg-bg-mod-subtle hover:bg-bg-mod-strong',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="text-label font-semibold text-text-primary">{option.label}</span>
              {active && (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-primary">
                  <Check size={14} aria-hidden />
                  Selected
                </span>
              )}
            </span>
            <span className="text-meta leading-relaxed text-text-faint">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
