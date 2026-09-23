import { useEffect, useRef, useState, useCallback } from 'react';
import {
  AlertTriangle,
  Maximize,
  Minimize,
  Volume1,
  Volume2,
  VolumeX,
  MonitorOff,
  MonitorUp,
  Eye,
  EyeOff,
  X,
} from 'lucide-react';
import { livekit } from '../../stores/voice/livekitRuntime';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import {
  StreamOverlayPortal,
  useAnchoredOverlayCoords,
  useOverlayDismiss,
} from './streamOverlayPortal';
import { LiveDot } from '../light';
import { cn } from '../../lib/utils';
import { reportGroundColor } from '../../lib/nativeGround';

/**
 * A control on the tile itself: the name-tag fill, so it stays readable over
 * live video without a gradient wash across the frame (§6.2).
 */
const TILE_BTN =
  'pc-tag pc-focusable inline-flex h-9 w-9 items-center justify-center text-text-primary ' +
  'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong';

interface StreamViewerProps {
  streamerId: string;
  streamerName?: string;
  expectingStream?: boolean;
  onStopStream?: () => void;
  onStopWatching?: () => void;
  issueMessage?: string | null;
  /**
   * The transport readout for the tile's top-right corner — "QUIC", "WebRTC".
   * Built by `components/voice/stage/transportReadout.ts`, which never invents
   * a number the engines do not report.
   */
  transport?: string | null;
  /** When true, skip managing screen share subscriptions (managed externally). */
  skipSubscriptionManagement?: boolean;
}

/**
 * Underlay hole refcount: while ≥1 stream tile composites on the native GL
 * surface BELOW the webview, `<html data-native-underlay>` makes the shell's
 * base backgrounds transparent (see layout.css) so the tile's cleared pixels
 * are a real hole down to the video. Refcounted because split view can show
 * two live tiles at once.
 */
let underlayHoleCount = 0;
function setUnderlayHole(open: boolean) {
  if (typeof document === 'undefined') return;
  const wasOpen = underlayHoleCount > 0;
  underlayHoleCount = Math.max(0, underlayHoleCount + (open ? 1 : -1));
  document.documentElement.toggleAttribute('data-native-underlay', underlayHoleCount > 0);
  // The moment the hole opens, the GTK toplevel under the webview becomes
  // visible around the tile — so the shell is told the ground colour again
  // here as well as on every theme change, and a hole never opens onto a
  // colour the shell was told before the last restyle.
  if (!wasOpen && underlayHoleCount > 0) void reportGroundColor();
}

export function StreamViewer({
  streamerId,
  streamerName,
  expectingStream = false,
  onStopStream,
  onStopWatching,
  issueMessage = null,
  transport = null,
  skipSubscriptionManagement = false,
}: StreamViewerProps) {
  const [volume, setVolume] = useState(1);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const isMuted = volume === 0;
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeStreamerName, setActiveStreamerName] = useState<string | null>(null);
  const [hasActiveTrack, setHasActiveTrack] = useState(false);
  const [isOwnStream, setIsOwnStream] = useState(false);
  const [hideSelfPreview, setHideSelfPreview] = useState(true);
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
  // True while the native GL surface UNDER the webview is live and visible for
  // this tile (Linux underlay route): the tile clears its backgrounds so the
  // video shows through, and restores its opaque backdrop when the surface
  // hides. Driven by the engine's bubbled canvas event.
  const [underlaySurfaceLive, setUnderlaySurfaceLive] = useState(false);
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
  const issueTriggerRef = useRef<HTMLButtonElement>(null);
  const issuePanelRef = useRef<HTMLDivElement>(null);
  const volumeAnchorRef = useRef<HTMLDivElement>(null);
  const volumePanelRef = useRef<HTMLDivElement>(null);
  const privacyPanelRef = useRef<HTMLDivElement>(null);
  const streamStartTime = useRef<number>(Date.now());
  const screenShareAudioRef = useRef<HTMLAudioElement | null>(null);
  const subscriptionSignatureRef = useRef<string>('__init__');
  const lastMissingAudioWarningAtRef = useRef<number>(0);
  const nativeHasActiveTrackRef = useRef(false);

  // Underlay hole-punch (Linux): the engine dispatches this bubbled event on
  // the tile's canvas whenever the native GL surface below becomes visible or
  // hidden (tauriMediaEngine, native-surface route).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onSurfaceVisibility = (event: Event) => {
      const visible = Boolean(
        (event as CustomEvent<{ visible?: boolean }>).detail?.visible,
      );
      setUnderlaySurfaceLive(visible);
    };
    container.addEventListener('paracord:native-surface-visibility', onSurfaceVisibility);
    return () => {
      container.removeEventListener(
        'paracord:native-surface-visibility',
        onSurfaceVisibility,
      );
    };
  }, []);

  // Document-level hole refcount, including unmount while the surface is live.
  useEffect(() => {
    if (!underlaySurfaceLive) return;
    setUnderlayHole(true);
    return () => setUnderlayHole(false);
  }, [underlaySurfaceLive]);

  // The native tile can become visible before React has painted the transparent
  // underlay hole. Nudge the tile after the DOM commit so it queues one more
  // geometry/render pass without relying on the user resizing the window.
  useEffect(() => {
    if (!underlaySurfaceLive) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        canvasRef.current?.dispatchEvent(
          new CustomEvent('paracord:native-underlay-hole-ready', { bubbles: true }),
        );
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [underlaySurfaceLive]);

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
    // Drive per-source gain on both engines (native cpal mixer / browser GainNode).
    const engine = useVoiceStore.getState().mediaEngine;
    engine?.setSourceVolume(streamerId, clampedVolume);
  }, [streamerId]);

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

  // Escape: close issue details first, then exit maximized mode.
  useEffect(() => {
    if (!isMaximized && !showIssueDetails) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showIssueDetails) {
        setShowIssueDetails(false);
        e.stopPropagation();
        return;
      }
      if (isMaximized) setIsMaximized(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isMaximized, showIssueDetails]);

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

  const closeIssueDetails = useCallback(() => setShowIssueDetails(false), []);
  const issueInside = useCallback(
    (target: Node) =>
      Boolean(
        issueTriggerRef.current?.contains(target) ||
          issuePanelRef.current?.contains(target),
      ),
    [],
  );
  // Portaled panels: outside-click must check body-mounted refs, not in-tile DOM.
  useOverlayDismiss(showIssueDetails, closeIssueDetails, issueInside, {
    // Escape is owned by the maximize/details handler above.
    escape: false,
  });

  const issueCoords = useAnchoredOverlayCoords(
    showIssueDetails,
    issueTriggerRef,
    'below-start',
    288,
  );

  const volumeCoords = useAnchoredOverlayCoords(
    showVolumeSlider,
    volumeAnchorRef,
    'below-end',
    176,
  );

  const [privacyCoords, setPrivacyCoords] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const updatePrivacyPosition = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPrivacyCoords({
      top: rect.top + (isCompactLayout ? 56 : 64),
      left: rect.left + 12,
      width: Math.min(rect.width - 24, 36 * 16),
    });
  }, [isCompactLayout]);

  useEffect(() => {
    if (!showSystemAudioPrivacyWarning) {
      setPrivacyCoords(null);
      return;
    }
    updatePrivacyPosition();
    window.addEventListener('resize', updatePrivacyPosition);
    window.addEventListener('scroll', updatePrivacyPosition, true);
    return () => {
      window.removeEventListener('resize', updatePrivacyPosition);
      window.removeEventListener('scroll', updatePrivacyPosition, true);
    };
  }, [showSystemAudioPrivacyWarning, updatePrivacyPosition]);

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
          if (publication.source !== livekit().Track.Source.ScreenShare) continue;
          if (publication.isSubscribed !== shouldSubscribe) {
            publication.setSubscribed(shouldSubscribe);
          }
        }
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.source !== livekit().Track.Source.ScreenShareAudio) continue;
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
          publication.source === livekit().Track.Source.ScreenShare &&
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
            publication.source === livekit().Track.Source.ScreenShare &&
            publication.track &&
            publication.track.mediaStreamTrack?.readyState !== 'ended'
          ) {
            if (quality !== 'auto') {
              if (quality === 'low') publication.setVideoQuality(livekit().VideoQuality.LOW);
              if (quality === 'medium') publication.setVideoQuality(livekit().VideoQuality.MEDIUM);
              if (quality === 'high' || quality === 'source') {
                publication.setVideoQuality(livekit().VideoQuality.HIGH);
              }
            }
            foundVideoTrack = publication.track.mediaStreamTrack;
            break;
          }
        }
        const audioPubs = [...participant.audioTrackPublications.values()];
        for (const publication of audioPubs) {
          if (publication.source !== livekit().Track.Source.ScreenShareAudio) continue;
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
  //
  // The route is chosen once inside subscribeVideo (spec §2): a
  // `webcodecs-passthrough` subscription decodes into this <canvas>'s WebGL
  // context, while a `native-surface` subscription mounts a NativeVideoTile on
  // this same <canvas> box — the tile mirrors the canvas geometry to a native
  // platform surface the decode worker renders into, and the surface composites
  // OVER the webview (spec §3.3/§3.6). Either way this component only hands over
  // the canvas box + an onFrame signal; nothing here needs to know the route.
  // When a native surface reports occluded/hidden it hides itself, revealing the
  // canvas's bg-tertiary backdrop (and, before any track is live, the poster
  // below) — the DOM poster/backdrop is what shows through (spec §3.6).
  // Display-only projection of the native path's identity. Split out of the
  // subscription effect below on purpose: `streamerName` arrives late (the
  // username resolves after the tile mounts) and `selfStream` toggles
  // independently. Both were dependencies of the subscription, so either one
  // changing tore down the QUIC subscription and re-established it — the tile
  // went blank for several seconds just because a name resolved.
  useEffect(() => {
    if (room || !mediaEngine) return;
    const watchingSelf = localUserId != null && streamerId === localUserId;
    if (watchingSelf) {
      setActiveStreamerName('You');
      setIsOwnStream(true);
      setHasActiveTrack(selfStream);
    } else {
      setActiveStreamerName(streamerName ?? null);
      setIsOwnStream(false);
    }
  }, [room, mediaEngine, streamerId, localUserId, streamerName, selfStream]);

  useEffect(() => {
    if (room || !mediaEngine) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const watchingSelf = localUserId != null && streamerId === localUserId;
    if (watchingSelf && hideSelfPreview) {
      // No canvas clear here: the CanvasRenderer owns a WebGL context on this
      // element, so getContext('2d') returns null (W11). The hidden preview is
      // masked by opacity/positioning, and the renderer is torn down on unmount.
      return;
    }

    let sawFrame = false;
    nativeHasActiveTrackRef.current = false;
    const onFrame = () => {
      sawFrame = true;
      if (!nativeHasActiveTrackRef.current) {
        nativeHasActiveTrackRef.current = true;
        setHasActiveTrack(true);
      }
    };

    let unsubscribe = () => {};
    if (watchingSelf) {
      unsubscribe = mediaEngine.subscribeLocalPublishedScreen(canvas, onFrame);
    } else {
      // Name the track. Without it the engine hands back whichever video track
      // this person published first — their camera, if they have one on — and
      // files the subscription under their bare user id, so a screen frame
      // arriving for `<user>:screen` found nothing to render into and the
      // viewer sat on "X is not sharing" while the share was running.
      unsubscribe = mediaEngine.subscribeVideo(streamerId, canvas, onFrame, {
        preferredTrackId: 'screen',
      });
      setHasActiveTrack(false);
    }

    return () => {
      unsubscribe();
      nativeHasActiveTrackRef.current = false;
      // unsubscribe() destroys the CanvasRenderer, which clears its own WebGL
      // surface. A getContext('2d') clear here is dead code — the canvas is
      // committed to WebGL and returns null for a 2D context (W11).
      if (!sawFrame) {
        setHasActiveTrack(false);
      }
    };
  }, [room, mediaEngine, streamerId, localUserId, hideSelfPreview]);

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

  // `attachTrack` is re-created whenever `quality`, `hideSelfPreview` or
  // `previewStreamerId` change. Reach it through a ref so the room-listener
  // effect below can key on `[room]` alone.
  const attachTrackRef = useRef(attachTrack);
  useEffect(() => {
    attachTrackRef.current = attachTrack;
  }, [attachTrack]);

  // LiveKit room path: subscribe to room events for track attachment.
  //
  // This effect used to depend on `attachTrack` while performing unmount-shaped
  // teardown (blanking srcObject, dropping every screen-share subscription).
  // Changing the quality selector or resolving a username therefore blanked the
  // tile and forced a multi-second re-subscribe. The listeners now key on the
  // room only; re-attaching and teardown are handled separately below.
  useEffect(() => {
    if (!room) return;

    const onRoomEvent = () => attachTrackRef.current();
    onRoomEvent();
    const { RoomEvent } = livekit();
    room.on(RoomEvent.TrackSubscribed, onRoomEvent);
    room.on(RoomEvent.TrackUnsubscribed, onRoomEvent);
    room.on(RoomEvent.TrackPublished, onRoomEvent);
    room.on(RoomEvent.TrackUnpublished, onRoomEvent);
    room.on(RoomEvent.TrackMuted, onRoomEvent);
    room.on(RoomEvent.TrackUnmuted, onRoomEvent);
    room.on(RoomEvent.ParticipantConnected, onRoomEvent);
    room.on(RoomEvent.ParticipantDisconnected, onRoomEvent);
    room.on(RoomEvent.LocalTrackPublished, onRoomEvent);
    room.on(RoomEvent.LocalTrackUnpublished, onRoomEvent);

    return () => {
      room.off(RoomEvent.TrackSubscribed, onRoomEvent);
      room.off(RoomEvent.TrackUnsubscribed, onRoomEvent);
      room.off(RoomEvent.TrackPublished, onRoomEvent);
      room.off(RoomEvent.TrackUnpublished, onRoomEvent);
      room.off(RoomEvent.TrackMuted, onRoomEvent);
      room.off(RoomEvent.TrackUnmuted, onRoomEvent);
      room.off(RoomEvent.ParticipantConnected, onRoomEvent);
      room.off(RoomEvent.ParticipantDisconnected, onRoomEvent);
      room.off(RoomEvent.LocalTrackPublished, onRoomEvent);
      room.off(RoomEvent.LocalTrackUnpublished, onRoomEvent);
    };
  }, [room]);

  // Re-attach (not re-subscribe) when the attachment inputs change. Cheap, and
  // it leaves the room listeners and screen-share subscriptions untouched.
  useEffect(() => {
    if (!room) return;
    attachTrack();
  }, [room, attachTrack]);

  // Real teardown, on unmount only. Held in a ref so this effect can have an
  // empty dependency list and therefore genuinely run once.
  const streamTeardownRef = useRef<() => void>(() => {});
  streamTeardownRef.current = () => {
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
  useEffect(() => () => streamTeardownRef.current(), []);

  const toggleMaximized = () => setIsMaximized((prev) => !prev);

  const usingNativeCanvas = !room && !!mediaEngine;
  const showVideo = hasActiveTrack && !(isOwnStream && hideSelfPreview);

  return (
    <div
      ref={containerRef}
      /* Occlusion boundary for the native-surface route (§3.6): everything
         inside this root is tile chrome (badges, hover bar, poster) and must
         never report the native surface occluded — only foreign portals over
         the tile do. Without it the hit-testable opacity-0 gradient bar kept
         the surface permanently hidden (black screen, 2026-07-07).
         Ephemeral menus/popovers MUST use StreamOverlayPortal → document.body
         so they occlude the underlay and stay dismissible. */
      data-native-surface-boundary=""
      /* While the native surface below is live (underlay), this tile is a
         transparent hole down to the GL video; otherwise it keeps its opaque
         black backdrop. */
      data-native-underlay-clear=""
      className={cn(
        'group',
        isMaximized
          ? 'fixed inset-0 z-50 flex flex-col overflow-hidden'
          : 'relative flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-card)]',
        underlaySurfaceLive ? 'bg-transparent' : 'bg-bg-well',
      )}
    >
      {issueMessage && (
        <div className="absolute left-3 top-3 z-30" data-stream-issue-popover="">
          <button
            ref={issueTriggerRef}
            onClick={() => setShowIssueDetails((prev) => !prev)}
            className="pc-focusable inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-chip)] bg-warning-tint text-accent-warning transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:brightness-125"
            title="Stream warning"
            aria-label={showIssueDetails ? 'Hide stream warning' : 'Show stream warning'}
            aria-expanded={showIssueDetails}
          >
            <AlertTriangle size={14} />
          </button>
          {showIssueDetails && (
            <StreamOverlayPortal
              panelRef={issuePanelRef}
              role="status"
              className="pc-floating w-[min(18rem,calc(100vw-1rem))] px-3 py-2 text-meta font-medium leading-relaxed text-text-primary"
              style={{
                top: issueCoords?.top ?? 48,
                left: issueCoords?.left ?? 12,
              }}
            >
              {issueMessage}
            </StreamOverlayPortal>
          )}
        </div>
      )}
      {showSystemAudioPrivacyWarning && (
        <StreamOverlayPortal
          panelRef={privacyPanelRef}
          className="pc-floating max-w-xl p-3"
          style={{
            top: privacyCoords?.top ?? 72,
            left: privacyCoords?.left ?? 12,
            width: privacyCoords?.width ?? undefined,
          }}
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent-warning" />
            <div className="flex-1">
              <div className="text-label text-text-primary">Your share is carrying system audio</div>
              <div className="mt-1 text-meta text-text-secondary">
                Your stream can include audio from other apps and meetings. Stop streaming
                immediately if private audio is playing.
              </div>
            </div>
            <button
              type="button"
              onClick={acknowledgeSystemAudioPrivacyWarning}
              className="pc-focusable shrink-0 rounded-[var(--radius-chip)] bg-warning-tint px-2.5 py-1 text-meta font-semibold text-accent-warning transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:brightness-125"
            >
              I understand
            </button>
          </div>
        </StreamOverlayPortal>
      )}
      {/* The name tag, bottom-left, exactly like every other Stage tile (§8). */}
      <span className="pc-tag absolute bottom-2.5 left-2.5 z-20 inline-flex h-6 max-w-[calc(100%-1.25rem)] items-center gap-1.5 px-2 text-meta font-medium">
        <LiveDot />
        <MonitorUp size={13} className="shrink-0" aria-hidden />
        <span className="truncate">
          {displayName}
          {displayName !== 'You' && "\u2019s screen"}
        </span>
        <span className="pc-mono shrink-0 text-text-secondary">{formatTime(elapsedSeconds)}</span>
      </span>
      {systemAudioCaptureActive && (
        <span className="pc-tag absolute bottom-2.5 left-2.5 z-20 inline-flex h-6 translate-y-[-1.9rem] items-center gap-1.5 px-2 text-meta font-medium text-accent-warning">
          <AlertTriangle size={12} aria-hidden />
          Sharing system audio
        </span>
      )}

      {/* The transport readout, top-right, in the mono face. The hover controls
          take the same corner, so nothing jumps when they appear. */}
      {transport && (
        <span className="pc-tag pc-mono absolute right-2.5 top-2.5 z-20 inline-flex h-6 items-center px-2 text-[11.5px] text-text-secondary transition-opacity duration-[var(--duration-fast)] group-hover:opacity-0 group-focus-within:opacity-0">
          {transport}
        </span>
      )}

      <div
        className="absolute right-2.5 top-2.5 z-20 flex flex-wrap items-center justify-end gap-1.5 opacity-0 transition-opacity duration-[var(--duration-normal)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
          {!isOwnStream && !isCompactLayout && (
            <select
              value={quality}
              onChange={(e) =>
                setQuality(
                  e.target.value as 'auto' | 'low' | 'medium' | 'high' | 'source'
                )
              }
              className="pc-tag pc-select pc-focusable h-9 appearance-none py-0 pl-3 pr-7 text-meta font-medium text-text-primary"
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
            ref={volumeAnchorRef}
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
              className={TILE_BTN}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            {showVolumeSlider && (
              <StreamOverlayPortal
                panelRef={volumePanelRef}
                className="pc-floating flex min-w-44 items-center gap-2 px-3 py-2"
                style={{
                  top: volumeCoords?.top ?? 48,
                  left: volumeCoords?.left ?? 8,
                }}
                onMouseEnter={() => {
                  if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
                  setShowVolumeSlider(true);
                }}
                onMouseLeave={() => {
                  volumeTimerRef.current = setTimeout(() => setShowVolumeSlider(false), 300);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <VolumeX size={13} className="shrink-0 text-text-faint" />
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
                <Volume2 size={13} className="shrink-0 text-text-faint" />
                <span className="pc-mono w-8 text-right text-[10px] font-medium text-text-faint">
                  {Math.round(volume * 100)}%
                </span>
              </StreamOverlayPortal>
            )}
          </div>

          {isOwnStream && (
            <button
              onClick={() => setHideSelfPreview((prev) => !prev)}
              className={TILE_BTN}
              title={hideSelfPreview ? 'Show your stream preview' : 'Hide your stream preview (saves resources)'}
              aria-label={hideSelfPreview ? 'Show your stream preview' : 'Hide your stream preview'}
            >
              {hideSelfPreview ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}

          <button
            onClick={toggleMaximized}
            className={TILE_BTN}
            title={isMaximized ? 'Restore' : 'Maximize'}
            aria-label={isMaximized ? 'Restore stream viewer' : 'Maximize stream viewer'}
          >
            {isMaximized ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>

          {onStopWatching && (
            <button
              onClick={onStopWatching}
              className={TILE_BTN}
              title="Stop watching"
              aria-label="Stop watching stream"
            >
              <X size={16} />
            </button>
          )}

          {(selfStream || isOwnStream) && onStopStream && (
            <button
              onClick={onStopStream}
              className="pc-focusable ml-1 inline-flex h-9 items-center gap-2 rounded-[var(--radius-chip)] bg-danger-well px-2.5 text-label text-accent-danger transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:brightness-125 sm:px-3.5"
              title="Stop streaming"
              aria-label="Stop streaming"
            >
              <MonitorOff size={15} />
              {!isCompactLayout && 'Stop'}
            </button>
          )}
        </div>
      </div>

      <div
        data-native-underlay-clear=""
        className="relative flex min-h-0 h-full w-full items-center justify-center overflow-hidden"
      >
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          autoPlay
          playsInline
          muted
          style={{
            backgroundColor: 'var(--bg-well)',
            opacity: showVideo && !usingNativeCanvas ? 1 : 0,
            position: showVideo && !usingNativeCanvas ? 'relative' : 'absolute',
            pointerEvents: 'none',
          }}
        />
        {/* Doubles as the WebGL target for the passthrough route and the DOM
            host/backdrop for the native-surface route: the native surface
            composites over this box while visible, and its bg-tertiary backdrop
            shows through whenever the surface reports occluded/hidden (§3.6). */}
        <canvas
          ref={canvasRef}
          data-stream-canvas=""
          className="h-full w-full object-contain"
          style={{
            // Underlay route: the canvas box IS the hole — any paint here
            // would sit over the video below it. Its WebGL context is created
            // with alpha:false (opaque even when undrawn), so the whole
            // element must stop painting (opacity 0) while the native surface
            // is live; it keeps its layout box, which is what the surface
            // geometry mirrors.
            backgroundColor: underlaySurfaceLive ? 'transparent' : 'var(--bg-well)',
            opacity: showVideo && usingNativeCanvas && !underlaySurfaceLive ? 1 : 0,
            position: showVideo && usingNativeCanvas ? 'relative' : 'absolute',
            pointerEvents: 'none',
            visibility: underlaySurfaceLive ? 'hidden' : 'visible',
          }}
        />

        {!showVideo && (
          <div
            className="absolute inset-0 flex items-center bg-bg-well px-6 sm:px-10"
          >
            <div className="flex max-w-[42ch] flex-col items-start gap-2">
              {isOwnStream && hideSelfPreview ? (
                <>
                  <span className="pc-display text-heading text-text-primary">
                    Your share is live — the preview is off
                  </span>
                  <p className="text-label text-text-secondary">
                    Everyone in the call still sees it. Turning the preview off saves your
                    machine a decode of your own frames.
                  </p>
                  <button
                    type="button"
                    onClick={() => setHideSelfPreview(false)}
                    className="pc-focusable mt-1 inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] bg-bg-raised px-3 text-label text-text-primary shadow-[var(--shadow-raised)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong"
                  >
                    <Eye size={15} />
                    Show the preview
                  </button>
                </>
              ) : expectingStream ? (
                <>
                  <span className="pc-display text-heading text-text-primary">
                    Opening your share
                  </span>
                  <p className="text-label text-text-secondary">
                    The first frames are on their way to the call.
                  </p>
                </>
              ) : (
                <>
                  <span className="pc-display text-heading text-text-primary">
                    {displayName === 'You' ? 'You are not sharing' : `${displayName} is not sharing`}
                  </span>
                  <p className="text-label text-text-secondary">
                    No screen track is reaching this call right now.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div >
  );
}
