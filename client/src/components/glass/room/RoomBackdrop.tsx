import { useEffect, useRef } from 'react';

import { createCanvasAnalyzer } from '../../../lib/room/analyzeFrame';
import { loadFixtureStreamSource, roomFixtureRequested } from '../../../lib/room/devFixture';
import type { FrameSource } from '../../../lib/room/frameSource';
import { createImageFrameSource } from '../../../lib/room/imageFrameSource';
import { ROOM_GRID_HEIGHT, ROOM_GRID_WIDTH } from '../../../lib/room/pixels';
import {
  createRoomController,
  type RoomController,
  type RoomLayer,
  type RoomSourceRequest,
} from '../../../lib/room/roomController';
import type { RoomSourceSpec } from '../../../lib/room/sources';
import { createRoomTokenWriter } from '../../../lib/room/tokenWriter';
import { createViewFrameSource } from '../../../lib/room/viewFrameSource';
import { useReducedMotion } from '../../../lib/motion/reducedMotion';
import type { RoomBackdropProps } from '../shell/slots';
import { useRoomSource } from './useRoomSource';

/**
 * Frames a second asked of each kind of source. The ambient view carries
 * keyframes only, at most one a second (WP-G6), so asking more finds nothing
 * new; the watched stream is sampled at 3. Under reduced motion a stream is
 * sampled once every four seconds, so the room drifts rather than follows.
 */
const HZ = { ambient: 1, watch: 3, still: 1, reducedStream: 0.25 } as const;

/** A canvas as one of the room's two layers. */
function canvasLayer(canvas: HTMLCanvasElement): RoomLayer {
  let context: CanvasRenderingContext2D | null = null;
  let image: ImageData | null = null;
  return {
    paint(rgba) {
      if (!context) context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      if (!image) image = context.createImageData(ROOM_GRID_WIDTH, ROOM_GRID_HEIGHT);
      image.data.set(rgba);
      context.putImageData(image, 0, 0);
    },
    setLit(lit) {
      canvas.dataset.lit = lit ? 'true' : 'false';
    },
  };
}

const reducedTransparency = () =>
  document.documentElement.getAttribute('data-reduced-transparency') === 'true';

async function frameSourceFor(spec: Exclude<RoomSourceSpec, { kind: 'none' }>): Promise<FrameSource> {
  if (spec.kind === 'image') return createImageFrameSource(spec.url);
  if (roomFixtureRequested() && loadFixtureStreamSource) return loadFixtureStreamSource();
  return createViewFrameSource(spec.view, spec.streamerId);
}

/**
 * The room (docs/glass-spec.md §4): one small canvas behind both panes, lit by
 * what is live in the current server, or its banner, or its icon. Two canvases
 * so a change of source crossfades (1.2 s); only one is painted at a time, at
 * 32x18, and the browser scales it to the window. The same controller writes
 * `--room-rgb`, which tints every surface.
 *
 * `data-native-underlay-clear`: on the Linux native-video route the backdrop
 * goes transparent with the rest of the ancestor chain (and the canvases hide),
 * so the hole the video shows through is not covered.
 */
export function RoomBackdrop({ guildId }: RoomBackdropProps) {
  const spec = useRoomSource(guildId);
  const reducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const layerA = useRef<HTMLCanvasElement>(null);
  const layerB = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<RoomController | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const a = layerA.current;
    const b = layerB.current;
    if (!root || !a || !b) return;
    const controller = createRoomController({
      layers: [canvasLayer(a), canvasLayer(b)],
      writer: createRoomTokenWriter(document.documentElement),
      analyze: createCanvasAnalyzer(),
      reducedTransparency,
      onPhase: (phase) => {
        root.dataset.roomPhase = phase;
      },
    });
    controllerRef.current = controller;

    const onVisibility = () => controller.setVisible(document.visibilityState !== 'hidden');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    // Reduced transparency takes the blur away (spec §4): re-read the source.
    const observer = new MutationObserver(() => controller.refresh());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-transparency'] });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const key = spec.key === null ? null : `${spec.key}${reducedMotion ? '|reduced-motion' : ''}`;
  useEffect(() => {
    const controller = controllerRef.current;
    const root = rootRef.current;
    if (!controller || !root) return;
    root.dataset.roomSource = spec.kind === 'none' ? 'none' : spec.kind === 'image' ? spec.role : `stream-${spec.view}`;
    if (spec.kind === 'none' || key === null) {
      controller.setSource(null);
      return;
    }
    let canceled = false;
    let made: FrameSource | null = null;
    void frameSourceFor(spec).then(
      (source) => {
        made = source;
        if (canceled) return;
        const hz =
          spec.kind === 'image'
            ? HZ.still
            : reducedMotion
              ? HZ.reducedStream
              : spec.view === 'watch'
                ? HZ.watch
                : HZ.ambient;
        const request: RoomSourceRequest = {
          key,
          source,
          grade: spec.kind === 'image' ? 'still' : 'stream',
          hz,
        };
        controller.setSource(request);
      },
      (error: unknown) => {
        console.error('[room] the source that lights this room could not be created', {
          source: key,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      canceled = true;
      // A still holds its decoded bitmap; let it go once the room has moved on.
      const source = made as (FrameSource & { dispose?: () => void }) | null;
      if (source?.dispose) setTimeout(() => source.dispose?.(), 0);
    };
    // `spec` is identified by its key; the rest of it follows the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className="glass-room-backdrop"
      data-native-underlay-clear=""
      data-room-guild={guildId ?? undefined}
    >
      <canvas ref={layerA} className="glass-room-backdrop__layer" width={ROOM_GRID_WIDTH} height={ROOM_GRID_HEIGHT} data-lit="false" />
      <canvas ref={layerB} className="glass-room-backdrop__layer" width={ROOM_GRID_WIDTH} height={ROOM_GRID_HEIGHT} data-lit="false" />
    </div>
  );
}
