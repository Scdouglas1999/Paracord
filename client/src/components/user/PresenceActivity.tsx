import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Gamepad2, Music, Radio, Trophy, Tv, type LucideIcon } from 'lucide-react';

import {
  activityElapsed,
  formatTrackTime,
  statusLine,
  trackProgress,
  type ActivityKind,
  type ActivityView,
  type StatusLine,
} from '../../lib/activityDisplay';
import { cn } from '../../lib/utils';
import { usePresenceStore } from '../../stores/presenceStore';
import { useServerListStore } from '../../stores/serverListStore';
import { Tooltip } from '../ui/Tooltip';

const ICON: Record<ActivityKind, LucideIcon> = {
  listening: Music,
  watching: Tv,
  playing: Gamepad2,
  streaming: Radio,
  competing: Trophy,
};

export function ActivityIcon({ kind, size = 12, className }: { kind: ActivityKind; size?: number; className?: string }) {
  const Icon = ICON[kind];
  return <Icon size={size} aria-hidden className={cn('shrink-0', className)} />;
}

/**
 * The line under a name in a member row: the custom status someone typed, or
 * else what they are doing ("♪ Windowlicker — Aphex Twin"). Truncates; the
 * whole sentence is the hover title and what a screen reader hears.
 */
export function StatusLineText({ line, className }: { line: StatusLine; className?: string }) {
  if (line.type === 'custom') {
    return (
      <span className={cn('block min-w-0 truncate text-meta text-text-muted', className)} title={line.text}>
        {line.text}
      </span>
    );
  }
  return <ActivityLine view={line.activity} className={className} />;
}

export function ActivityLine({ view, className }: { view: ActivityView; className?: string }) {
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1 text-meta text-text-muted', className)}
      title={view.sentence}
      data-activity-kind={view.kind}
    >
      <ActivityIcon kind={view.kind} size={11} />
      <span className="min-w-0 truncate">
        {/* The visible line drops "Listening to" (the note says it); a
            screen reader gets the words instead of the icon. */}
        {view.kind === 'listening' && <span className="sr-only">{view.verb} </span>}
        {view.line}
      </span>
    </span>
  );
}

/**
 * The status line for one person, read from the presence store per row so a
 * presence change re-renders only that row. `scope` is the server the row
 * belongs to (the presence store is account-scoped).
 */
export function usePresenceStatusLine(userId: string | null | undefined, scope?: string | null): StatusLine | null {
  const presence = usePresenceStore((state) =>
    userId ? state.getPresence(userId, scope ?? undefined) : undefined,
  );
  return useMemo(() => statusLine(presence), [presence]);
}

/** One second clock, only while something is on screen that needs it. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The profile card's activity section body: title, artist, app, and a
 * progress bar when the track's length is known.
 */
export function ActivityCard({ view, className }: { view: ActivityView; className?: string }) {
  const now = useNow(view.startedMs !== null);
  const progress = trackProgress(view, now);
  // No timeline (a game, a watch party without a length): say how long instead.
  const elapsed = progress ? null : activityElapsed(view, now);
  const meta = [view.subtitle, view.app, elapsed].filter(Boolean).join(' · ');

  return (
    <div className={cn('pc-well flex items-start gap-3 px-3.5 py-3', className)} data-testid="activity-card">
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-bg-mod-strong text-text-secondary"
        aria-hidden
      >
        <ActivityIcon kind={view.kind} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-label font-semibold text-text-primary" title={view.title}>
          {view.title}
        </div>
        {meta && (
          <div className="truncate text-meta text-text-secondary" title={meta}>
            {view.kind === 'listening' && view.subtitle ? (
              <>
                <span className="sr-only">by </span>
                {meta}
              </>
            ) : (
              meta
            )}
          </div>
        )}
        {progress && (
          <div className="mt-2">
            <div
              className="h-1 w-full overflow-hidden rounded-[var(--radius-full)] bg-bg-mod-strong"
              role="progressbar"
              aria-label="Track progress"
              aria-valuemin={0}
              aria-valuemax={Math.round(progress.durationMs / 1000)}
              aria-valuenow={Math.round(progress.elapsedMs / 1000)}
              aria-valuetext={`${formatTrackTime(progress.elapsedMs)} of ${formatTrackTime(progress.durationMs)}`}
            >
              <div
                className="pc-meter-fill is-live bg-text-secondary"
                style={{ '--pc-fill': progress.fraction.toFixed(4) } as CSSProperties}
              />
            </div>
            <div className="pc-mono mt-1 flex justify-between text-[11px] text-text-muted" aria-hidden>
              <span>{formatTrackTime(progress.elapsedMs)}</span>
              <span>{formatTrackTime(progress.durationMs)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The status line for a person row, or nothing when there is none. */
export function PersonStatusLine({
  userId,
  scope,
  className,
}: {
  userId: string;
  /** The server the row belongs to; defaults to the active one. */
  scope?: string | null;
  className?: string;
}) {
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const line = usePresenceStatusLine(userId, scope ?? activeServerId);
  return line ? <StatusLineText line={line} className={className} /> : null;
}

/** "Jonas — Listening to Windowlicker by Aphex Twin on Spotify", for a face's tooltip. */
export function statusLineSentence(line: StatusLine | null): string | null {
  if (!line) return null;
  return line.type === 'custom' ? line.text : line.activity.sentence;
}

/** A face in a pile, with a tooltip naming the person and what they are up to. */
export function PersonFaceTooltip({
  userId,
  name,
  fallback,
  children,
}: {
  userId: string;
  name: string;
  /** What to say when there is no status line ("Online"). */
  fallback: string;
  children: ReactNode;
}) {
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const line = usePresenceStatusLine(userId, activeServerId);
  return (
    <Tooltip content={`${name} — ${statusLineSentence(line) ?? fallback}`} side="bottom">
      {children}
    </Tooltip>
  );
}
