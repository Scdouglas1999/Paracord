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
 * Supports LiveKit (`room`) and native/browser MediaEngine canvas paths.
 */
export function FocusedWebcamView({ participantId, username, isLocal }: FocusedWebcamViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const room = useVoiceStore((s) => s.room);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const [hasTrack, setHasTrack] = useState(false);

  const isSpeaking = speakingUsers.has(participantId);
  const useCanvas = !room && Boolean(mediaEngine);

  useEffect(() => {
    const el = videoRef.current;
    if (!room || !el) return;

    let trackEndedCleanup: (() => void) | null = null;
    // LiveKit's `attach()` registers the element on the track AND installs a
    // document `visibilitychange` listener. Nulling `srcObject` reverses
    // neither, so every layout switch leaked a registered element plus a
    // listener and left adaptive-stream sizing believing the tile was still
    // visible (defeating downscaling). Only `detach()` undoes it.
    let attachedTrack: { detach: (el: HTMLMediaElement) => unknown } | null = null;

    const detachAttachedTrack = () => {
      if (attachedTrack && el) {
        attachedTrack.detach(el);
      }
      attachedTrack = null;
    };

    const attachTrack = () => {
      if (trackEndedCleanup) {
        trackEndedCleanup();
        trackEndedCleanup = null;
      }
      // Re-running on a room event must not stack attachments.
      detachAttachedTrack();

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
          attachedTrack = cameraTrack.track;
          setHasTrack(true);
        } else {
          setHasTrack(false);
        }
      }

      if (mediaTrack) {
        const onEnded = () => {
          setHasTrack(false);
          el.srcObject = null;
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
      detachAttachedTrack();
      el.srcObject = null;
    };
  }, [room, participantId, isLocal]);

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
      participantId,
      canvas,
      onFrame,
      { preferredTrackId: 'camera' },
    );
    return () => {
      unsubscribe();
      if (!sawFrame) setHasTrack(false);
    };
  }, [room, mediaEngine, participantId]);

  const initial = username.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-bg-tertiary transition-shadow duration-[var(--duration-normal)] ease-[var(--ease-out)]"
      style={{
        boxShadow: isSpeaking ? 'inset 0 0 0 2px var(--accent-primary)' : 'none',
      }}
    >
      {useCanvas ? (
        <canvas
          ref={canvasRef}
          className="h-full w-full object-cover"
          style={{
            transform: isLocal ? 'scaleX(-1)' : undefined,
            display: hasTrack ? 'block' : 'none',
          }}
        />
      ) : (
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
      )}
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
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-sm bg-bg-floating px-2.5 py-1 backdrop-blur-md">
        {isSpeaking && <span className="h-1.5 w-1.5 rounded-full bg-accent-primary" />}
        <span className="text-meta font-semibold text-text-primary">{username}</span>
      </div>
    </div>
  );
}
