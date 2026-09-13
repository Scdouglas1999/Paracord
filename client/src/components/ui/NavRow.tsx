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
 * NavRow — the 34px row the Buildings column is built from (spec §3, §7.1).
 * Grid is `icon · name · trailing`; the active row is raised with a warm top
 * highlight, never an accent bar.
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
      className={cn(
        'pc-focusable flex w-full select-none items-center gap-2.5 text-left',
        'h-[var(--h-nav-row)] rounded-[var(--radius-control)] px-2.5',
        'text-label text-text-secondary',
        'transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        active
          ? 'bg-bg-raised text-text-primary shadow-[var(--shadow-raised)]'
          : 'hover:bg-bg-mod-subtle hover:text-text-primary',
        className,
      )}
      {...props}
    >
      {icon != null && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
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
