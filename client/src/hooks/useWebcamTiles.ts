import { useEffect, useState } from 'react';
import { Track, RoomEvent } from 'livekit-client';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { displayName } from '../lib/displayName';

export interface WebcamTile {
  participantId: string;
  username: string;
  isLocal: boolean;
}

/**
 * Tiles are recomputed on a 1s interval on the native path. Committing a fresh
 * array every tick gave every consumer a new reference each second, which made
 * downstream debounces that key on this value re-arm forever — the 1200ms
 * dead-stream cleanup in VoiceStageChannel could never fire, so stale panes
 * were never removed. Return the previous array when nothing actually changed.
 */
function sameTiles(a: WebcamTile[], b: WebcamTile[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].participantId !== b[i].participantId ||
      a[i].username !== b[i].username ||
      a[i].isLocal !== b[i].isLocal
    ) {
      return false;
    }
  }
  return true;
}

/** setState wrapper that preserves identity for an unchanged tile list. */
function commitTiles(
  setTiles: (updater: (prev: WebcamTile[]) => WebcamTile[]) => void,
  next: WebcamTile[],
): void {
  setTiles((prev) => (sameTiles(prev, next) ? prev : next));
}

/**
 * Returns the list of participants with active camera tracks.
 * Extracted from VideoGrid's recompute logic so multiple components
 * (VideoGrid, SplitPaneSourcePicker) can share the same data.
 *
 * Supports both LiveKit (`room`) and native/browser MediaEngine paths.
 */
export function useWebcamTiles(): WebcamTile[] {
  const room = useVoiceStore((s) => s.room);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const connected = useVoiceStore((s) => s.connected);
  const selfVideo = useVoiceStore((s) => s.selfVideo);
  const participants = useVoiceStore((s) => s.participants);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const [tiles, setTiles] = useState<WebcamTile[]>([]);

  // LiveKit path
  useEffect(() => {
    if (!room || !connected) {
      return;
    }

    const recompute = () => {
      const next: WebcamTile[] = [];

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

      commitTiles(setTiles, next);
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

    return () => {
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

  // Native / browser MediaEngine path — derive camera tiles from voice state
  // plus published camera tracks when available.
  useEffect(() => {
    if (room || !mediaEngine || !connected) {
      if (!room && !mediaEngine) {
        commitTiles(setTiles, []);
      }
      return;
    }

    let cancelled = false;

    const recompute = async () => {
      const next: WebcamTile[] = [];
      const seen = new Set<string>();

      if (selfVideo && currentUserId) {
        next.push({
          participantId: currentUserId,
          username: 'You',
          isLocal: true,
        });
        seen.add(currentUserId);
      }

      for (const [userId, vs] of participants) {
        if (!vs.self_video || seen.has(userId)) continue;
        if (currentUserId != null && userId === currentUserId) continue;
        next.push({
          participantId: userId,
          username: displayName(vs) || `User ${userId.slice(0, 6)}`,
          isLocal: false,
        });
        seen.add(userId);
      }

      // Supplement with published camera tracks (covers peers whose gateway
      // self_video flag is briefly stale after a track_publish).
      try {
        const tracks = await mediaEngine.listPublishedTracks();
        if (cancelled) return;
        for (const track of tracks) {
          if (track.kind !== 'video' || track.trackId !== 'camera') continue;
          const userId = String(track.publisherUserId);
          if (seen.has(userId)) continue;
          if (currentUserId != null && userId === currentUserId) continue;
          const vs = participants.get(userId);
          next.push({
            participantId: userId,
            username: (vs ? displayName(vs) : null) || `User ${userId.slice(0, 6)}`,
            isLocal: false,
          });
          seen.add(userId);
        }
      } catch {
        // listPublishedTracks can fail during reconnect; voice-state tiles still work.
      }

      if (!cancelled) {
        commitTiles(setTiles, next);
      }
    };

    void recompute();
    const interval = setInterval(() => {
      void recompute();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [room, mediaEngine, connected, selfVideo, participants, currentUserId]);

  return tiles;
}
