import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SectionLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Right-hand meta — "24 online", "4 in voice". Kept in the Meta ink so the label
   * itself stays the louder half.
   */
  meta?: React.ReactNode;
}

/**
 * SectionLabel: the Glass kicker (docs/glass-spec.md §2.3): 12/700, the narrow
 * cut, uppercase with .1em tracking, in the tertiary ink ("COMING UP"). A quiet
 * signpost, not a heading: if the words need to shout, they belong in a title.
 */
export const SectionLabel = React.forwardRef<HTMLDivElement, SectionLabelProps>(
  function SectionLabel({ meta, className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'glass-kicker flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-4',
          'text-text-faint',
          className,
        )}
        {...props}
      >
        <span className="min-w-0 truncate">{children}</span>
        {meta != null && <span className="glass-instrument shrink-0 text-meta font-medium normal-case tracking-normal text-text-faint">{meta}</span>}
      </div>
    );
  },
);
