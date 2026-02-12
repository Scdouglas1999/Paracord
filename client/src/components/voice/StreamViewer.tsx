import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Maximize,
  Minimize,
  Volume2,
  VolumeX,
  Monitor,
  MonitorOff,
  Eye,
  EyeOff,
  Signal,
  X,
} from 'lucide-react';
import { RoomEvent, Track, VideoQuality } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';

interface StreamViewerProps {
  streamerId: string;
  streamerName?: string;
  expectingStream?: boolean;
  onStopStream?: () => void;
  onStopWatching?: () => void;
}

export function StreamViewer({
  streamerId,
  streamerName,
  expectingStream = false,
  onStopStream,
  onStopWatching,
}: StreamViewerProps) {
  const [isMuted, setIsMuted] = useState(false);
  const [activeStreamerName, setActiveStreamerName] = useState<string | null>(null);
  const [hasActiveTrack, setHasActiveTrack] = useState(false);
  const [isOwnStream, setIsOwnStream] = useState(false);
  const [hideSelfPreview, setHideSelfPreview] = useState(false);
  const [quality, setQuality] = useState<
    'auto' | 'low' | 'medium' | 'high' | 'source'
  >('auto');
  const [isMaximized, setIsMaximized] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const room = useVoiceStore((s) => s.room);
  const selfStream = useVoiceStore((s) => s.selfStream);
  const previewStreamerId = useVoiceStore((s) => s.previewStreamerId);
  const localUserId = useAuthStore((s) => s.user?.id ?? null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamStartTime = useRef<number>(Date.now());
  const screenShareAudioRef = useRef<HTMLAudioElement | null>(null);

  const displayName = streamerName ?? activeStreamerName ?? 'Someone';

  // Elapsed time counter
  useEffect(() => {
    if (!hasActiveTrack && !expectingStream) return;
    streamStartTime.current = Date.now();
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - streamStartTime.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [hasActiveTrack, expectingStream]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // Escape key exits maximized mode
  useEffect(() => {
    if (!isMaximized) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isMaximized]);

  // Clean up screen share audio element
  const cleanupScreenShareAudio = useCallback(() => {
    const audioEl = screenShareAudioRef.current;
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
      screenShareAudioRef.current = null;
    }
  }, []);

  // Use a ref to track mute state so attachTrack can read the current value
  // without needing isMuted in its dependency array (avoiding re-attaching
  // all tracks just because the user toggled mute).
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;

  const setScreenShareSubscriptions = useCallback(
    (targetIdentities: Set<string>) => {
      if (!room) return;
      for (const participant of room.remoteParticipants.values()) {
        const shouldSubscribe = targetIdentities.has(participant.identity);
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
    },
    [room]
  );

  // Attach selected streamer's video track and screen share audio track.
  const attachTrack = useCallback(() => {
    const videoEl = videoRef.current;
    if (!room || !videoEl || !streamerId) return;

    const subscribedStreamers = new Set<string>();
    if (streamerId !== localUserId) {
      subscribedStreamers.add(streamerId);
    }
    if (
      previewStreamerId &&
      previewStreamerId !== localUserId &&
      previewStreamerId !== streamerId
    ) {
      subscribedStreamers.add(previewStreamerId);
    }
    setScreenShareSubscriptions(subscribedStreamers);

    let foundVideoTrack: MediaStreamTrack | null = null;
    let foundAudioTrack: MediaStreamTrack | null = null;
    let foundStreamer: string | null = null;
    const watchingSelf = localUserId != null && streamerId === localUserId;

    if (watchingSelf) {
      for (const publication of room.localParticipant.videoTrackPublications.values()) {
        if (
          publication.source === Track.Source.ScreenShare &&
          publication.track &&
          publication.track.mediaStreamTrack?.readyState !== 'ended'
        ) {
          foundVideoTrack = publication.track.mediaStreamTrack;
          foundStreamer = 'You';
          break;
        }
      }
    } else {
      const participant = room.remoteParticipants.get(streamerId);
      if (participant) {
        foundStreamer = participant.name || participant.identity;
        for (const publication of participant.videoTrackPublications.values()) {
          if (
            publication.source === Track.Source.ScreenShare &&
            publication.track &&
            publication.track.mediaStreamTrack?.readyState !== 'ended'
          ) {
            if (quality !== 'auto') {
              if (quality === 'low') publication.setVideoQuality(VideoQuality.LOW);
              if (quality === 'medium') publication.setVideoQuality(VideoQuality.MEDIUM);
              if (quality === 'high' || quality === 'source') {
                publication.setVideoQuality(VideoQuality.HIGH);
              }
            }
            foundVideoTrack = publication.track.mediaStreamTrack;
            break;
          }
        }
        for (const publication of participant.audioTrackPublications.values()) {
          if (
            publication.source === Track.Source.ScreenShareAudio &&
            publication.track
          ) {
            if (!publication.isSubscribed) {
              publication.setSubscribed(true);
            }
            foundAudioTrack = publication.track.mediaStreamTrack;
            break;
          }
        }
      }
    }

    if (foundVideoTrack && !(watchingSelf && hideSelfPreview)) {
      // Only reassign srcObject when the track actually changes to avoid
      // black frame flashing from unnecessary MediaStream recreation.
      const currentStream = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
      const currentTrack = currentStream?.getVideoTracks()[0] ?? null;
      if (currentTrack !== foundVideoTrack) {
        const stream = new MediaStream([foundVideoTrack]);
        videoEl.srcObject = stream;
        videoEl.play().catch(() => {});
      }
    } else {
      videoEl.srcObject = null;
    }

    if (foundAudioTrack && !watchingSelf) {
      let audioEl = screenShareAudioRef.current;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        audioEl.setAttribute('data-paracord-stream-audio', 'true');
        document.body.appendChild(audioEl);
        screenShareAudioRef.current = audioEl;
      }
      // Only reassign when the audio track actually changes.
      const currentAudioStream = audioEl.srcObject instanceof MediaStream ? audioEl.srcObject : null;
      const currentAudioTrack = currentAudioStream?.getAudioTracks()[0] ?? null;
      if (currentAudioTrack !== foundAudioTrack) {
        const audioStream = new MediaStream([foundAudioTrack]);
        audioEl.srcObject = audioStream;
        audioEl.muted = isMutedRef.current;
        audioEl.play().catch(() => {
          const resumeOnGesture = () => {
            audioEl?.play().catch(() => {});
            document.removeEventListener('click', resumeOnGesture);
            document.removeEventListener('keydown', resumeOnGesture);
          };
          document.addEventListener('click', resumeOnGesture, { once: true });
          document.addEventListener('keydown', resumeOnGesture, { once: true });
        });
      }
    } else {
      cleanupScreenShareAudio();
    }

    setHasActiveTrack(Boolean(foundVideoTrack));
    setActiveStreamerName(foundStreamer);
    setIsOwnStream(watchingSelf);
  }, [
    room,
    streamerId,
    localUserId,
    previewStreamerId,
    quality,
    hideSelfPreview,
    cleanupScreenShareAudio,
    setScreenShareSubscriptions,
  ]);

  useEffect(() => {
    if (!room) return;

    attachTrack();
    room.on(RoomEvent.TrackSubscribed, attachTrack);
    room.on(RoomEvent.TrackUnsubscribed, attachTrack);
    room.on(RoomEvent.TrackPublished, attachTrack);
    room.on(RoomEvent.TrackUnpublished, attachTrack);
    room.on(RoomEvent.TrackMuted, attachTrack);
    room.on(RoomEvent.TrackUnmuted, attachTrack);
    room.on(RoomEvent.ParticipantConnected, attachTrack);
    room.on(RoomEvent.ParticipantDisconnected, attachTrack);
    room.on(RoomEvent.LocalTrackPublished, attachTrack);
    room.on(RoomEvent.LocalTrackUnpublished, attachTrack);

    const pollInterval = setInterval(attachTrack, 2000);

    return () => {
      clearInterval(pollInterval);
      room.off(RoomEvent.TrackSubscribed, attachTrack);
      room.off(RoomEvent.TrackUnsubscribed, attachTrack);
      room.off(RoomEvent.TrackPublished, attachTrack);
      room.off(RoomEvent.TrackUnpublished, attachTrack);
      room.off(RoomEvent.TrackMuted, attachTrack);
      room.off(RoomEvent.TrackUnmuted, attachTrack);
      room.off(RoomEvent.ParticipantConnected, attachTrack);
      room.off(RoomEvent.ParticipantDisconnected, attachTrack);
      room.off(RoomEvent.LocalTrackPublished, attachTrack);
      room.off(RoomEvent.LocalTrackUnpublished, attachTrack);
      setHasActiveTrack(false);
      const videoEl = videoRef.current;
      if (videoEl) videoEl.srcObject = null;
      cleanupScreenShareAudio();
      setScreenShareSubscriptions(new Set<string>());
    };
  }, [room, attachTrack, cleanupScreenShareAudio, setScreenShareSubscriptions]);

  const toggleMaximized = () => setIsMaximized((prev) => !prev);

  const showVideo = hasActiveTrack && !(isOwnStream && hideSelfPreview);

  return (
    <div
      ref={containerRef}
      className={
        isMaximized
          ? 'fixed inset-0 z-50 flex flex-col overflow-hidden'
          : 'relative flex h-full w-full flex-col overflow-hidden'
      }
      style={{ backgroundColor: 'var(--bg-tertiary)' }}
    >
      <div
        className="relative z-10 flex items-center justify-between gap-3 px-5 py-3"
        style={{
          backgroundColor: 'var(--bg-floating)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="min-w-0 flex items-center gap-3">
          <div className="flex items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--accent-danger) 24%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent-danger) 45%, transparent)',
            }}>
            <Signal size={12} style={{ color: 'var(--accent-danger)' }} className="animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-danger)' }}>
              Live
            </span>
          </div>
          <span className="truncate text-[15px] font-semibold text-text-primary">
            {displayName}
            {displayName !== 'You' && "'s stream"}
          </span>
          <span className="text-sm font-mono text-text-muted">
            {formatTime(elapsedSeconds)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {!isOwnStream && (
            <select
              value={quality}
              onChange={(e) =>
                setQuality(
                  e.target.value as 'auto' | 'low' | 'medium' | 'high' | 'source'
                )
              }
              className="h-9 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-sm font-medium text-text-secondary outline-none transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              title="Viewing quality"
            >
              <option value="auto">Auto</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="source">Source</option>
            </select>
          )}

          <button
            onClick={() => {
              setIsMuted((prev) => {
                const nextMuted = !prev;
                const audioEl = screenShareAudioRef.current;
                if (audioEl) {
                  audioEl.muted = nextMuted;
                }
                return nextMuted;
              });
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>

          {isOwnStream && (
            <button
              onClick={() => setHideSelfPreview((prev) => !prev)}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              title={hideSelfPreview ? 'Show your stream preview' : 'Hide your stream preview (saves resources)'}
            >
              {hideSelfPreview ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}

          <button
            onClick={toggleMaximized}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>

          {onStopWatching && (
            <button
              onClick={onStopWatching}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              title="Stop watching"
            >
              <X size={16} />
            </button>
          )}

          {(selfStream || isOwnStream) && onStopStream && (
            <button
              onClick={onStopStream}
              className="ml-1 flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/18"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--accent-danger) 14%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-danger) 38%, transparent)',
              }}
              title="Stop streaming"
            >
              <MonitorOff size={15} />
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          autoPlay
          playsInline
          muted={isMuted}
          style={{
            backgroundColor: 'var(--bg-tertiary)',
            opacity: showVideo ? 1 : 0,
            position: showVideo ? 'relative' : 'absolute',
          }}
        />

        {!showVideo && (
          <div className="absolute inset-0 flex items-center justify-center"
            style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <div className="flex flex-col items-center gap-4">
              {isOwnStream && hideSelfPreview ? (
                <>
                  <div
                    className="flex h-20 w-20 items-center justify-center rounded-2xl"
                    style={{
                      background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))',
                      boxShadow: '0 12px 40px color-mix(in srgb, var(--accent-primary) 35%, transparent)',
                    }}
                  >
                    <Monitor size={32} className="text-white" />
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-text-primary">
                      Stream preview hidden
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      Your stream is still live. Others can see it.
                    </div>
                  </div>
                </>
              ) : expectingStream ? (
                <>
                  <div className="relative flex h-20 w-20 items-center justify-center">
                    <div
                      className="absolute inset-0 animate-spin rounded-full"
                      style={{
                        border: '2px solid transparent',
                        borderTopColor: 'var(--accent-primary)',
                        borderRightColor: 'var(--accent-primary)',
                      }}
                    />
                    <div
                      className="flex h-16 w-16 items-center justify-center rounded-full"
                      style={{
                        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))',
                      }}
                    >
                      <Monitor size={26} className="text-white" />
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-text-primary">
                      Starting stream...
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      Connecting to the media server
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="flex h-20 w-20 items-center justify-center rounded-2xl"
                    style={{
                      backgroundColor: 'var(--bg-mod-subtle)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <Monitor size={28} className="text-text-muted" />
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-text-secondary">
                      Stream is not available
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      {displayName} is not currently publishing a stream track.
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
