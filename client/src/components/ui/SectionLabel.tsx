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
 * SectionLabel (docs/index-spec.md §3.1, §2.4): 12.5/600 in the tertiary ink,
 * sentence case, never uppercase ("Channels", "Voice channels"). A quiet
 * signpost, not a heading: if the words need to shout, they belong in a title.
 */
export const SectionLabel = React.forwardRef<HTMLDivElement, SectionLabelProps>(
  function SectionLabel({ meta, className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between gap-2 px-2 pb-1.5 pt-4 text-[12.5px] font-semibold leading-[1.3]',
          'text-[var(--ix-ink-3)]',
          className,
        )}
        {...props}
      >
        <span className="min-w-0 truncate">{children}</span>
        {meta != null && <span className="shrink-0 font-medium tabular-nums">{meta}</span>}
      </div>
    );
  },
);
