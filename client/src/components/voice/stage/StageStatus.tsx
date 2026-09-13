import * as React from 'react';

import { LightCaption } from '../../light';
import { cn } from '../../../lib/utils';

/** The call phases the Stage has words for. `voiceStore.callPhase` is the source. */
export type StagePhase = 'joining' | 'reconnecting' | 'closing' | 'failed';

/**
 * What the Stage says while it is not yet a room you are in.
 *
 * Specific and in the metaphor (§6.9): it names the room, and a reconnect says
 * how long it has been trying. Never "warming up…", never "Connecting…".
 */
export function stageStatusMessage(
  phase: StagePhase,
  roomName: string,
  elapsedMs?: number | null,
): string {
  switch (phase) {
    case 'joining':
      return `Joining ${roomName}`;
    case 'reconnecting': {
      const seconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
      return `Reconnecting to ${roomName} · ${seconds} s`;
    }
    case 'closing':
      return `Leaving ${roomName}`;
    case 'failed':
      return `Couldn't reach ${roomName}`;
  }
}

/** The line under the message — what is actually happening, in plain words. */
export function stageStatusDetail(phase: StagePhase, roomName: string): string {
  switch (phase) {
    case 'joining':
      return 'Opening the call — your microphone stays off until you are in.';
    case 'reconnecting':
      return 'The call dropped. Nobody has left the room; this client is dialling back in.';
    case 'closing':
      return 'Closing your microphone and camera.';
    case 'failed':
      return `Chat still works. Calls take a separate network path, so a connection check will say which part of it could not reach ${roomName}.`;
  }
}

export interface StageStatusProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  phase: StagePhase;
  roomName: string;
  /** How long this phase has lasted, for the reconnect count. */
  elapsedMs?: number | null;
  /** The server's own words, when it gave any. */
  reason?: string | null;
  /** Retry / run the connection check / leave. */
  actions?: React.ReactNode;
}

/**
 * StageStatus — the Stage while you are not in the room yet
 * (docs/lantern-stage-spec.md §7.2, §6.9).
 *
 * It fills the dominant tile so the Stage keeps its shape, and it says exactly
 * one true thing about the call.
 */
export const StageStatus = React.forwardRef<HTMLDivElement, StageStatusProps>(function StageStatus(
  { phase, roomName, elapsedMs = null, reason = null, actions, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className={cn(
        'flex h-full min-h-0 w-full items-center overflow-hidden rounded-[var(--radius-card)] bg-bg-well px-6 shadow-[var(--shadow-tile)] sm:px-10',
        className,
      )}
      {...props}
    >
      <div className="flex max-w-[42ch] flex-col items-start gap-2">
        <span className="pc-display text-heading text-text-primary">
          {stageStatusMessage(phase, roomName, elapsedMs)}
        </span>
        <p className="text-label text-text-secondary">{stageStatusDetail(phase, roomName)}</p>
        {reason && (
          <LightCaption className="max-w-full whitespace-normal text-accent-danger">
            {reason}
          </LightCaption>
        )}
        {actions && <div className="mt-1 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
});

export interface StageNoticeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  phase: StagePhase;
  roomName: string;
  elapsedMs?: number | null;
}

/**
 * The one-line form, for a call that is already on the Stage — a reconnect,
 * say. It sits above the tiles so a live share is never torn down for a blip.
 */
export const StageNotice = React.forwardRef<HTMLDivElement, StageNoticeProps>(function StageNotice(
  { phase, roomName, elapsedMs = null, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      // One line where there is room for one, two where there is not: a notice
      // that truncates BOTH halves ("Reconnecting … The call dropped. Nobody
      // has left …") tells a phone nothing, and §9 asks the state to be
      // readable, not merely present.
      className={cn('flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2', className)}
      {...props}
    >
      <span className="shrink-0 text-label font-semibold text-accent-warning">
        {stageStatusMessage(phase, roomName, elapsedMs)}
      </span>
      <span className="min-w-0 text-meta text-text-secondary sm:truncate">
        {stageStatusDetail(phase, roomName)}
      </span>
    </div>
  );
});
