import * as React from 'react';
import { cn } from '../../lib/utils';

export interface NavRowProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** Leading glyph — a 16px lucide icon, a window dot, an avatar. */
  icon?: React.ReactNode;
  /** The row's name. Rendered in the Label step; pass `display` for a room name. */
  children: React.ReactNode;
  /** Trailing content — a count Chip, a time, an action. */
  trailing?: React.ReactNode;
  /** The row you are on. Raises it and lifts the ink. */
  active?: boolean;
  /** Set the name in the display face (room and building names, spec §2). */
  display?: boolean;
  /**
   * Renders an `<a>`; otherwise a `<button>`. A row that navigates must be a
   * link so middle-click and copy-link work.
   */
  href?: string;
}

/**
 * NavRow: a 34px row at radius 10 (docs/index-spec.md §6.7). Grid is `icon,
 * name, trailing`; the active row wears the hue selection (`ix-hue-selected`,
 * the place's `--ix-hue`), never an accent bar. Hover is one step lighter,
 * press one step darker.
 */
export const NavRow = React.forwardRef<HTMLElement, NavRowProps>(function NavRow(
  { icon, children, trailing, active = false, display = false, href, className, ...props },
  ref,
) {
  const Tag = (href ? 'a' : 'button') as React.ElementType;
  return (
    <Tag
      ref={ref}
      href={href}
      type={href ? undefined : 'button'}
      aria-current={active ? 'page' : undefined}
      // The row that wears `--row-selected`. A look restyles it by this, not by
      // `aria-selected`, which the Lobby plate carries too without being a row.
      data-selected-row={active || undefined}
      className={cn(
        'pc-focusable flex w-full select-none items-center gap-2.5 text-left',
        'h-[var(--h-nav-row)] rounded-[10px] px-2.5',
        'text-[14px] font-medium',
        'transition-[background-color,color] duration-[40ms] ease-[var(--ix-ease)]',
        // The selected row is the hue wash with its hairline (`.ix-hue-selected`);
        // the others are quiet until the pointer is on them.
        active
          ? 'ix-hue-selected text-[var(--ix-ink)]'
          : 'text-[var(--ix-ink-2)] hover:bg-[var(--ix-fill)] hover:text-[var(--ix-ink)] active:bg-[var(--ix-fill-2)]',
        className,
      )}
      {...props}
    >
      {icon != null && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--ix-ink-3)]" aria-hidden>
          {icon}
        </span>
      )}
      <span className={cn('min-w-0 flex-1 truncate', display && 'pc-display font-semibold')}>
        {children}
      </span>
      {trailing != null && <span className="ml-auto flex shrink-0 items-center gap-1.5">{trailing}</span>}
    </Tag>
  );
});
