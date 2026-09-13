import * as React from 'react';

import { LightCaption } from '../../light';
import { callDuration } from '../../../lib/attention/light';
import { cn } from '../../../lib/utils';

export interface StageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** The room you are in — "Shop floor". */
  roomName: string;
  /** The building it is in — "Kestrel". */
  buildingName?: string | null;
  /**
   * How long this client has seen the room lit. Null while it does not know —
   * it renders "just now" rather than inventing a start time.
   */
  durationMs?: number | null;
  /** The here-now strip (§7.2). The only place a list of people lives. */
  hereNow?: React.ReactNode;
  /** Invite / Layout / more. */
  actions?: React.ReactNode;
  /** Phone stacks the meta under the name and keeps only the faces. */
  compact?: boolean;
  /** Folded into the compact meta line — "4 here" (§7.2 phone). */
  hereCaption?: string | null;
  /** Back affordance, phone only. */
  leading?: React.ReactNode;
}

/**
 * StageHeader — the Stage plate's header row (docs/lantern-stage-spec.md §7.2).
 *
 * Room name in the display face, "Kestrel · 34:12" in meta with the duration in
 * the mono face, the here-now strip, then Invite / Layout / more.
 */
export const StageHeader = React.forwardRef<HTMLElement, StageHeaderProps>(function StageHeader(
  {
    roomName,
    buildingName = null,
    durationMs = null,
    hereNow,
    actions,
    compact = false,
    hereCaption = null,
    leading,
    className,
    ...props
  },
  ref,
) {
  const duration = <span className="pc-mono">{callDuration(durationMs)}</span>;

  if (compact) {
    return (
      <header
        ref={ref}
        className={cn('flex min-w-0 shrink-0 items-center gap-2.5 px-1', className)}
        {...props}
      >
        {leading}
        <div className="flex min-w-0 flex-col">
          <h1 className="pc-display truncate text-[19px] font-bold leading-tight tracking-[-0.01em] text-text-primary">
            {roomName}
          </h1>
          <LightCaption>
            {buildingName ? <>{buildingName} · </> : null}
            {duration}
            {hereCaption ? <> · {hereCaption}</> : null}
          </LightCaption>
        </div>
        {hereNow && <div className="ml-auto min-w-0">{hereNow}</div>}
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
    );
  }

  return (
    <header
      ref={ref}
      className={cn('flex min-w-0 shrink-0 flex-wrap items-center gap-3', className)}
      {...props}
    >
      <h1 className="pc-display whitespace-nowrap text-title text-text-primary">{roomName}</h1>
      <LightCaption className="whitespace-nowrap">
        {buildingName ? <>{buildingName} · </> : null}
        {duration}
      </LightCaption>
      {hereNow && <div className="ml-1 min-w-0">{hereNow}</div>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
});
