import * as React from 'react';
import { Mic, MicOff, MonitorUp } from 'lucide-react';

import { LitAvatar, avatarInitials } from '../../light';
import { getIdentityColor } from '../../../lib/colors';
import { cn } from '../../../lib/utils';
import { SPEAKING_MARK } from '../../../lib/motion';
import type { PersonLight } from '../../../lib/attention/light';

export interface StageTileProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The person on this tile. Drives the lit rim on the camera-off avatar. */
  person?: PersonLight | null;
  /** The name on the tag — "Mara", "You". */
  name: string;
  /** Talking right now: the tile's ring breathes (§5). */
  speaking?: boolean;
  /**
   * Whose voice this tile's ring belongs to.
   *
   * Purely a motion mark (§5.1): where the media engine reports a level, the
   * ring brightens with the voice, and `lib/motion/voiceLevel.ts` needs to know
   * which tile is whose. A `LitAvatar` says so itself; a tile showing a camera
   * has no face in it to ask. Without it the tile simply breathes.
   */
  userId?: string | null;
  /** Muted: a danger glyph on the tag, and the word. */
  muted?: boolean;
  /** This tile is somebody's screen rather than their camera. */
  sharing?: boolean;
  /**
   * The transport readout, top-right, in the mono face — "QUIC", "WebRTC".
   * Only ever what the client actually knows; never a guessed number.
   */
  readout?: string | null;
  /** A mono badge top-left — "CAM · 720p". */
  badge?: string | null;
  /** The live surface: a `<video>` or `<canvas>`. Absent means the camera is off. */
  children?: React.ReactNode;
  /** True while `children` is actually painting frames. */
  live?: boolean;
  /** Diameter of the camera-off avatar. 44 on the reference tiles. */
  avatarSize?: number;
  /** The dominant tile is 16:9 and holds its content `meet`-fit. */
  dominant?: boolean;
  /** Controls that belong to the tile (fullscreen, stop watching). */
  actions?: React.ReactNode;
}

/**
 * StageTile — one tile on the Stage (docs/lantern-stage-spec.md §7.2, §8).
 *
 * A 12px-radius well with the name tag bottom-left, the transport readout
 * top-right in the mono face, and the speaking ring when that person is talking
 * right now. A camera that is off shows the person's initials on the dark tile —
 * never a silhouette illustration (§6.4).
 *
 * Presentational: it takes what is true and draws it. Nothing here reads a
 * store, subscribes to a track or decides whether somebody is speaking.
 */
export const StageTile = React.forwardRef<HTMLDivElement, StageTileProps>(function StageTile(
  {
    person = null,
    name,
    speaking = false,
    userId = null,
    muted = false,
    sharing = false,
    readout = null,
    badge = null,
    children,
    live = false,
    avatarSize = 44,
    dominant = false,
    actions,
    className,
    style,
    ...props
  },
  ref,
) {
  const state = speaking ? 'speaking' : muted ? 'muted' : null;

  return (
    <div
      ref={ref}
      {...(userId ? { [SPEAKING_MARK]: userId } : null)}
      className={cn(
        'group/tile relative isolate rounded-[var(--radius-card)] bg-bg-well',
        speaking ? 'pc-speaking' : 'shadow-[var(--shadow-tile)]',
        dominant && 'h-full w-full',
        className,
      )}
      style={style}
      {...props}
    >
      {/* The tile's content is clipped to its corners one level in, not on the
          tile itself: the speaking ring breathes on layers just outside the
          tile's edge (`.pc-speaking`), and a tile that clipped its overflow
          would clip its own ring away. */}
      <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
        {children}

        {!live && (
          <div className="absolute inset-0 flex items-center justify-center">
            {/* Light is never the only cue (§9), and neither is its absence. */}
            <span className="sr-only">{name}&rsquo;s camera is off</span>
            {person ? (
              <LitAvatar person={person} size={avatarSize} hideLabel />
            ) : (
              <span
                className="pc-display pc-lit flex items-center justify-center rounded-full font-bold text-text-on-light"
                style={{
                  width: avatarSize,
                  height: avatarSize,
                  fontSize: Math.max(9, Math.round(avatarSize * 0.34)),
                  background: getIdentityColor(name),
                }}
                aria-hidden
              >
                {avatarInitials(name)}
              </span>
            )}
          </div>
        )}

        {badge && (
          <span className="pc-mono absolute left-2.5 top-2.5 text-meta text-text-faint">{badge}</span>
        )}

        {readout && (
          <span className="pc-tag pc-mono absolute right-2.5 top-2.5 inline-flex h-6 items-center px-2 text-[11.5px] text-text-secondary">
            {readout}
          </span>
        )}

        {actions && (
          <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5">{actions}</div>
        )}

        <span className="pc-tag absolute bottom-2.5 left-2.5 z-10 inline-flex h-6 max-w-[calc(100%-1.25rem)] items-center gap-1.5 px-2 text-meta font-medium">
          {sharing ? (
            <MonitorUp size={13} className="shrink-0" aria-hidden />
          ) : muted ? (
            <MicOff size={13} className="shrink-0 text-accent-danger" aria-hidden />
          ) : speaking ? (
            <Mic size={13} className="shrink-0 text-light-white" aria-hidden />
          ) : null}
          <span className="truncate">{name}</span>
          {state && <span className="shrink-0 text-text-secondary">· {state}</span>}
        </span>
      </div>
    </div>
  );
});
