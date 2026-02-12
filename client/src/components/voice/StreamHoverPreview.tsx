import { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { RoomEvent, Track } from 'livekit-client';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';

interface StreamHoverPreviewProps {
  streamerId: string;
  streamerName: string;
}

export function StreamHoverPreview({ streamerId, streamerName }: StreamHoverPreviewProps) {
  const room = useVoiceStore((s) => s.room);
  const watchedStreamerId = useVoiceStore((s) => s.watchedStreamerId);
  const localUserId = useAuthStore((s) => s.user?.id ?? null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasTrack, setHasTrack] = useState(false);

  const attachPreview = useCallback(() => {
    const videoEl = videoRef.current;
    if (!room || !videoEl) return;

    let foundTrack: MediaStreamTrack | null = null;
    const watchingSelf = localUserId != null && streamerId === localUserId;

    if (watchingSelf) {
      for (const publication of room.localParticipant.videoTrackPublications.values()) {
        if (
          publication.source === Track.Source.ScreenShare &&
          publication.track &&
          publication.track.mediaStreamTrack?.readyState !== 'ended'
        ) {
          foundTrack = publication.track.mediaStreamTrack;
          break;
        }
      }
    } else {
      const participant = room.remoteParticipants.get(streamerId);
      if (participant) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (publication.source !== Track.Source.ScreenShare) continue;
          if (!publication.isSubscribed) {
            publication.setSubscribed(true);
          }
          if (
            publication.track &&
            publication.track.mediaStreamTrack?.readyState !== 'ended'
          ) {
            foundTrack = publication.track.mediaStreamTrack;
            break;
          }
        }
      }
    }

    if (foundTrack) {
      const stream = new MediaStream([foundTrack]);
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
      setHasTrack(true);
    } else {
      videoEl.srcObject = null;
      setHasTrack(false);
    }
  }, [room, streamerId, localUserId]);

  useEffect(() => {
    if (!room) return;

    attachPreview();
    room.on(RoomEvent.TrackSubscribed, attachPreview);
    room.on(RoomEvent.TrackUnsubscribed, attachPreview);
    room.on(RoomEvent.TrackPublished, attachPreview);
    room.on(RoomEvent.TrackUnpublished, attachPreview);
    room.on(RoomEvent.LocalTrackPublished, attachPreview);
    room.on(RoomEvent.LocalTrackUnpublished, attachPreview);

    return () => {
      room.off(RoomEvent.TrackSubscribed, attachPreview);
      room.off(RoomEvent.TrackUnsubscribed, attachPreview);
      room.off(RoomEvent.TrackPublished, attachPreview);
      room.off(RoomEvent.TrackUnpublished, attachPreview);
      room.off(RoomEvent.LocalTrackPublished, attachPreview);
      room.off(RoomEvent.LocalTrackUnpublished, attachPreview);
      if (
        localUserId == null ||
        streamerId !== localUserId
      ) {
        const participant = room.remoteParticipants.get(streamerId);
        if (participant && watchedStreamerId !== streamerId) {
          for (const publication of participant.videoTrackPublications.values()) {
            if (
              publication.source === Track.Source.ScreenShare &&
              publication.isSubscribed
            ) {
              publication.setSubscribed(false);
            }
          }
        }
      }
      const videoEl = videoRef.current;
      if (videoEl) videoEl.srcObject = null;
    };
  }, [room, attachPreview, streamerId, localUserId, watchedStreamerId]);

  return (
    <div className="w-[260px] overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary shadow-2xl">
      <div className="border-b border-border-subtle px-3 py-2 text-xs font-semibold text-text-primary">
        {streamerName}'s stream
      </div>
      <div className="relative h-[146px] bg-bg-tertiary">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline autoPlay />
        {!hasTrack && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted">
            <Monitor size={18} />
            <span className="text-xs">Preparing preview...</span>
          </div>
        )}
      </div>
    </div>
  );
}
