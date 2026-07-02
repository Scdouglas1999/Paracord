import { useEffect } from 'react';
import { Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';

/**
 * Centralized screen share subscription management.
 * Subscribes to ScreenShare + ScreenShareAudio for each user in `userIds`,
 * and unsubscribes everyone else.
 *
 * Pass `null` to disable (no-op) — used when not in Side mode so StreamViewer
 * can manage its own subscriptions without interference.
 */
export function useScreenShareSubscriptions(userIds: Set<string> | null): void {
  const room = useVoiceStore((s) => s.room);

  useEffect(() => {
    if (!room || userIds === null) return;

    for (const participant of room.remoteParticipants.values()) {
      const shouldSubscribe = userIds.has(participant.identity);

      for (const publication of participant.videoTrackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShare) continue;
        if (publication.isSubscribed !== shouldSubscribe) {
          publication.setSubscribed(shouldSubscribe);
        }
      }
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShareAudio) continue;
        if (publication.isSubscribed !== shouldSubscribe) {
          publication.setSubscribed(shouldSubscribe);
        }
      }
    }

    return () => {
      // On unmount while active, unsubscribe all screen shares
      if (!room) return;
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (publication.source !== Track.Source.ScreenShare) continue;
          if (publication.isSubscribed) {
            publication.setSubscribed(false);
          }
        }
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.source !== Track.Source.ScreenShareAudio) continue;
          if (publication.isSubscribed) {
            publication.setSubscribed(false);
          }
        }
      }
    };
  }, [room, userIds]);
}
