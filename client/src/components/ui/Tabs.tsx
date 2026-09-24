import * as React from 'react';
import { useIndicator } from '../../lib/motion';
import { cn } from '../../lib/utils';

export interface TabItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
  /** Trailing count or hint — rendered in the meta ink beside the label. */
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the tab list. */
  label: string;
  /**
   * `segmented` (default) is a raised pill sliding inside a well — for a small
   * either/or choice. `underline` is a row of labels under a hairline — for the
   * top of a panel with several pages of content.
   */
  variant?: 'segmented' | 'underline';
  size?: 'sm' | 'md';
  /** Stretch the tabs to fill the row instead of hugging their labels. */
  fill?: boolean;
}

/**
 * Tabs — one control for every "pick one of these views" in the app
 * (spec §3 control heights, §6.8 no uppercase, §9 focus + roving keyboard).
 *
 * Selection is a **raised** surface inside a well, exactly like a selected row
 * anywhere else — never an accent bar on the segmented pill, never a light
 * token. That surface is ONE element the engine slides between the tabs on the
 * one ease-out (`useIndicator`): the mark moves, the pill travels to it — it
 * never jumps (§5.1). Arrow keys move between tabs; Home/End jump to the ends
 * (WAI-ARIA tabs pattern).
 *
 * The panel each tab controls stays the caller's job: give the panel
 * `role="tabpanel"` and `aria-labelledby` the tab's id if you need the full
 * pairing, or use this purely as a view switch.
 */
export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  label,
  variant = 'segmented',
  size = 'md',
  fill = false,
  className,
  ...props
}: TabsProps<T>) {
  const refs = React.useRef(new Map<T, HTMLButtonElement | null>());
  const listRef = React.useRef<HTMLDivElement>(null);
  const indicatorRef = useIndicator(
    listRef,
    [value, variant, size, fill, items.length],
    variant === 'underline' ? { thickness: 2, insetX: 8 } : {},
  );

  const move = (from: number, delta: number) => {
    const enabled = items.filter((i) => !i.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex((i) => i.value === items[from]?.value);
    const next = enabled[(currentIndex + delta + enabled.length) % enabled.length];
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = items.find((i) => !i.disabled);
      if (first) {
        onChange(first.value);
        refs.current.get(first.value)?.focus();
      }
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = [...items].reverse().find((i) => !i.disabled);
      if (last) {
        onChange(last.value);
        refs.current.get(last.value)?.focus();
      }
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={cn(
        'relative flex items-center',
        variant === 'segmented'
          ? 'pc-well gap-1 p-1'
          : 'gap-1 border-b border-border-subtle',
        fill && 'w-full',
        className,
      )}
      {...props}
    >
      {/* The ONE selected surface — the engine slides it between the marked
          tab's bounds. Segmented gets the raised pill; underline gets the 2px
          accent bar. Buttons stay `relative` so their labels paint above it. */}
      <span
        ref={indicatorRef}
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 top-0 opacity-0',
          variant === 'segmented'
            ? 'rounded-[var(--radius-chip)] bg-bg-raised shadow-[var(--shadow-raised)]'
            : 'rounded-[var(--radius-full)] bg-accent-primary',
        )}
      />
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current.set(item.value, node);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            data-indicator-target={selected ? '' : undefined}
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'pc-focusable relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap',
              'text-label transition-[color,background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] active:scale-[0.98]',
              'disabled:pointer-events-none disabled:opacity-60',
              size === 'sm' ? 'h-[var(--h-control-sm)] px-2.5' : 'h-[var(--h-control)] px-3',
              fill && 'flex-1',
              variant === 'segmented'
                ? cn(
                    'rounded-[var(--radius-chip)]',
                    selected
                      ? 'font-semibold text-text-primary'
                      : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                  )
                : cn(
                    'rounded-t-[var(--radius-chip)] px-3',
                    selected
                      ? 'font-semibold text-text-primary'
                      : 'text-text-secondary hover:text-text-primary',
                  ),
            )}
          >
            {item.icon != null && (
              <span className="flex shrink-0 items-center" aria-hidden>
                {item.icon}
              </span>
            )}
            <span className="min-w-0 truncate">{item.label}</span>
            {item.meta != null && (
              <span className="shrink-0 text-meta tabular-nums text-text-faint">{item.meta}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
