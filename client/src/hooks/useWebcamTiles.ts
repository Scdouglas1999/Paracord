import { useEffect, useState } from 'react';
import { Track, RoomEvent } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';

export interface WebcamTile {
  participantId: string;
  username: string;
  isLocal: boolean;
}

/**
 * Returns the list of participants with active camera tracks.
 * Extracted from VideoGrid's recompute logic so multiple components
 * (VideoGrid, SplitPaneSourcePicker) can share the same data.
 */
export function useWebcamTiles(): WebcamTile[] {
  const room = useVoiceStore((s) => s.room);
  const connected = useVoiceStore((s) => s.connected);
  const [tiles, setTiles] = useState<WebcamTile[]>([]);

  useEffect(() => {
    if (!room || !connected) {
      setTiles([]);
      return;
    }

    const recompute = () => {
      const next: WebcamTile[] = [];

      // Local participant
      for (const pub of room.localParticipant.videoTrackPublications.values()) {
        if (
          pub.source === Track.Source.Camera &&
          !pub.isMuted &&
          pub.track &&
          pub.track.mediaStreamTrack?.readyState !== 'ended'
        ) {
          next.push({
            participantId: room.localParticipant.identity,
            username: room.localParticipant.name || 'You',
            isLocal: true,
          });
          break;
        }
      }

      // Remote participants
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.videoTrackPublications.values()) {
          if (pub.source === Track.Source.Camera) {
            if (!pub.isSubscribed) {
              pub.setSubscribed(true);
            }
            if (!pub.isMuted && pub.track && pub.track.mediaStreamTrack?.readyState !== 'ended') {
              next.push({
                participantId: participant.identity,
                username: participant.name || `User ${participant.identity.slice(0, 6)}`,
                isLocal: false,
              });
              break;
            }
          }
        }
      }

      setTiles(next);
    };

    recompute();

    room.on(RoomEvent.TrackSubscribed, recompute);
    room.on(RoomEvent.TrackUnsubscribed, recompute);
    room.on(RoomEvent.TrackPublished, recompute);
    room.on(RoomEvent.TrackUnpublished, recompute);
    room.on(RoomEvent.TrackMuted, recompute);
    room.on(RoomEvent.TrackUnmuted, recompute);
    room.on(RoomEvent.ParticipantConnected, recompute);
    room.on(RoomEvent.ParticipantDisconnected, recompute);
    room.on(RoomEvent.LocalTrackPublished, recompute);
    room.on(RoomEvent.LocalTrackUnpublished, recompute);

    const pollInterval = setInterval(recompute, 2000);

    return () => {
      clearInterval(pollInterval);
      room.off(RoomEvent.TrackSubscribed, recompute);
      room.off(RoomEvent.TrackUnsubscribed, recompute);
      room.off(RoomEvent.TrackPublished, recompute);
      room.off(RoomEvent.TrackUnpublished, recompute);
      room.off(RoomEvent.TrackMuted, recompute);
      room.off(RoomEvent.TrackUnmuted, recompute);
      room.off(RoomEvent.ParticipantConnected, recompute);
      room.off(RoomEvent.ParticipantDisconnected, recompute);
      room.off(RoomEvent.LocalTrackPublished, recompute);
      room.off(RoomEvent.LocalTrackUnpublished, recompute);
    };
  }, [room, connected]);

  return tiles;
}
