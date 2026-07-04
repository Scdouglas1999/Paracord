import { useEffect, useRef, useState } from 'react';
import { Track, RoomEvent, type RemoteTrackPublication } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';

interface FocusedWebcamViewProps {
  participantId: string;
  username: string;
  isLocal: boolean;
}

/**
 * Renders a single participant's webcam filling its container.
 * Extracted from VideoGrid's VideoTileView pattern for use in split panes.
 */
export function FocusedWebcamView({ participantId, username, isLocal }: FocusedWebcamViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const room = useVoiceStore((s) => s.room);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const [hasTrack, setHasTrack] = useState(false);

  const isSpeaking = speakingUsers.has(participantId);

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

      if (isLocal) {
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
        const participant = room.remoteParticipants.get(participantId);
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
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [room, participantId, isLocal]);

  const initial = username.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-bg-tertiary transition-shadow duration-[var(--duration-normal)] ease-[var(--ease-out)]"
      style={{
        // Speaking = an emerald inset ring on the spotlight, never a color wash.
        boxShadow: isSpeaking ? 'inset 0 0 0 2px var(--accent-primary)' : 'none',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="h-full w-full object-cover"
        style={{
          transform: isLocal ? 'scaleX(-1)' : undefined,
          display: hasTrack ? 'block' : 'none',
        }}
      />
      {!hasTrack && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg-secondary">
          <div
            className="flex items-center justify-center rounded-full border border-border-subtle bg-bg-accent text-2xl font-semibold text-text-secondary"
            style={{ height: 84, width: 84 }}
            aria-hidden
          >
            {initial}
          </div>
          <span className="text-label text-text-muted">{username}&rsquo;s camera is off</span>
        </div>
      )}
      {/* Name pill — floating surface + meta type (design-spec §7). */}
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-sm bg-bg-floating px-2.5 py-1 backdrop-blur-md">
        {isSpeaking && <span className="h-1.5 w-1.5 rounded-full bg-accent-primary" />}
        <span className="text-meta font-semibold text-text-primary">{username}</span>
      </div>
    </div>
  );
}
