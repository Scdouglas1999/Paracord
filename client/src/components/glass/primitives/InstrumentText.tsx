import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * The instrument cut (docs/glass-spec.md §2.3): timestamps, durations, dates,
 * counts. `font-stretch: 82%` at 12px and up, never below; glass.css floors the
 * size at 12px so a call site cannot get it wrong. Renders a `<time>` when
 * given a `dateTime`, a span otherwise.
 */
export interface InstrumentTextProps extends React.HTMLAttributes<HTMLElement> {
  dateTime?: string;
}

export function InstrumentText({ dateTime, className, ...rest }: InstrumentTextProps) {
  const classes = cn('glass-instrument', className);
  if (dateTime) return <time dateTime={dateTime} className={classes} {...rest} />;
  return <span className={classes} {...rest} />;
}
