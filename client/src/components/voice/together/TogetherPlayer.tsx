import { useCallback, useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';

import { fileApi } from '../../../api/files';
import type { TogetherApi } from '../../../api/together';
import { currentAudioOutputDeviceId } from '../../../stores/voiceStore';
import {
  currentItem,
  expectedPositionMs,
  isAudioItem,
  type TogetherItem,
  type TogetherSession,
} from '../../../lib/together/model';
import { serverNowMs } from '../../../lib/together/serverClock';
import { decideCorrection, type PlayerKind } from '../../../lib/together/sync';
import {
  createYouTubeFrame,
  loadYouTubeApi,
  youtubeErrorMessage,
  YT_STATE,
  type YouTubePlayer,
} from '../../../lib/together/youtube';
import { cn } from '../../../lib/utils';
import { TogetherCover } from './TogetherCover';

/** What the player tells the controls around it. */
export interface PlayerStatus {
  /** Width / height of the video, once known; null for audio. */
  aspect: number | null;
  durationMs: number | null;
  buffering: boolean;
  error: string | null;
  needsGesture: boolean;
}

/** One interface over `<video>` and the YouTube player. */
interface MediaHandle {
  kind: PlayerKind;
  currentMs(): number;
  durationMs(): number | null;
  isPlaying(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(ms: number): void;
  rate(): number;
  setRate(rate: number): void;
  setVolume(volume: number, muted: boolean): void;
  ready(): boolean;
}

function elementHandle(element: HTMLVideoElement): MediaHandle {
  return {
    kind: 'element',
    currentMs: () => element.currentTime * 1000,
    durationMs: () => (Number.isFinite(element.duration) && element.duration > 0 ? element.duration * 1000 : null),
    isPlaying: () => !element.paused && !element.ended,
    play: () => element.play(),
    pause: () => element.pause(),
    seek: (ms) => {
      element.currentTime = Math.max(0, ms / 1000);
    },
    rate: () => element.playbackRate,
    setRate: (rate) => {
      if (element.playbackRate !== rate) element.playbackRate = rate;
    },
    setVolume: (volume, muted) => {
      element.volume = Math.min(1, Math.max(0, volume));
      element.muted = muted;
    },
    ready: () => element.readyState >= HTMLMediaElement.HAVE_METADATA,
  };
}

function youtubeHandle(player: YouTubePlayer, onPlayRequested: () => void): MediaHandle {
  return {
    kind: 'youtube',
    currentMs: () => player.getCurrentTime() * 1000,
    durationMs: () => {
      const seconds = player.getDuration();
      return seconds > 0 ? seconds * 1000 : null;
    },
    isPlaying: () => {
      const state = player.getPlayerState();
      return state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING;
    },
    play: async () => {
      player.playVideo();
      onPlayRequested();
    },
    pause: () => player.pauseVideo(),
    seek: (ms) => player.seekTo(Math.max(0, ms / 1000), true),
    rate: () => 1,
    setRate: () => {},
    setVolume: (volume, muted) => {
      player.setVolume(Math.round(Math.min(1, Math.max(0, volume)) * 100));
      if (muted) player.mute();
      else player.unMute();
    },
    ready: () => true,
  };
}

const SYNC_INTERVAL_MS = 1000;
/** YouTube asked to play but did not start: the browser wants a tap. */
const YOUTUBE_GESTURE_WAIT_MS = 2500;

export interface TogetherPlayerProps {
  session: TogetherSession;
  serverId: string;
  api: TogetherApi;
  /** `stage`: the video fills its box. `bar`: a small cover-sized box. */
  variant: 'stage' | 'bar';
  volume: number;
  muted: boolean;
  onStatus: (status: PlayerStatus) => void;
  className?: string;
}

/**
 * The shared player. It never decides what plays or where: every second it
 * compares its media with the server's expected position and corrects (see
 * lib/together/sync.ts). When the media ends it tells the server, which moves
 * the whole call on.
 */
export function TogetherPlayer({ session, serverId, api, variant, volume, muted, onStatus, className }: TogetherPlayerProps) {
  const item = currentItem(session);
  if (!item) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center bg-bg-well text-meta text-text-muted', className)}>
        The queue is empty
      </div>
    );
  }
  return (
    <ItemPlayer
      // A new item is a new player: nothing of the last one carries over.
      key={item.id}
      item={item}
      session={session}
      serverId={serverId}
      api={api}
      variant={variant}
      volume={volume}
      muted={muted}
      onStatus={onStatus}
      className={className}
    />
  );
}

interface ItemPlayerProps extends TogetherPlayerProps {
  item: TogetherItem;
}

function ItemPlayer({ item, session, serverId, api, variant, volume, muted, onStatus, className }: ItemPlayerProps) {
  const [handle, setHandle] = useState<MediaHandle | null>(null);
  const [status, setStatus] = useState<PlayerStatus>({ aspect: null, durationMs: item.duration_ms, buffering: true, error: null, needsGesture: false });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const lastSeekAt = useRef<number | null>(null);
  const reportedEnd = useRef(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const patchStatus = useCallback((patch: Partial<PlayerStatus>) => {
    setStatus((prev) => {
      const next = { ...prev, ...patch };
      if (
        next.durationMs === prev.durationMs &&
        next.aspect === prev.aspect &&
        next.buffering === prev.buffering &&
        next.error === prev.error &&
        next.needsGesture === prev.needsGesture
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    onStatusRef.current(status);
  }, [status]);

  const reportEnded = useCallback(() => {
    if (reportedEnd.current) return;
    reportedEnd.current = true;
    api.playback(session.channel_id, { action: 'ended', item_id: item.id }).catch(() => {
      // Somebody else's report (or a skip) got there first; the next update
      // moves this player on regardless.
    });
  }, [api, item.id, session.channel_id]);

  const startPlayback = useCallback(
    (media: MediaHandle) => {
      media.play().then(
        () => patchStatus({ needsGesture: false }),
        (error: unknown) => {
          if ((error as { name?: string })?.name === 'NotAllowedError') patchStatus({ needsGesture: true });
        },
      );
    },
    [patchStatus],
  );

  const sync = useCallback(() => {
    const media = handle;
    const current = sessionRef.current;
    if (!media || !media.ready()) return;
    const now = performance.now();
    const expected = expectedPositionMs(current, serverNowMs(serverId));
    const sinceSeek = lastSeekAt.current == null ? null : now - lastSeekAt.current;
    const seek = (ms: number) => {
      media.seek(ms);
      lastSeekAt.current = now;
    };

    if (!current.playing) {
      if (media.isPlaying()) media.pause();
      media.setRate(1);
      if (Math.abs(media.currentMs() - expected) > 30 && (sinceSeek == null || sinceSeek > 500)) seek(expected);
      return;
    }

    const duration = media.durationMs() ?? item.duration_ms;
    if (duration != null && expected >= duration - 250) {
      // By the server's clock this item is over; the queue moves on for everyone.
      reportEnded();
      return;
    }
    if (!media.isPlaying()) {
      if (Math.abs(media.currentMs() - expected) > 250) seek(expected);
      startPlayback(media);
      return;
    }
    const correction = decideCorrection({
      expectedMs: expected,
      actualMs: media.currentMs(),
      currentRate: media.rate(),
      player: media.kind,
      sinceLastSeekMs: sinceSeek,
    });
    if (correction.kind === 'seek') seek(correction.toMs);
    media.setRate(correction.rate);
  }, [handle, item.duration_ms, reportEnded, serverId, startPlayback]);

  // Correct at once on every change of state, then every second.
  useEffect(() => {
    sync();
  }, [sync, session.revision]);
  useEffect(() => {
    const timer = window.setInterval(sync, SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sync]);

  useEffect(() => {
    handle?.setVolume(volume, muted);
  }, [handle, volume, muted]);

  const onTapToStart = () => {
    if (!handle) return;
    handle.setVolume(volume, muted);
    startPlayback(handle);
    sync();
  };

  const media =
    item.source === 'youtube' ? (
      <YouTubeMedia item={item} session={session} serverId={serverId} onHandle={setHandle} onStatus={patchStatus} onEnded={reportEnded} />
    ) : (
      <ElementMedia item={item} onHandle={setHandle} onStatus={patchStatus} onEnded={reportEnded} />
    );

  const showCover = item.source !== 'youtube' && (isAudioItem(item) || variant === 'bar');

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-bg-well', className)} data-together-player={item.source}>
      <div className={cn('absolute inset-0', showCover && 'opacity-0')}>{media}</div>
      {showCover && <TogetherCover item={item} className="absolute inset-0" large={variant === 'stage'} />}
      {status.error && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-bg-well p-4 text-center">
          <p className="max-w-sm text-label text-text-secondary">{status.error}</p>
        </div>
      )}
      {!status.error && status.needsGesture && (
        <button
          type="button"
          aria-label="Tap to start"
          onClick={onTapToStart}
          className={cn(
            'pc-focusable absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-well',
            'text-label text-text-primary',
          )}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-raised shadow-[var(--shadow-lifted)]">
            <Play size={20} aria-hidden />
          </span>
          {variant === 'stage' && 'Tap to start'}
          <span className="sr-only">{variant === 'bar' ? 'Tap to start' : ''}</span>
        </button>
      )}
    </div>
  );
}

function ElementMedia({
  item,
  onHandle,
  onStatus,
  onEnded,
}: {
  item: TogetherItem;
  onHandle: (handle: MediaHandle | null) => void;
  onStatus: (patch: Partial<PlayerStatus>) => void;
  onEnded: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(item.source === 'url' ? item.ref : null);

  // An attachment is fetched with this person's own credentials, like any
  // attachment they open; on the desktop app that is the native bridge.
  useEffect(() => {
    if (item.source !== 'attachment') return;
    let objectUrl: string | null = null;
    let canceled = false;
    fileApi
      .resolveAttachmentObjectUrl(`/api/v1/attachments/${item.ref}`)
      .then((url) => {
        if (canceled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => {
        if (!canceled) onStatus({ error: 'This file could not be loaded. You may not have access to the channel it was posted in.' });
      });
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.ref, item.source, onStatus]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !src) return;
    const handle = elementHandle(element);
    const sink = currentAudioOutputDeviceId();
    const setSink = (element as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (sink && typeof setSink === 'function') {
      void setSink.call(element, sink).catch(() => {
        // The call's own audio reports device problems; this follows it.
      });
    }
    const onMeta = () => {
      const aspect = element.videoWidth > 0 && element.videoHeight > 0 ? element.videoWidth / element.videoHeight : null;
      onStatus({ durationMs: handle.durationMs(), buffering: false, aspect });
      onHandle(handle);
    };
    const onWaiting = () => onStatus({ buffering: true });
    const onPlaying = () => onStatus({ buffering: false, needsGesture: false });
    const onError = () =>
      onStatus({
        error:
          item.source === 'url'
            ? 'This link could not be played on this device. The file may be gone, or its site may not allow playing it here.'
            : 'This file could not be played on this device.',
      });
    element.addEventListener('loadedmetadata', onMeta);
    element.addEventListener('waiting', onWaiting);
    element.addEventListener('playing', onPlaying);
    element.addEventListener('canplay', onPlaying);
    element.addEventListener('ended', onEnded);
    element.addEventListener('error', onError);
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) onMeta();
    return () => {
      element.removeEventListener('loadedmetadata', onMeta);
      element.removeEventListener('waiting', onWaiting);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('canplay', onPlaying);
      element.removeEventListener('ended', onEnded);
      element.removeEventListener('error', onError);
      onHandle(null);
    };
  }, [src, item.source, onEnded, onHandle, onStatus]);

  if (!src) return null;
  return (
    // Shared videos are pasted links and posted files; they come without caption tracks.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      ref={videoRef}
      src={src}
      preload="auto"
      playsInline
      className="h-full w-full object-contain"
      aria-label={item.title}
      data-together-media=""
    />
  );
}

function YouTubeMedia({
  item,
  session,
  serverId,
  onHandle,
  onStatus,
  onEnded,
}: {
  item: TogetherItem;
  session: TogetherSession;
  serverId: string;
  onHandle: (handle: MediaHandle | null) => void;
  onStatus: (patch: Partial<PlayerStatus>) => void;
  onEnded: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Where to start, read once: after that the sync loop steers.
  const startAt = useRef(expectedPositionMs(session, serverNowMs(serverId)) / 1000);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let player: YouTubePlayer | null = null;
    let gestureTimer: number | null = null;
    let disposed = false;
    const frame = createYouTubeFrame(item.ref, startAt.current, item.title);
    host.appendChild(frame);

    const watchForStart = () => {
      if (gestureTimer != null) window.clearTimeout(gestureTimer);
      gestureTimer = window.setTimeout(() => {
        if (!player || disposed) return;
        const state = player.getPlayerState();
        if (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING) onStatus({ needsGesture: true });
      }, YOUTUBE_GESTURE_WAIT_MS);
    };

    loadYouTubeApi()
      .then((YT) => {
        if (disposed) return;
        player = new YT.Player(frame, {
          events: {
            onReady: (event) => {
              if (disposed) return;
              const handle = youtubeHandle(event.target, watchForStart);
              // The IFrame API does not say a video's shape; YouTube frames
              // everything 16:9 and letterboxes inside its own player.
              onStatus({ durationMs: handle.durationMs(), buffering: false, aspect: 16 / 9 });
              onHandle(handle);
            },
            onStateChange: (event) => {
              if (event.data === YT_STATE.ENDED) onEnded();
              if (event.data === YT_STATE.BUFFERING) onStatus({ buffering: true });
              if (event.data === YT_STATE.PLAYING) {
                onStatus({ buffering: false, needsGesture: false, durationMs: event.target.getDuration() * 1000 || null });
              }
            },
            onError: (event) => onStatus({ error: youtubeErrorMessage(event.data) }),
          },
        });
      })
      .catch((error: unknown) => onStatus({ error: error instanceof Error ? error.message : String(error) }));

    return () => {
      disposed = true;
      if (gestureTimer != null) window.clearTimeout(gestureTimer);
      onHandle(null);
      try {
        player?.destroy();
      } catch {
        // the iframe is going with the host either way
      }
      frame.remove();
    };
  }, [item.ref, item.title, onEnded, onHandle, onStatus]);

  return <div ref={hostRef} className="h-full w-full" data-together-media="" />;
}
