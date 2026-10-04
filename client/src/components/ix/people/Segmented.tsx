import { useId, useRef, type KeyboardEvent } from 'react';

import { cn } from '../../../lib/utils';

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  /** A small count after the label (requests waiting, unread). Omit or 0 draws none. */
  count?: number;
}

export interface SegmentedProps<T extends string> {
  /** The control's accessible name ("Show", "Inbox"). */
  label: string;
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The prefix of the ids the tabs and the page's panel share (`segmentedIds`). Default: a generated one. */
  idBase?: string;
  className?: string;
}

/** The ids a tab and its panel use, so a page can name its panel after the tab. */
export function segmentedIds(base: string, value: string): { tab: string; panel: string } {
  return { tab: `${base}-${value}-tab`, panel: `${base}-panel` };
}

/**
 * A segmented control (docs/index-spec.md §6.1, §6.6, §8.1): the pages' filters as one
 * quiet tile with the chosen segment lifted. A tablist: one Tab stop (the chosen
 * segment), the arrow keys, Home and End move AND choose, like the Add a server sheet.
 * The panel it controls is the page's: `role="tabpanel"` with `id` and `aria-labelledby`
 * from `segmentedIds(idBase, value)`.
 */
export function Segmented<T extends string>({ label, items, value, onChange, idBase, className }: SegmentedProps<T>) {
  const generated = useId();
  const base = idBase ?? generated;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = items.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index >= last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index <= 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className={cn('ix-seg', className)} data-testid="ix-seg">
      {items.map((item, index) => {
        const ids = segmentedIds(base, item.value);
        const chosen = item.value === value;
        return (
          <button
            key={item.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={chosen}
            aria-controls={ids.panel}
            tabIndex={chosen ? 0 : -1}
            className="ix-seg__tab"
            data-value={item.value}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {item.label}
            {/* A space in the name, so a screen reader says "Online 3". */}
            {item.count !== undefined && item.count > 0 && ' '}
            {item.count !== undefined && item.count > 0 && <span className="ix-seg__count">{item.count > 99 ? '99+' : item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
