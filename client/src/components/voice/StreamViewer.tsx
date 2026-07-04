import { useEffect, useRef, useState, useCallback } from 'react';
import {
  AlertTriangle,
  Maximize,
  Minimize,
  Volume1,
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
  issueMessage?: string | null;
  /** When true, skip managing screen share subscriptions (managed externally). */
  skipSubscriptionManagement?: boolean;
}

export function StreamViewer({
  streamerId,
  streamerName,
  expectingStream = false,
  onStopStream,
  onStopWatching,
  issueMessage = null,
  skipSubscriptionManagement = false,
}: StreamViewerProps) {
  const [volume, setVolume] = useState(1);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const isMuted = volume === 0;
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeStreamerName, setActiveStreamerName] = useState<string | null>(null);
  const [hasActiveTrack, setHasActiveTrack] = useState(false);
  const [isOwnStream, setIsOwnStream] = useState(false);
  const [hideSelfPreview, setHideSelfPreview] = useState(false);
  const [quality, setQuality] = useState<
    'auto' | 'low' | 'medium' | 'high' | 'source'
  >('auto');
  const [isMaximized, setIsMaximized] = useState(false);
  const [showIssueDetails, setShowIssueDetails] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isCompactLayout, setIsCompactLayout] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 640px)').matches;
  });
  const room = useVoiceStore((s) => s.room);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const selfStream = useVoiceStore((s) => s.selfStream);
  const systemAudioCaptureActive = useVoiceStore((s) => s.systemAudioCaptureActive);
  const showSystemAudioPrivacyWarning = useVoiceStore((s) => s.showSystemAudioPrivacyWarning);
  const acknowledgeSystemAudioPrivacyWarning = useVoiceStore(
    (s) => s.acknowledgeSystemAudioPrivacyWarning
  );
  const previewStreamerId = useVoiceStore((s) => s.previewStreamerId);
  const localUserId = useAuthStore((s) => s.user?.id ?? null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamStartTime = useRef<number>(Date.now());
  const screenShareAudioRef = useRef<HTMLAudioElement | null>(null);
  const subscriptionSignatureRef = useRef<string>('__init__');
  const lastMissingAudioWarningAtRef = useRef<number>(0);

  const displayName = streamerName ?? activeStreamerName ?? 'Someone';

  // Sync volume to the dedicated stream audio element whenever it changes.
  // The <video> element is muted (video-only); audio plays via a separate
  // hidden <audio> element managed by screenShareAudioRef.
  useEffect(() => {
    const audioEl = screenShareAudioRef.current;
    if (audioEl) audioEl.volume = volume;
  }, [volume]);

  const updateStreamVolume = useCallback((nextVolume: number) => {
    const clampedVolume = Math.min(1, Math.max(0, nextVolume));
    setVolume(clampedVolume);
    const audioEl = screenShareAudioRef.current;
    if (audioEl) audioEl.volume = clampedVolume;
    const videoEl = videoRef.current;
    if (videoEl) videoEl.volume = clampedVolume;
  }, []);

  // Stream audio plays on the default device. Process Loopback Exclusion
  // handles echo prevention at the OS level — no device rerouting needed.

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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 640px)');
    const updateCompactLayout = () => setIsCompactLayout(mediaQuery.matches);
    updateCompactLayout();
    mediaQuery.addEventListener('change', updateCompactLayout);
    return () => mediaQuery.removeEventListener('change', updateCompactLayout);
  }, []);

  useEffect(() => {
    if (!issueMessage) {
      setShowIssueDetails(false);
    }
  }, [issueMessage]);

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

  // Use a ref to track volume so attachTrack can read the current value
  // without needing volume in its dependency array (avoiding re-attaching
  // all tracks just because the user adjusted volume).
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  // Ref for skipSubscriptionManagement so attachTrack doesn't need it in deps
  const skipSubRef = useRef(skipSubscriptionManagement);
  skipSubRef.current = skipSubscriptionManagement;

  const setScreenShareSubscriptions = useCallback(
    (targetIdentities: Set<string>) => {
      if (!room) return;
      const signature = Array.from(targetIdentities).sort().join('|');
      if (signature === subscriptionSignatureRef.current) return;
      subscriptionSignatureRef.current = signature;
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

    if (!skipSubRef.current) {
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
    }

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
        const audioPubs = [...participant.audioTrackPublications.values()];
        for (const publication of audioPubs) {
          if (publication.source !== Track.Source.ScreenShareAudio) continue;
          if (!publication.isSubscribed) {
            publication.setSubscribed(true);
          }
          if (
            publication.track &&
            publication.track.mediaStreamTrack?.readyState !== 'ended'
          ) {
            foundAudioTrack = publication.track.mediaStreamTrack;
            break;
          }
        }
        if (!foundAudioTrack && foundVideoTrack) {
          const now = Date.now();
          if (now - lastMissingAudioWarningAtRef.current > 6000) {
            lastMissingAudioWarningAtRef.current = now;
            console.warn('[stream] No ScreenShareAudio track found — streamer may not be publishing audio');
          }
        }
      }
    }

    if (foundVideoTrack && !(watchingSelf && hideSelfPreview)) {
      // Attach the video track to the <video> element.  Audio is handled
      // separately via a dedicated hidden <audio> element below so that
      // late-arriving audio tracks don't require a new play() call on the
      // video element (which browsers can reject due to autoplay policy
      // when the original user gesture has been consumed).
      const currentStream = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
      const currentVideoTrack = currentStream?.getVideoTracks()[0] ?? null;

      if (currentVideoTrack !== foundVideoTrack) {
        const stream = new MediaStream([foundVideoTrack]);
        videoEl.srcObject = stream;
        videoEl.muted = true; // video-only — audio plays via separate element
        videoEl.play().catch(() => {
          const resumeOnGesture = () => {
            videoEl.play().catch(() => { });
            document.removeEventListener('click', resumeOnGesture);
            document.removeEventListener('keydown', resumeOnGesture);
          };
          document.addEventListener('click', resumeOnGesture, { once: true });
          document.addEventListener('keydown', resumeOnGesture, { once: true });
        });
      }
    } else {
      videoEl.srcObject = null;
    }

    // Always use a dedicated hidden <audio> element for stream audio.
    // This decouples audio playback from the video element so that audio
    // arriving after video (common due to subscription timing) doesn't
    // require re-calling play() on the video — which browsers often block
    // when the user gesture from clicking "LIVE" has already been consumed.
    const wantAudio = foundAudioTrack && !watchingSelf ? foundAudioTrack : null;
    if (wantAudio) {
      let audioEl = screenShareAudioRef.current;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        audioEl.setAttribute('data-paracord-stream-audio', 'true');
        document.body.appendChild(audioEl);
        screenShareAudioRef.current = audioEl;
      }
      const currentAudioStream = audioEl.srcObject instanceof MediaStream ? audioEl.srcObject : null;
      const currentAudioTrack = currentAudioStream?.getAudioTracks()[0] ?? null;
      if (currentAudioTrack !== wantAudio) {
        const audioStream = new MediaStream([wantAudio]);
        audioEl.srcObject = audioStream;
        audioEl.volume = volumeRef.current;
        audioEl.muted = false;
        audioEl.play().catch(() => {
          const resumeOnGesture = () => {
            audioEl?.play().catch(() => { });
            document.removeEventListener('click', resumeOnGesture);
            document.removeEventListener('keydown', resumeOnGesture);
          };
          document.addEventListener('click', resumeOnGesture, { once: true });
          document.addEventListener('keydown', resumeOnGesture, { once: true });
        });
      }
      audioEl.volume = volumeRef.current;
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

  // Native media path: subscribe to the published QUIC stream via MediaEngine.
  useEffect(() => {
    if (room || !mediaEngine) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const watchingSelf = localUserId != null && streamerId === localUserId;
    if (watchingSelf && hideSelfPreview) {
      setActiveStreamerName('You');
      setIsOwnStream(true);
      setHasActiveTrack(selfStream);
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let sawFrame = false;
    const onFrame = () => {
      sawFrame = true;
      setHasActiveTrack(true);
    };

    let unsubscribe = () => {};
    if (watchingSelf) {
      unsubscribe = mediaEngine.subscribeLocalPublishedScreen(canvas, onFrame);
      setActiveStreamerName('You');
      setIsOwnStream(true);
      setHasActiveTrack(selfStream);
    } else {
      unsubscribe = mediaEngine.subscribeVideo(streamerId, canvas, onFrame);
      setActiveStreamerName(streamerName ?? null);
      setIsOwnStream(false);
      setHasActiveTrack(false);
    }

    return () => {
      unsubscribe();
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      if (!sawFrame) {
        setHasActiveTrack(false);
      }
    };
  }, [room, mediaEngine, streamerId, localUserId, selfStream, streamerName, hideSelfPreview]);

  // Native media path: subscribe to screen-share audio separately from voice.
  useEffect(() => {
    if (room || !mediaEngine || !streamerId) return;
    const watchingSelf = localUserId != null && streamerId === localUserId;
    if (watchingSelf) return;
    const unsubscribe = mediaEngine.subscribeScreenShareAudio(streamerId, () => volumeRef.current);
    return () => {
      unsubscribe();
      cleanupScreenShareAudio();
    };
  }, [room, mediaEngine, streamerId, localUserId, cleanupScreenShareAudio]);

  const qualityToLayer = useCallback(
    (value: typeof quality): number | null => {
      switch (value) {
        case 'low':
          return 0;
        case 'medium':
          return 1;
        case 'high':
        case 'source':
          return 2;
        case 'auto':
        default:
          return null;
      }
    },
    [],
  );

  // Native media path: apply quality selector to simulcast subscriptions.
  useEffect(() => {
    if (room || !mediaEngine || !streamerId) return;
    const watchingSelf = localUserId != null && streamerId === localUserId;
    if (watchingSelf) return;
    const requestedLayer = qualityToLayer(quality);
    void mediaEngine.listPublishedTracks().then((tracks) => {
      const screenTrack = tracks.find(
        (track) =>
          String(track.publisherUserId) === streamerId &&
          track.trackId === 'screen' &&
          track.kind === 'video',
      );
      if (!screenTrack) return;
      const canvas = canvasRef.current;
      const viewport = canvas
        ? {
            width: Math.max(
              1,
              Math.round((canvas.clientWidth || canvas.width || 1) * (window.devicePixelRatio || 1)),
            ),
            height: Math.max(
              1,
              Math.round((canvas.clientHeight || canvas.height || 1) * (window.devicePixelRatio || 1)),
            ),
          }
        : undefined;
      void mediaEngine.registerTrackSubscription({
        streamId: screenTrack.streamId,
        trackId: screenTrack.trackId,
        requestedLayer: requestedLayer ?? undefined,
        viewport,
      });
    });
  }, [room, mediaEngine, streamerId, localUserId, quality, qualityToLayer]);

  // LiveKit room path: subscribe to room events for track attachment
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

    const pollInterval = setInterval(attachTrack, 3000);

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
      if (!skipSubRef.current) {
        setScreenShareSubscriptions(new Set<string>());
      }
      subscriptionSignatureRef.current = '__init__';
      lastMissingAudioWarningAtRef.current = 0;
    };
  }, [room, attachTrack, cleanupScreenShareAudio, setScreenShareSubscriptions]);

  const toggleMaximized = () => setIsMaximized((prev) => !prev);

  const usingNativeCanvas = !room && !!mediaEngine;
  const showVideo = hasActiveTrack && !(isOwnStream && hideSelfPreview);

  return (
    <div
      ref={containerRef}
      className={`group ${isMaximized
          ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-black'
          : 'relative flex h-full w-full flex-col overflow-hidden rounded-md bg-black'
        }`}
    >
      {issueMessage && (
        <div className="absolute left-3 top-3 z-30">
          <button
            onClick={() => setShowIssueDetails((prev) => !prev)}
            className="flex h-8 w-8 items-center justify-center rounded-sm border border-accent-warning/45 bg-warning-tint text-accent-warning outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-warning/25 focus-visible:shadow-[var(--focus-ring)]"
            title="Stream warning"
            aria-label="Show stream warning"
          >
            <AlertTriangle size={14} />
          </button>
          {showIssueDetails && (
            <div className="mt-2 w-72 rounded-md border border-border-subtle bg-bg-floating px-3 py-2 text-meta font-medium leading-relaxed text-text-primary shadow-lg">
              {issueMessage}
            </div>
          )}
        </div>
      )}
      {showSystemAudioPrivacyWarning && (
        <div className="absolute inset-x-3 top-14 z-30 max-w-xl rounded-md border border-accent-warning/45 bg-bg-floating p-3 shadow-lg sm:top-16">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent-warning" />
            <div className="flex-1">
              <div className="text-label text-text-primary">System Audio Capture Is Active</div>
              <div className="mt-1 text-meta text-text-secondary">
                Your stream can include audio from other apps and meetings. Stop streaming
                immediately if private audio is playing.
              </div>
            </div>
            <button
              type="button"
              onClick={acknowledgeSystemAudioPrivacyWarning}
              className="shrink-0 rounded-sm border border-accent-warning/50 px-2.5 py-1 text-meta font-semibold text-accent-warning outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-warning/20 focus-visible:shadow-[var(--focus-ring)]"
            >
              I understand
            </button>
          </div>
        </div>
      )}
      <div
        className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-2 p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <div className="min-w-0 flex items-center gap-2 sm:gap-3 pointer-events-none">
          <div
            className="flex items-center gap-1.5 rounded-xs px-2 py-1"
            style={{
              backgroundColor: 'var(--danger-tint)',
              border: '1px solid color-mix(in srgb, var(--accent-danger) 45%, transparent)',
            }}
          >
            <Signal size={11} style={{ color: 'var(--accent-danger)' }} className="animate-pulse" />
            <span className="text-meta font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-danger)' }}>
              Live
            </span>
          </div>
          <span className="truncate text-label text-text-primary">
            {displayName}
            {displayName !== 'You' && "'s stream"}
          </span>
          <span className="hidden font-code text-meta tabular-nums text-text-secondary sm:inline">
            {formatTime(elapsedSeconds)}
          </span>
          {systemAudioCaptureActive && (
            <span className="inline-flex items-center gap-1 rounded-xs border border-accent-warning/50 bg-warning-tint px-2 py-0.5 text-meta font-semibold uppercase tracking-wide text-accent-warning">
              <AlertTriangle size={11} />
              System Audio
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
          {!isOwnStream && !isCompactLayout && (
            <select
              value={quality}
              onChange={(e) =>
                setQuality(
                  e.target.value as 'auto' | 'low' | 'medium' | 'high' | 'source'
                )
              }
              className="h-9 rounded-sm bg-black/40 px-3 text-meta font-medium text-white/80 outline-none backdrop-blur-md transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:bg-black/60 hover:text-white hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
              title="Viewing quality"
            >
              <option value="auto">Auto</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="source">Source</option>
            </select>
          )}

          <div
            className="relative flex items-center"
            onMouseEnter={() => {
              if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
              setShowVolumeSlider(true);
            }}
            onMouseLeave={() => {
              volumeTimerRef.current = setTimeout(() => setShowVolumeSlider(false), 300);
            }}
          >
            <button
              onClick={() => {
                updateStreamVolume(isMuted ? 1 : 0);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-sm bg-black/40 text-white/80 outline-none backdrop-blur-md transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:bg-black/60 hover:text-white hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            {showVolumeSlider && (
              <div
                className="absolute right-0 top-full z-50 mt-2 flex min-w-44 items-center gap-2 rounded-md border border-border-subtle px-3 py-2 shadow-lg"
                style={{ backgroundColor: 'var(--bg-floating)', backdropFilter: 'blur(12px)' }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <VolumeX size={13} className="shrink-0 text-text-muted" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    updateStreamVolume(v);
                  }}
                  className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-bg-mod-strong accent-accent-primary [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-primary"
                  title={`Volume: ${Math.round(volume * 100)}%`}
                />
                <Volume2 size={13} className="shrink-0 text-text-muted" />
                <span className="w-8 text-right text-[10px] font-medium tabular-nums text-text-muted">
                  {Math.round(volume * 100)}%
                </span>
              </div>
            )}
          </div>

          {isOwnStream && (
            <button
              onClick={() => setHideSelfPreview((prev) => !prev)}
              className="flex h-9 w-9 items-center justify-center rounded-sm bg-black/40 text-white/80 outline-none backdrop-blur-md transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:bg-black/60 hover:text-white hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
              title={hideSelfPreview ? 'Show your stream preview' : 'Hide your stream preview (saves resources)'}
              aria-label={hideSelfPreview ? 'Show your stream preview' : 'Hide your stream preview'}
            >
              {hideSelfPreview ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}

          <button
            onClick={toggleMaximized}
            className="flex h-9 w-9 items-center justify-center rounded-sm bg-black/40 text-white/80 outline-none backdrop-blur-md transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:bg-black/60 hover:text-white hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
            title={isMaximized ? 'Restore' : 'Maximize'}
            aria-label={isMaximized ? 'Restore stream viewer' : 'Maximize stream viewer'}
          >
            {isMaximized ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>

          {onStopWatching && (
            <button
              onClick={onStopWatching}
              className="flex h-9 w-9 items-center justify-center rounded-sm bg-black/40 text-white/80 outline-none backdrop-blur-md transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:bg-black/60 hover:text-white hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
              title="Stop watching"
              aria-label="Stop watching stream"
            >
              <X size={16} />
            </button>
          )}

          {(selfStream || isOwnStream) && onStopStream && (
            <button
              onClick={onStopStream}
              className="ml-1 flex h-9 items-center gap-2 rounded-sm px-2.5 text-label text-accent-danger outline-none transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger/20 hover:shadow-md focus-visible:shadow-[var(--focus-ring)] sm:px-3.5"
              style={{
                backgroundColor: 'var(--danger-tint)',
                border: '1px solid color-mix(in srgb, var(--accent-danger) 38%, transparent)',
              }}
              title="Stop streaming"
              aria-label="Stop streaming"
            >
              <MonitorOff size={15} />
              {!isCompactLayout && 'Stop'}
            </button>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 h-full w-full items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          autoPlay
          playsInline
          muted
          style={{
            backgroundColor: 'var(--bg-tertiary)',
            opacity: showVideo && !usingNativeCanvas ? 1 : 0,
            position: showVideo && !usingNativeCanvas ? 'relative' : 'absolute',
            pointerEvents: 'none',
          }}
        />
        <canvas
          ref={canvasRef}
          className="h-full w-full object-contain"
          style={{
            backgroundColor: 'var(--bg-tertiary)',
            opacity: showVideo && usingNativeCanvas ? 1 : 0,
            position: showVideo && usingNativeCanvas ? 'relative' : 'absolute',
            pointerEvents: 'none',
          }}
        />

        {!showVideo && (
          <div className="absolute inset-0 flex items-center justify-center"
            style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <div className="flex flex-col items-center gap-4">
              {isOwnStream && hideSelfPreview ? (
                <>
                  <div className="flex h-16 w-16 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
                    <Monitor size={28} />
                  </div>
                  <div className="text-center">
                    <div className="text-subhead text-text-primary">
                      Stream preview hidden
                    </div>
                    <div className="mt-1 text-meta text-text-muted">
                      Your stream is still live. Others can see it.
                    </div>
                  </div>
                </>
              ) : expectingStream ? (
                <>
                  <div className="relative flex h-16 w-16 items-center justify-center">
                    <div
                      className="absolute inset-0 animate-spin rounded-full"
                      style={{
                        border: '2px solid transparent',
                        borderTopColor: 'var(--accent-primary)',
                        borderRightColor: 'var(--accent-primary)',
                      }}
                    />
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-tint text-accent-primary">
                      <Monitor size={22} />
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-subhead text-text-primary">
                      Starting stream...
                    </div>
                    <div className="mt-1 text-meta text-text-muted">
                      Connecting to the media server
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex h-16 w-16 items-center justify-center rounded-md bg-bg-mod-subtle text-text-muted">
                    <Monitor size={26} />
                  </div>
                  <div className="text-center">
                    <div className="text-subhead text-text-secondary">
                      Stream is not available
                    </div>
                    <div className="mt-1 text-meta text-text-muted">
                      {displayName} is not currently publishing a stream track.
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div >
  );
}
