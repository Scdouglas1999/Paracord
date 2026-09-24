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
 * NavRow — the 34px row the servers column is built from (spec §3, §7.1).
 * Grid is `icon · name · trailing`; the active row is a warm wash under a warm
 * top highlight, never an accent bar.
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
        'pc-focusable pc-pressable-row flex w-full select-none items-center gap-2.5 text-left',
        'h-[var(--h-nav-row)] rounded-[var(--radius-control)] px-2.5',
        'text-label text-text-secondary',
        // The transition and the press belong to `.pc-pressable-row`: a row
        // darkens a step under the finger rather than shrinking (§5.1).
        // The selected row is a wash in the base hue rather than a gray step,
        // and inside a server's group it is a wash in THAT server's color —
        // `--row-selected` is written per group by BuildingSection (§7.1).
        active
          ? 'bg-[var(--row-selected)] text-text-primary shadow-[var(--shadow-raised)]'
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
