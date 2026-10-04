import type { ReactNode } from 'react';

import { cn } from '../../../../lib/utils';

export interface WidgetCardProps {
  title: string;
  /** A small link or control at the right of the title. */
  action?: ReactNode;
  className?: string;
  /** Leave the surface off: for content that is already a card (an event, pictures). */
  bare?: boolean;
  children: ReactNode;
}

/**
 * The shell every widget on a server's Overview shares (docs/index-spec.md §8.1): a
 * sentence-case label (12.5/600) over one quiet card (the action card's surface,
 * radius 18). A widget that has nothing to show does not render this at all, so the
 * page never shows a hole.
 */
export function WidgetCard({ title, action, className, bare = false, children }: WidgetCardProps) {
  return (
    <section aria-label={title} className={cn('ix-widget', className)} data-bare={bare || undefined}>
      <div className="ix-widget__head">
        <h3 className="ix-widget__label">{title}</h3>
        {action ? <span className="ix-widget__aside">{action}</span> : null}
      </div>
      {bare ? children : <div className="ix-widget__card">{children}</div>}
    </section>
  );
}

/** The quiet text button at the top right of a widget ("Calendar", "All media"). */
export function WidgetLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="ix-link">
      {children}
    </button>
  );
}

/** A widget whose data could not be loaded says so, in its own card, in the one danger ink. */
export function WidgetError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="ix-note" data-tone="danger">
      {children}
    </p>
  );
}
