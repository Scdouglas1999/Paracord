import { useCallback, useState } from 'react';

import { SpeakerGrid, StageTile, type SpeakerArrangement } from './stage';
import { CameraSurface } from './CameraSurface';
import { Button } from '../ui';
import { useWebcamTiles } from '../../hooks/useWebcamTiles';
import { cn } from '../../lib/utils';
import type { RoomOccupant } from '../../lib/attention/light';

export type SpeakerArrangementMode = SpeakerArrangement | 'pip';

export interface StageSpeakersProps {
  /**
   * Everybody in the room right now, already ordered speakers → sharers → name
   * by `RoomLight` (WP1). The Stage never re-derives who is here.
   */
  occupants: readonly RoomOccupant[];
  currentUserId: string | null;
  /** `strip` under a share, `grid` when nobody shares, `pip` over a full tile. */
  arrangement?: SpeakerArrangementMode;
  /** Phone: two columns, tighter gaps. */
  compact?: boolean;
  /** Watch somebody's share. Their tile carries the action while they share. */
  onWatch?: (userId: string) => void;
  /** Whose share is already on the dominant tile. */
  watchingUserId?: string | null;
  className?: string;
}

/**
 * StageSpeakers — one tile per person in the room
 * (docs/lantern-stage-spec.md §7.2).
 *
 * The people come from the room's light; the frames come from the media engine
 * through `useWebcamTiles`. Somebody with their camera off is their initials on
 * a dark tile, never a silhouette (§6.4), and the ring only breathes while they
 * are actually talking (§5).
 */
export function StageSpeakers({
  occupants,
  currentUserId,
  arrangement = 'strip',
  compact = false,
  onWatch,
  watchingUserId = null,
  className,
}: StageSpeakersProps) {
  const webcamTiles = useWebcamTiles();
  const [liveTiles, setLiveTiles] = useState<ReadonlySet<string>>(() => new Set());

  const markLive = useCallback((participantId: string, live: boolean) => {
    setLiveTiles((prev) => {
      if (prev.has(participantId) === live) return prev;
      const next = new Set(prev);
      if (live) next.add(participantId);
      else next.delete(participantId);
      return next;
    });
  }, []);

  if (occupants.length === 0) return null;

  const pip = arrangement === 'pip';

  const renderTile = (occupant: RoomOccupant) => {
    const userId = occupant.person.userId;
    const isMe = currentUserId != null && userId === currentUserId;
    const webcam = webcamTiles.find((tile) => tile.participantId === userId);
    const offerWatch = Boolean(
      occupant.sharingScreen && onWatch && !pip && userId !== watchingUserId,
    );
    return (
      <StageTile
        className="h-full w-full"
        person={occupant.person}
        name={isMe ? 'You' : occupant.person.name}
        speaking={occupant.speaking}
        muted={occupant.muted}
        live={liveTiles.has(userId)}
        avatarSize={pip ? 34 : 44}
        style={arrangement === 'grid' ? { aspectRatio: '16 / 9' } : undefined}
        actions={
          offerWatch ? (
            <Button size="sm" variant="light" onClick={() => onWatch?.(userId)}>
              Watch
            </Button>
          ) : undefined
        }
      >
        {webcam && (
          <CameraSurface
            participantId={webcam.participantId}
            isLocal={webcam.isLocal}
            onTrackChange={(live) => markLive(userId, live)}
          />
        )}
      </StageTile>
    );
  };

  if (pip) {
    return (
      <ul
        className={cn(
          'pc-floating flex list-none gap-1.5 rounded-[var(--radius-well)] p-1.5',
          className,
        )}
        aria-label="People in this room"
      >
        {occupants.map((occupant) => (
          <li
            key={occupant.person.userId}
            className="shrink-0"
            style={{ width: compact ? 112 : 148, height: compact ? 68 : 88 }}
          >
            {renderTile(occupant)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SpeakerGrid
      arrangement={arrangement}
      compact={compact}
      count={occupants.length}
      aria-label="People in this room"
      className={cn(arrangement === 'strip' && 'h-full', className)}
    >
      {occupants.map((occupant) => (
        <li key={occupant.person.userId} className="min-h-0 min-w-0">
          {renderTile(occupant)}
        </li>
      ))}
    </SpeakerGrid>
  );
}
