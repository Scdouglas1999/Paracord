import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * Glass chips are content, so they are solid tonal fills with no outline
 * (docs/glass-spec.md §1.1):
 *
 *   count      a plain unread count, `#3a3b40`, 11 / 700
 *   mention    white with dark text: it needs you (§1.3)
 *   live       amber tint, amber dot: "Lounge 3 in"
 *   event      `#45464b`: "Movie night Fri 9 PM"
 *   reaction   `#34353a` with a 3px ring in the opaque pane color; sits biting
 *              a media corner
 */
export type GlassChipTone = 'count' | 'mention' | 'live' | 'event' | 'reaction';

export interface GlassChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: GlassChipTone;
}

export function GlassChip({ tone = 'count', className, children, ...rest }: GlassChipProps) {
  const badge = tone === 'count' || tone === 'mention';
  return (
    <span
      data-tone={tone}
      className={cn('glass-chip', `glass-chip--${tone}`, badge && 'glass-badge-text', className)}
      {...rest}
    >
      {tone === 'live' && <span aria-hidden="true" className="glass-chip__dot" />}
      {children}
    </span>
  );
}
