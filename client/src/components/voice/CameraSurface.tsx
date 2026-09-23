import { useEffect, useRef, useState } from 'react';
import type { RemoteTrackPublication } from 'livekit-client';
import { livekit } from '../../stores/voice/livekitRuntime';

import { useVoiceStore } from '../../stores/voiceStore';
import { cn } from '../../lib/utils';

export interface CameraSurfaceProps {
  participantId: string;
  isLocal: boolean;
  /** Called whenever frames start or stop arriving, so the tile can swap to initials. */
  onTrackChange?: (hasTrack: boolean) => void;
  className?: string;
  /** `cover` fills a speaker tile; `contain` fits a dominant one. */
  fit?: 'cover' | 'contain';
}

/**
 * The camera surface for one participant — the `<video>` (LiveKit) or the
 * `<canvas>` (native / browser MediaEngine) and nothing else.
 *
 * This is the attach/subscribe logic that used to be duplicated in
 * `VideoGrid`'s tile and in `FocusedWebcamView`, moved verbatim so the two can
 * never drift. **The media contracts are unchanged**: the same publications are
 * attached and detached, the same `subscribeVideo` call is made with the same
 * `preferredTrackId`, and the same cleanup runs — see the
 * `native-streaming-pipeline` notes before touching any of it.
 *
 * It draws no chrome. The name tag, the speaking ring and the camera-off avatar
 * belong to `StageTile`, which wraps this.
 */
export function CameraSurface({
  participantId,
  isLocal,
  onTrackChange,
  className,
  fit = 'cover',
}: CameraSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const room = useVoiceStore((s) => s.room);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const [hasTrack, setHasTrack] = useState(false);

  // Report upward without making the callback a dependency of the media
  // effects: a caller that re-creates its handler must not re-attach a track.
  const reportRef = useRef(onTrackChange);
  reportRef.current = onTrackChange;
  useEffect(() => {
    reportRef.current?.(hasTrack);
  }, [hasTrack]);

  // LiveKit path.
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
        const pub = room.localParticipant.getTrackPublication(livekit().Track.Source.Camera);
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
          if (pub.source === livekit().Track.Source.Camera && !pub.isMuted && pub.track) {
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

    const { RoomEvent } = livekit();
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
      detachAttachedTrack();
      el.srcObject = null;
    };
  }, [room, participantId, isLocal]);

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

    const unsubscribe = mediaEngine.subscribeVideo(participantId, canvas, onFrame, {
      preferredTrackId: 'camera',
    });

    return () => {
      unsubscribe();
      if (!sawFrame) {
        setHasTrack(false);
      }
    };
  }, [room, mediaEngine, participantId]);

  const useCanvas = !room && Boolean(mediaEngine);
  const surfaceClass = cn(
    'h-full w-full',
    fit === 'cover' ? 'object-cover' : 'object-contain',
    className,
  );
  const surfaceStyle = {
    transform: isLocal ? 'scaleX(-1)' : undefined,
    display: hasTrack ? 'block' : 'none',
  } as const;

  return useCanvas ? (
    <canvas ref={canvasRef} className={surfaceClass} style={surfaceStyle} />
  ) : (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted // Camera track only; call audio is rendered separately by the voice engine.
      className={surfaceClass}
      style={surfaceStyle}
    />
  );
}
