import * as React from 'react';
import { cn } from '../../lib/utils';

export interface LiveDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The label beside the dot — "LIVE", "LIVE · sharing". Omit for the dot alone. */
  label?: string;
}

/**
 * LiveDot — the 6px white-light dot that marks a live room
 * (docs/lantern-stage-spec.md §6.7: *no LIVE badge louder than the room*; the
 * dot is 6px, the label 10.5–11px, and the thumbnail carries the weight).
 *
 * It is a light, so it asserts that somebody is in the room right now. The
 * label is the §9 text equivalent; when you pass none, give the surrounding
 * element the words instead.
 */
export const LiveDot = React.forwardRef<HTMLSpanElement, LiveDotProps>(function LiveDot(
  { label, className, ...props },
  ref,
) {
  if (!label) {
    return <span ref={ref} className={cn('pc-live-dot', className)} {...props} />;
  }
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 text-[10.5px] font-bold text-light-white',
        className,
      )}
      {...props}
    >
      <span className="pc-live-dot shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
});
