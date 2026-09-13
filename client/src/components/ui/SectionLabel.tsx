import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SectionLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Right-hand meta — "24 in", "2 rooms lit". Kept in the Meta ink so the label
   * itself stays the louder half.
   */
  meta?: React.ReactNode;
}

/**
 * SectionLabel — "Kestrel Robotics · 24 in" (spec §2 Section step, §6.8).
 *
 * **Sentence case, never uppercase.** No tracking. It is a quiet signpost, not
 * a heading: if the words need to shout, they belong in a Heading instead.
 */
export const SectionLabel = React.forwardRef<HTMLDivElement, SectionLabelProps>(
  function SectionLabel({ meta, className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-4',
          'text-section text-text-faint',
          className,
        )}
        {...props}
      >
        <span className="min-w-0 truncate">{children}</span>
        {meta != null && <span className="shrink-0 text-meta text-text-faint">{meta}</span>}
      </div>
    );
  },
);
