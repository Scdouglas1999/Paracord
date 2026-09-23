import type { ReactNode } from 'react';

import { cn } from '../../../../lib/utils';

export interface WidgetCardProps {
  title: string;
  /** A small link or control at the right of the title. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * The shell every widget in the side column shares. A widget that has nothing
 * to show does not render this at all, so the column never shows a hole.
 */
export function WidgetCard({ title, action, className, children }: WidgetCardProps) {
  return (
    <section aria-label={title} className={cn('pc-home-widget flex min-w-0 flex-col gap-3 p-4', className)}>
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 className="pc-display text-name text-text-primary">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The quiet link at the top right of a widget ("Calendar", "All media"). */
export function WidgetLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pc-focusable -mr-1 rounded-[var(--radius-chip)] px-1 text-meta font-medium text-text-link hover:underline"
    >
      {children}
    </button>
  );
}

/** A widget whose data could not be loaded says so, in its own card. */
export function WidgetError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-meta text-accent-danger">
      {children}
    </p>
  );
}
