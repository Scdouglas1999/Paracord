import { useEffect, useRef, useState } from 'react';
import { Track, RoomEvent, type RemoteTrackPublication } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';
import { VideoOff } from 'lucide-react';

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

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        borderColor: isSpeaking ? 'var(--accent-success)' : undefined,
        boxShadow: isSpeaking ? '0 0 12px rgba(34, 197, 94, 0.3)' : 'none',
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
        <div className="flex h-full w-full items-center justify-center" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
          <div className="flex flex-col items-center gap-3">
            <VideoOff size={28} className="text-text-muted" />
            <span className="text-sm text-text-muted">No camera track</span>
          </div>
        </div>
      )}
      {/* Name badge */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1 backdrop-blur-sm">
        {isSpeaking && (
          <div className="h-2 w-2 rounded-full bg-accent-success animate-pulse" />
        )}
        <span className="text-xs font-medium text-white">{username}</span>
      </div>
    </div>
  );
}
