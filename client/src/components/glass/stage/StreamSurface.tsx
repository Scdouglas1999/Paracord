import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toastStore';
import { useNativeUnderlay } from './nativeUnderlay';
import { layerFor, useWatchQualityStore } from './StreamSound';

/**
 * The watched stream, 16:9, radius 18 (docs/glass-spec.md §6.1).
 *
 * It draws through the renderers the media layer already has: it hands its
 * `<canvas>` to `engine.subscribeVideo(streamerId, canvas, onFrame, { preferredTrackId: 'screen' })`.
 * In the browser that is WebCodecs into this canvas's WebGL context; in the
 * desktop app it is always a native surface under the page that mirrors this
 * canvas's box, with the canvas carrying the surface's poster while its hole is
 * closed (docs/glass-spec.md §6.6). The engine is the watch's (`watchView.engine`): its own view
 * session, or the call when this client is in it. When the watch moves between
 * the two (joining or leaving the watched call) the engine changes and the
 * subscription is made again on the new one; nothing else re-subscribes (a name
 * resolving late must never blank the stream). The stream's own audio is the
 * store's (`setWatchVolume`), never subscribed here.
 *
 * `children` is the chrome drawn over the stream (the top overlay, the clip
 * toast, reactions). It sits inside `data-native-surface-boundary`, so on the
 * desktop's native route it never counts as covering the video.
 */
export interface StreamSurfaceProps {
  engine: MediaEngine | null;
  streamerId: string;
  /** What to say instead of a picture ("Connecting to Vincent's screen…"); null to show frames. */
  notice: ReactNode;
  /** The picture arrived (first frame), or went away (another subscription). */
  onPicture?: (hasPicture: boolean) => void;
  /**
   * Whether the streamer is sharing now. When it turns false the picture is
   * gone (the last frame is not live), and the stream's next share counts as
   * a new picture: the box waits for its first frame (stream-fix-v2).
   */
  sharing?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function StreamSurface({ engine, streamerId, notice, onPicture, sharing = true, className, style, children }: StreamSurfaceProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  // The picture stopped moving (the native pipeline is recovering from loss,
  // or the streamer's video went quiet): say so instead of showing a frozen
  // frame that still reads as live.
  const [stalled, setStalled] = useState(false);
  const underlayLive = useNativeUnderlay(boxRef, canvasRef);

  const reportRef = useRef(onPicture);
  useEffect(() => {
    reportRef.current = onPicture;
  });
  useEffect(() => {
    reportRef.current?.(hasPicture);
  }, [hasPicture]);

  // A stopped share takes its picture with it (the last frame is not live),
  // and the next share is a new picture: the box waits for its first frame,
  // which the engine reports again (stream-fix-v2).
  const [sharedBefore, setSharedBefore] = useState(sharing);
  if (sharing !== sharedBefore) {
    setSharedBefore(sharing);
    if (!sharing) setHasPicture(false);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const unsubscribe = engine.subscribeVideo(
      streamerId,
      canvas,
      // Called for a share's first frame (the browser engine: every frame; an
      // unchanged state renders nothing).
      () => setHasPicture(true),
      { preferredTrackId: 'screen' },
    );
    const onStall = (event: Event) => {
      setStalled((event as CustomEvent<{ stalled?: boolean }>).detail?.stalled === true);
    };
    canvas.addEventListener('paracord:video-stall', onStall);
    return () => {
      canvas.removeEventListener('paracord:video-stall', onStall);
      unsubscribe();
      setHasPicture(false);
      setStalled(false);
    };
  }, [engine, streamerId]);

  // Viewing quality (Stream sound and quality): a simulcast layer asked of the
  // watch's engine. Auto asks nothing, unless a layer was asked before, which
  // is then released so the relay chooses again.
  const quality = useWatchQualityStore((state) => state.quality);
  const askedLayer = useRef(false);
  useEffect(() => {
    const layer = layerFor(quality);
    if (!engine || (layer === null && !askedLayer.current)) return;
    let canceled = false;
    engine
      .listPublishedTracks()
      .then((tracks) => {
        if (canceled) return undefined;
        const track = tracks.find(
          (entry) => String(entry.publisherUserId) === streamerId && entry.trackId === 'screen' && entry.kind === 'video',
        );
        if (!track) return undefined;
        const canvas = canvasRef.current;
        const ratio = window.devicePixelRatio || 1;
        askedLayer.current = layer !== null;
        return engine.registerTrackSubscription({
          streamId: track.streamId,
          trackId: track.trackId,
          requestedLayer: layer ?? undefined,
          viewport: canvas
            ? {
                width: Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * ratio)),
                height: Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * ratio)),
              }
            : undefined,
        });
      })
      .catch((error: unknown) => {
        if (!canceled) toast.error(`Could not change the viewing quality: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      canceled = true;
    };
  }, [engine, streamerId, quality]);

  const showPicture = hasPicture && !notice;
  const reconnecting = showPicture && stalled;
  return (
    <div
      ref={boxRef}
      className={cn('glass-stage__stream', className)}
      style={style}
      data-native-surface-boundary=""
      data-native-underlay-clear=""
      data-underlay={underlayLive ? 'live' : undefined}
      data-picture={showPicture ? 'true' : undefined}
      data-video-stalled={reconnecting ? 'true' : undefined}
    >
      <canvas
        ref={canvasRef}
        className="glass-stage__canvas"
        data-stream-canvas=""
        aria-hidden="true"
        style={{
          // The native route: this box IS the hole. The WebGL context is opaque
          // even when undrawn, so the canvas stops painting while the surface
          // below is live; it keeps its layout box, which the surface mirrors.
          opacity: showPicture && !underlayLive ? 1 : 0,
          visibility: underlayLive ? 'hidden' : 'visible',
        }}
      />
      {reconnecting && (
        <div className="glass-stage__reconnecting" role="status">
          <span className="glass-stage__reconnecting-label">Reconnecting video…</span>
        </div>
      )}
      {notice && (
        <div className="glass-stage__notice" role="status">
          {notice}
        </div>
      )}
      {children}
    </div>
  );
}
