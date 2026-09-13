import * as React from 'react';
import { useEffect, useRef } from 'react';

import { Lamp } from '../ui';
import { cn } from '../../lib/utils';
import { darkRoomCaption, type RoomLight } from '../../lib/attention/light';
import type { RoomFrame } from '../../lib/media/roomFrameTap';
import { AvatarStack } from './AvatarStack';
import { LiveDot } from './LiveDot';

/** The three heights the contract names (§8): sidebar, Lobby card, Home. */
export type RoomThumbnailHeight = 64 | 168 | 176;

export interface RoomThumbnailProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  room: RoomLight;
  /** 64 (sidebar row), 168 (Lobby card), 176 (Home). */
  height?: RoomThumbnailHeight | number;
  /**
   * The newest sampled frame, when the room can produce one. The tap
   * (`lib/media/roomFrameTap.ts`) caps this at 2 fps and the model
   * (`room.thumbnail`) already says whether live frames exist at all.
   */
  frame?: RoomFrame | null;
  /** A poster still for a room that cannot produce live frames. */
  still?: string | null;
  /** Show the occupant stack in the corner. */
  showOccupants?: boolean;
  /** A Join button, rendered bottom-right over the frame. */
  action?: React.ReactNode;
}

/**
 * RoomThumbnail — a window you can see into
 * (docs/lantern-stage-spec.md §5, §7.1, §7.3, §8).
 *
 * **Live vs still is not a style choice.** `room.thumbnail.live` is true only
 * when real frames are arriving from the media pipeline; in every other case
 * the component paints a still and the LIVE dot, and the reason is in the
 * model (`not-joined`, `native-surface`, `no-publisher`, `no-engine`). There is
 * no fake motion here and no waveform animation (§5, §6.4).
 *
 * A dark room is a matte well with the words in it — never a black rectangle.
 */
export const RoomThumbnail = React.forwardRef<HTMLDivElement, RoomThumbnailProps>(
  function RoomThumbnail(
    { room, height = 64, frame = null, still = null, showOccupants = true, action, className, style, ...props },
    ref,
  ) {
    const occupants = room.occupants.map((occupant) => occupant.person);
    const compact = height < 120;
    const pad = compact ? 8 : 12;

    return (
      <div
        ref={ref}
        className={cn(
          'relative w-full shrink-0 overflow-hidden bg-bg-well shadow-[var(--shadow-tile)]',
          'rounded-[var(--radius-thumb)]',
          className,
        )}
        style={{ height, ...style }}
        {...props}
      >
        {/* The thumbnail's own lamp, matching the reference render's
            `radial-gradient(70% 120% at 20% 0%)`: an ellipse centred on the top
            edge, a fifth of the way across, so the glow hugs the top-left
            corner instead of washing the middle. */}
        {room.lit && (
          <Lamp style={{ left: '-50%', top: '-120%', width: '140%', height: '240%' }} />
        )}

        {room.thumbnail.live && frame ? (
          <FrameCanvas frame={frame} />
        ) : still ? (
          <img src={still} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : null}

        {room.lit ? (
          <>
            <LiveDot
              label={room.thumbnail.label}
              className="absolute max-w-[calc(100%-1rem)]"
              style={{ left: pad, top: pad }}
            />
            {showOccupants && occupants.length > 0 && (
              <AvatarStack
                people={occupants}
                size={compact ? 18 : 22}
                max={compact ? 3 : 4}
                context={`in ${room.name}`}
                className="absolute"
                style={compact ? { right: pad, bottom: pad } : { left: pad, bottom: pad }}
              />
            )}
            {action && (
              <span className="absolute" style={{ right: pad, bottom: pad }}>
                {action}
              </span>
            )}
          </>
        ) : (
          <span
            className="absolute truncate text-meta text-text-faint"
            style={{ left: pad, top: compact ? pad + 4 : pad }}
          >
            {darkRoomCaption(compact ? 'row' : 'card')}
          </span>
        )}
      </div>
    );
  },
);

/**
 * Paints one sampled `ImageBitmap`. A bitmap is transferable and must be closed
 * by its owner; the tap hands ownership to the caller, and this component only
 * reads it — so it never closes a frame it did not create.
 */
function FrameCanvas({ frame }: { frame: RoomFrame }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(frame.bitmap, 0, 0);
  }, [frame]);
  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full object-cover"
      aria-hidden
    />
  );
}
