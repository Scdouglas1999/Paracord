import * as React from 'react';
import { useId } from 'react';
import { cn } from '../../lib/utils';

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Visible label. Required — a field without one is a field nobody can name. */
  label: string;
  /** Hide the label visually but keep it for assistive tech. */
  hideLabel?: boolean;
  /** Helper text under the field. */
  hint?: React.ReactNode;
  /** Error message. Renders in danger ink and wires `aria-invalid`/`describedby`. */
  error?: string;
  /** Leading glyph inside the well. */
  icon?: React.ReactNode;
  /** Trailing content inside the well — a Kbd hint, a clear button. */
  trailing?: React.ReactNode;
}

/**
 * TextField: a field you type into (docs/index-spec.md §6.14: 44 tall, radius
 * 12, the field fill and a hairline, a 15px value). Focus brightens the edge and
 * draws the one focus ring around the whole field.
 */
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    { label, hideLabel = false, hint, error, icon, trailing, className, id, ...props },
    ref,
  ) {
    const autoId = useId();
    const inputId = id ?? autoId;
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;

    return (
      <div className={cn('flex w-full flex-col gap-1.5', className)}>
        <label
          htmlFor={inputId}
          className={cn('text-[13px] font-medium text-[var(--ix-ink-2)]', hideLabel && 'sr-only')}
        >
          {label}
        </label>
        <div
          className={cn(
            'pc-field flex h-[var(--h-control-phone)] items-center gap-2.5 px-3',
            error && 'shadow-[inset_0_0_0_1px_var(--ix-danger-ink)]',
          )}
        >
          {icon != null && (
            <span className="flex shrink-0 items-center text-[var(--ix-ink-3)]" aria-hidden>
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : hint ? hintId : undefined}
            className={cn(
              'min-w-0 flex-1 bg-transparent text-[15px] text-[var(--ix-ink)] outline-none',
              'placeholder:text-[var(--ix-ink-3)] disabled:cursor-not-allowed disabled:opacity-60',
            )}
            {...props}
          />
          {trailing != null && <span className="flex shrink-0 items-center">{trailing}</span>}
        </div>
        {error ? (
          <p id={errorId} className="text-[13px] text-[var(--ix-danger-ink)]">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-[13px] text-[var(--ix-ink-3)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

export interface SearchWellProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Accessible name. Defaults to "Search". */
  label?: string;
  /** Leading glyph — pass the search icon. */
  icon?: React.ReactNode;
  /** Trailing hint, usually a {@link Kbd} with the shortcut. */
  shortcut?: React.ReactNode;
}

/**
 * SearchWell: a 38px search field (radius 12), the sidebar field's look. A
 * label-less TextField with a shortcut hint; the accessible name comes from
 * `aria-label`.
 */
export const SearchWell = React.forwardRef<HTMLInputElement, SearchWellProps>(
  function SearchWell({ label = 'Search', icon, shortcut, className, ...props }, ref) {
    return (
      <div
        className={cn(
          'pc-field flex h-[var(--h-search-well)] items-center gap-2.5 px-3',
          className,
        )}
      >
        {icon != null && (
          <span className="flex shrink-0 items-center text-[var(--ix-ink-3)]" aria-hidden>
            {icon}
          </span>
        )}
        <input
          ref={ref}
          type="search"
          aria-label={label}
          placeholder={label}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--ix-ink)] outline-none placeholder:text-[var(--ix-ink-3)]"
          {...props}
        />
        {shortcut != null && <span className="flex shrink-0 items-center">{shortcut}</span>}
      </div>
    );
  },
);
