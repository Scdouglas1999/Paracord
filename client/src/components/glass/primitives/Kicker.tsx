import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * A kicker: the uppercase label over a group ("Coming up", "6 new") or beside
 * a live channel ("LIVE 42 MIN"). 12 / 700, narrow cut, tracking .1em
 * (docs/glass-spec.md §2.3). Ink-3 by default; `tone="amber"` for live.
 */
export interface KickerProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'span' | 'p' | 'h2' | 'h3';
  tone?: 'ink' | 'amber';
}

export function Kicker({ as: Tag = 'div', tone = 'ink', className, style, ...rest }: KickerProps) {
  return (
    <Tag
      className={cn('glass-kicker', className)}
      style={{ color: tone === 'amber' ? 'var(--amber)' : 'var(--ink-3)', ...style }}
      {...rest}
    />
  );
}
