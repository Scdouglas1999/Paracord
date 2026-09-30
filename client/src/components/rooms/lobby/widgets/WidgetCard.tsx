import type { ReactNode } from 'react';

import { Kicker } from '../../../glass/primitives';
import { cn } from '../../../../lib/utils';

export interface WidgetCardProps {
  title: string;
  /** A small link or control at the right of the title. */
  action?: ReactNode;
  className?: string;
  /** Leave the solid card off: for content that is already solid (pictures). */
  bare?: boolean;
  children: ReactNode;
}

/**
 * The shell every widget on a server's Overview shares: a kicker over one solid
 * tonal card (docs/glass-spec.md §1.1, §2.3), no outline. A widget that has
 * nothing to show does not render this at all, so the page never shows a hole.
 */
export function WidgetCard({ title, action, className, bare = false, children }: WidgetCardProps) {
  return (
    <section aria-label={title} className={cn('glass-sec', className)}>
      <div className="glass-sec__head">
        <Kicker as="h3" className="glass-sec__kicker">
          {title}
        </Kicker>
        {action ? <span className="glass-sec__aside">{action}</span> : null}
      </div>
      {bare ? children : <div className="glass-card">{children}</div>}
    </section>
  );
}

/** The quiet text button at the top right of a widget ("Calendar", "All media"). */
export function WidgetLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="glass-linkbtn glass-focusable">
      {children}
    </button>
  );
}

/** A widget whose data could not be loaded says so, in its own card. */
export function WidgetError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="glass-note" data-tone="danger">
      {children}
    </p>
  );
}
