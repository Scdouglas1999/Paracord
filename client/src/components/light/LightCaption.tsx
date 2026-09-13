import * as React from 'react';

import { cn } from '../../lib/utils';
import {
  callDuration,
  darkRoomCaption,
  lastLitCaption,
  readingCaption,
  talkingCaption,
  type RoomLight,
} from '../../lib/attention/light';

export interface LightCaptionProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Render numbers in the mono meta face — durations, latencies, counts. */
  mono?: boolean;
}

/**
 * LightCaption — the words that go with a light
 * (docs/lantern-stage-spec.md §6.9, §9).
 *
 * Every lit thing renders one of these, because light is never the only cue.
 * Copy is specific and in the metaphor — "3 talking", "5 reading",
 * "Dark · nobody in", "last lit 2 h ago". The strings themselves come from
 * `lib/attention/lightCaptions.ts`; this is only the ink.
 */
export const LightCaption = React.forwardRef<HTMLSpanElement, LightCaptionProps>(
  function LightCaption({ mono = false, className, children, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn('truncate text-meta text-text-faint', mono && 'pc-mono', className)}
        {...props}
      >
        {children}
      </span>
    );
  },
);

export interface RoomCaptionOptions {
  /** A sidebar row says "Dark · nobody in"; a Lobby card says "nobody's in". */
  surface?: 'row' | 'card';
  /** Append "last lit 2 h ago" to a dark room. */
  withLastLit?: boolean;
  nowMs?: number;
}

/**
 * The caption for one room, for one surface.
 *
 * `RoomLight.caption` is already the canonical short form; this adds the
 * surface-specific wording the contract spells differently in §7.1 and §7.3,
 * and the optional "last lit" tail a dark Lobby card carries.
 */
export function roomCaptionFor(room: RoomLight, options: RoomCaptionOptions = {}): string {
  const { surface = 'row', withLastLit = false, nowMs = Date.now() } = options;
  if (room.lit) {
    return room.kind === 'voice'
      ? room.youAreHere
        ? "you're here"
        : room.talkingCount > 0
          ? talkingCaption(room.talkingCount)
          : room.caption
      : readingCaption(room.readingCount);
  }
  const dark = darkRoomCaption(surface);
  return withLastLit ? `${dark} · ${lastLitCaption(room.lastLitMs, nowMs)}` : dark;
}

/** A call duration in the mono face, for a header or the on-air pill. */
export function RoomDuration({ durationMs }: { durationMs: number | null }) {
  return <LightCaption mono>{callDuration(durationMs)}</LightCaption>;
}
