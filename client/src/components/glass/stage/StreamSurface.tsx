import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { cn } from '../../../lib/utils';
import { useNativeUnderlay } from './nativeUnderlay';

/**
 * The watched stream, 16:9, radius 18 (docs/glass-spec.md §6.1).
 *
 * It draws through the renderers the media layer already has: it hands its
 * `<canvas>` to `engine.subscribeVideo(streamerId, canvas, onFrame, { preferredTrackId: 'screen' })`,
 * which decides the route once for the track (WebCodecs into this canvas's WebGL
 * context, or a native surface that mirrors this canvas's box) and never
 * switches it. The engine is the watch's (`watchView.engine`): its own view
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
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function StreamSurface({ engine, streamerId, notice, onPicture, className, style, children }: StreamSurfaceProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const underlayLive = useNativeUnderlay(boxRef, canvasRef);

  const reportRef = useRef(onPicture);
  useEffect(() => {
    reportRef.current = onPicture;
  });
  useEffect(() => {
    reportRef.current?.(hasPicture);
  }, [hasPicture]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    let sawFrame = false;
    const unsubscribe = engine.subscribeVideo(
      streamerId,
      canvas,
      () => {
        if (sawFrame) return;
        sawFrame = true;
        setHasPicture(true);
      },
      { preferredTrackId: 'screen' },
    );
    return () => {
      unsubscribe();
      setHasPicture(false);
    };
  }, [engine, streamerId]);

  const showPicture = hasPicture && !notice;
  return (
    <div
      ref={boxRef}
      className={cn('glass-stage__stream', className)}
      style={style}
      data-native-surface-boundary=""
      data-native-underlay-clear=""
      data-underlay={underlayLive ? 'live' : undefined}
      data-picture={showPicture ? 'true' : undefined}
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
      {notice && (
        <div className="glass-stage__notice" role="status">
          {notice}
        </div>
      )}
      {children}
    </div>
  );
}
