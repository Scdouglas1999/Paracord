import { useEffect, useRef, useState } from 'react';
import { Track, RoomEvent, type RemoteTrackPublication } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { Maximize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useWebcamTiles, type WebcamTile } from '../../hooks/useWebcamTiles';

/** Circular initial-avatar shown when a participant's camera is off. */
function TileAvatar({ name, size }: { name: string; size: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className="flex flex-shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-accent font-semibold text-text-secondary"
      style={{ height: size, width: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {initial}
    </div>
  );
}

export type VideoGridLayout = 'grid' | 'compact' | 'sidebar' | 'pip';

export function VideoGrid({ layout = 'grid' }: { layout?: VideoGridLayout }) {
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const tiles = useWebcamTiles();
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 640px)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 640px)');
    const updateIsNarrow = () => setIsNarrow(mediaQuery.matches);
    updateIsNarrow();
    mediaQuery.addEventListener('change', updateIsNarrow);
    return () => mediaQuery.removeEventListener('change', updateIsNarrow);
  }, []);

  if (tiles.length === 0) return null;

  if (layout === 'compact') {
    return (
      <div className="flex shrink-0 gap-2 overflow-x-auto px-1" style={{ maxHeight: isNarrow ? '96px' : '120px' }}>
        {tiles.map((tile) => (
          <VideoTileView
            key={tile.participantId}
            tile={tile}
            isSpeaking={speakingUsers.has(tile.participantId)}
            currentUserId={currentUserId}
            compact
            compactSize={isNarrow ? 'small' : 'default'}
          />
        ))}
      </div>
    );
  }

  if (layout === 'sidebar') {
    return (
      <div className="flex h-full flex-col gap-2 p-1">
        {tiles.map((tile) => (
          <div key={tile.participantId} className="min-h-0 flex-1">
            <VideoTileView
              tile={tile}
              isSpeaking={speakingUsers.has(tile.participantId)}
              currentUserId={currentUserId}
              fill
            />
          </div>
        ))}
      </div>
    );
  }

  if (layout === 'pip') {
    return (
      <div className="flex gap-1.5 rounded-md border border-border-subtle bg-bg-floating p-1.5 shadow-md backdrop-blur-md">
        {tiles.map((tile) => (
          <VideoTileView
            key={tile.participantId}
            tile={tile}
            isSpeaking={speakingUsers.has(tile.participantId)}
            currentUserId={currentUserId}
            compact
            compactSize={isNarrow ? 'small' : 'default'}
          />
        ))}
      </div>
    );
  }

  // Grid layout: 1 tile = full, 2 = side by side, 3-4 = 2x2, etc.
  const cols = isNarrow ? 1 : (tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : 3);

  return (
    <div
      className="grid gap-2 p-2"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        maxHeight: tiles.length <= 2 ? (isNarrow ? '220px' : '280px') : (isNarrow ? '320px' : '400px'),
      }}
    >
      {tiles.map((tile) => (
        <VideoTileView
          key={tile.participantId}
          tile={tile}
          isSpeaking={speakingUsers.has(tile.participantId)}
          currentUserId={currentUserId}
        />
      ))}
    </div>
  );
}

function VideoTileView({
  tile,
  isSpeaking,
  currentUserId,
  compact = false,
  fill = false,
  compactSize = 'default',
}: {
  tile: WebcamTile;
  isSpeaking: boolean;
  currentUserId: string | null;
  compact?: boolean;
  fill?: boolean;
  compactSize?: 'default' | 'small';
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const room = useVoiceStore((s) => s.room);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const [hasTrack, setHasTrack] = useState(false);

  // LiveKit path
  useEffect(() => {
    if (!room || !videoRef.current) return;

    let trackEndedCleanup: (() => void) | null = null;

    const attachTrack = () => {
      const el = videoRef.current;
      if (!el) return;

      if (trackEndedCleanup) {
        trackEndedCleanup();
        trackEndedCleanup = null;
      }

      let mediaTrack: MediaStreamTrack | null = null;

      if (tile.isLocal) {
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        const track = pub?.track;
        if (track && track.mediaStreamTrack && !pub?.isMuted) {
          mediaTrack = track.mediaStreamTrack;
          const stream = new MediaStream([track.mediaStreamTrack]);
          el.srcObject = stream;
          el.muted = true;
          void el.play().catch(() => {});
          setHasTrack(true);
        } else {
          setHasTrack(false);
        }
      } else {
        const participant = room.remoteParticipants.get(tile.participantId);
        if (!participant) {
          setHasTrack(false);
          return;
        }
        let cameraTrack: RemoteTrackPublication | null = null;
        for (const pub of participant.videoTrackPublications.values()) {
          if (pub.source === Track.Source.Camera && !pub.isMuted && pub.track) {
            cameraTrack = pub;
            break;
          }
        }
        if (cameraTrack?.track) {
          mediaTrack = cameraTrack.track.mediaStreamTrack ?? null;
          cameraTrack.track.attach(el);
          setHasTrack(true);
        } else {
          setHasTrack(false);
        }
      }

      if (mediaTrack) {
        const onEnded = () => {
          setHasTrack(false);
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
        };
        mediaTrack.addEventListener('ended', onEnded);
        trackEndedCleanup = () => {
          mediaTrack!.removeEventListener('ended', onEnded);
        };
      }
    };

    attachTrack();

    room.on(RoomEvent.TrackSubscribed, attachTrack);
    room.on(RoomEvent.TrackUnsubscribed, attachTrack);
    room.on(RoomEvent.LocalTrackPublished, attachTrack);
    room.on(RoomEvent.LocalTrackUnpublished, attachTrack);

    return () => {
      room.off(RoomEvent.TrackSubscribed, attachTrack);
      room.off(RoomEvent.TrackUnsubscribed, attachTrack);
      room.off(RoomEvent.LocalTrackPublished, attachTrack);
      room.off(RoomEvent.LocalTrackUnpublished, attachTrack);
      if (trackEndedCleanup) {
        trackEndedCleanup();
        trackEndedCleanup = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [room, tile.participantId, tile.isLocal]);

  // Native / browser MediaEngine path — canvas subscription for camera tracks.
  useEffect(() => {
    if (room || !mediaEngine || !canvasRef.current) return;
    const canvas = canvasRef.current;
    let sawFrame = false;
    const onFrame = () => {
      if (!sawFrame) {
        sawFrame = true;
        setHasTrack(true);
      }
    };

    const unsubscribe = mediaEngine.subscribeVideo(
      tile.participantId,
      canvas,
      onFrame,
      { preferredTrackId: 'camera' },
    );

    return () => {
      unsubscribe();
      if (!sawFrame) {
        setHasTrack(false);
      }
    };
  }, [room, mediaEngine, tile.participantId]);

  const isMe = currentUserId != null && tile.participantId === currentUserId;
  const displayName = isMe ? 'You' : tile.username;
  const useCanvas = !room && Boolean(mediaEngine);

  const requestFullscreen = () => {
    const el = containerRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
  };

  return (
    <div
      ref={containerRef}
      className="group relative overflow-hidden rounded-md bg-bg-tertiary transition-shadow duration-[var(--duration-normal)] ease-[var(--ease-out)]"
      style={{
        boxShadow: isSpeaking
          ? 'inset 0 0 0 2px var(--accent-primary), var(--shadow-sm)'
          : 'inset 0 0 0 1px var(--border-subtle), var(--shadow-sm)',
        ...(fill
          ? { height: '100%', width: '100%' }
          : {
              aspectRatio: '16 / 9',
              ...(compact
                ? compactSize === 'small'
                  ? { height: '82px', width: '132px', flexShrink: 0 }
                  : { height: '100px', width: '178px', flexShrink: 0 }
                : {}),
            }),
      }}
    >
      {useCanvas ? (
        <canvas
          ref={canvasRef}
          className="h-full w-full object-cover"
          style={{
            transform: tile.isLocal ? 'scaleX(-1)' : undefined,
            display: hasTrack ? 'block' : 'none',
          }}
        />
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={tile.isLocal}
          className="h-full w-full object-cover"
          style={{
            transform: tile.isLocal ? 'scaleX(-1)' : undefined,
            display: hasTrack ? 'block' : 'none',
          }}
        />
      )}
      {!hasTrack && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-bg-secondary">
          <TileAvatar name={displayName} size={compact ? 34 : 56} />
          {!compact && <span className="text-meta text-text-muted">Camera off</span>}
        </div>
      )}

      {hasTrack && !compact && (
        <button
          type="button"
          onClick={requestFullscreen}
          aria-label={`Fullscreen ${displayName}'s video`}
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-sm bg-bg-floating text-interactive-normal opacity-0 shadow-sm outline-none backdrop-blur-md transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-interactive-hover focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Maximize2 size={15} />
        </button>
      )}

      <div
        className={cn(
          'absolute bottom-2 left-2 flex items-center gap-1.5 rounded-sm bg-bg-floating px-2 py-1 backdrop-blur-md',
          compact && 'bottom-1 left-1 gap-1 px-1.5 py-0.5',
        )}
      >
        {isSpeaking && <span className="h-1.5 w-1.5 rounded-full bg-accent-primary" />}
        <span className={cn('text-meta font-semibold text-text-primary', compact && 'text-[10px] leading-none')}>
          {displayName}
        </span>
      </div>
    </div>
  );
}
