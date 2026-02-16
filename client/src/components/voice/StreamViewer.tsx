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
  const selfStream = useVoiceStore((s) => s.selfStream);
  const systemAudioCaptureActive = useVoiceStore((s) => s.systemAudioCaptureActive);
  const showSystemAudioPrivacyWarning = useVoiceStore((s) => s.showSystemAudioPrivacyWarning);
  const acknowledgeSystemAudioPrivacyWarning = useVoiceStore(
    (s) => s.acknowledgeSystemAudioPrivacyWarning
  );
  const previewStreamerId = useVoiceStore((s) => s.previewStreamerId);
  const localUserId = useAuthStore((s) => s.user?.id ?? null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamStartTime = useRef<number>(Date.now());
  const screenShareAudioRef = useRef<HTMLAudioElement | null>(null);
  const subscriptionSignatureRef = useRef<string>('__init__');
  const lastMissingAudioWarningAtRef = useRef<number>(0);

  const displayName = streamerName ?? activeStreamerName ?? 'Someone';

  // Sync volume to video element whenever it changes
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

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
          if (publication.track) {
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
      // Build a MediaStream with the video track, and include the audio
      // track directly if available. Attaching audio to the same <video>
      // element avoids WebView2 autoplay policy issues that can block a
      // separate hidden <audio> element.
      const currentStream = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
      const currentVideoTrack = currentStream?.getVideoTracks()[0] ?? null;
      const currentAudioTrack = currentStream?.getAudioTracks()[0] ?? null;
      const wantAudio = foundAudioTrack && !watchingSelf ? foundAudioTrack : null;

      if (currentVideoTrack !== foundVideoTrack || currentAudioTrack !== wantAudio) {
        const tracks: MediaStreamTrack[] = [foundVideoTrack];
        if (wantAudio) tracks.push(wantAudio);
        const stream = new MediaStream(tracks);
        videoEl.srcObject = stream;
        videoEl.play().catch(() => {
          // Autoplay with audio may be blocked by browser policy.
          // Register a one-shot user-gesture listener to retry, matching
          // the hidden <audio> fallback behavior below.
          const resumeOnGesture = () => {
            videoEl.play().catch(() => {});
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

    // Fallback hidden <audio> only when we have stream audio but no video
    // track attached yet. Otherwise audio is carried by the <video> stream.
    if (foundAudioTrack && !watchingSelf && !foundVideoTrack) {
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
      if (currentAudioTrack !== foundAudioTrack) {
        const audioStream = new MediaStream([foundAudioTrack]);
        audioEl.srcObject = audioStream;
        audioEl.volume = volumeRef.current;
        audioEl.muted = false;
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
      {issueMessage && (
        <div className="absolute left-3 top-3 z-30">
          <button
            onClick={() => setShowIssueDetails((prev) => !prev)}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-400/60 bg-amber-500/15 text-amber-300 transition-colors hover:bg-amber-500/25"
            title="Stream warning"
            aria-label="Show stream warning"
          >
            <AlertTriangle size={14} />
          </button>
          {showIssueDetails && (
            <div
              className="mt-2 w-72 rounded-xl border px-3 py-2 text-xs font-medium leading-relaxed shadow-xl"
              style={{
                borderColor: 'rgba(245, 158, 11, 0.45)',
                backgroundColor: 'rgba(17, 24, 39, 0.92)',
                color: 'var(--text-primary)',
              }}
            >
              {issueMessage}
            </div>
          )}
        </div>
      )}
      {showSystemAudioPrivacyWarning && (
        <div className="absolute inset-x-3 top-14 z-30 max-w-xl rounded-xl border border-amber-400/55 bg-amber-500/14 p-3 text-xs shadow-xl sm:top-16">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 text-amber-300" />
            <div className="flex-1">
              <div className="font-semibold text-amber-200">System Audio Capture Is Active</div>
              <div className="mt-1 text-amber-100/90">
                Your stream can include audio from other apps and meetings. Stop streaming
                immediately if private audio is playing.
              </div>
            </div>
            <button
              type="button"
              onClick={acknowledgeSystemAudioPrivacyWarning}
              className="rounded-md border border-amber-300/65 px-2 py-1 text-[11px] font-semibold text-amber-100 transition-colors hover:bg-amber-500/20"
            >
              I understand
            </button>
          </div>
        </div>
      )}
      <div
        className="relative z-10 flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-5 sm:py-3"
        style={{
          backgroundColor: 'var(--bg-floating)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="min-w-0 flex items-center gap-2 sm:gap-3">
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
          <span className="hidden text-sm font-mono text-text-muted sm:inline">
            {formatTime(elapsedSeconds)}
          </span>
          {systemAudioCaptureActive && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/55 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
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
                const newVol = isMuted ? 1 : 0;
                setVolume(newVol);
                const audioEl = screenShareAudioRef.current;
                if (audioEl) audioEl.volume = newVol;
                const videoEl = videoRef.current;
                if (videoEl) videoEl.volume = newVol;
              }}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            {showVolumeSlider && (
              <div
                className="absolute left-1/2 top-full z-50 mt-2 flex -translate-x-1/2 flex-col items-center gap-2 rounded-xl border border-border-subtle px-2 py-3"
                style={{ backgroundColor: 'var(--bg-floating)', backdropFilter: 'blur(12px)' }}
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setVolume(v);
                    const audioEl = screenShareAudioRef.current;
                    if (audioEl) audioEl.volume = v;
                    const videoEl = videoRef.current;
                    if (videoEl) videoEl.volume = v;
                  }}
                  className="h-24 w-1.5 cursor-pointer appearance-none rounded-full bg-bg-mod-strong accent-accent-primary [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-primary"
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                  title={`Volume: ${Math.round(volume * 100)}%`}
                />
                <span className="text-[10px] font-medium text-text-muted">
                  {Math.round(volume * 100)}%
                </span>
              </div>
            )}
          </div>

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
              className="ml-1 flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/18 sm:px-3.5"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--accent-danger) 14%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-danger) 38%, transparent)',
              }}
              title="Stop streaming"
            >
              <MonitorOff size={15} />
              {!isCompactLayout && 'Stop'}
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
          muted={false}
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
