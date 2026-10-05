import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { commit, crossfadeLayers, onSettle } from '../motion';

/**
 * The window tint (docs/index-spec.md §2.2, §5.1): the current place's hue as a
 * stack of layers behind a column. A hue change adds a new layer ABOVE the old
 * one and fades it in (410ms ease); when the fade settles, the layers under it
 * are removed. `--ix-hue` is set once per layer and never animated.
 *
 *   kind="side"  the sidebar's three-stop gradient (`.ix-hue-side`)
 *   kind="main"  main's glow over `--ix-main` (`.ix-hue-main`)
 *
 * A second change before the first fade settles commits the first (it jumps to
 * opaque and the layers under it go) and fades the new one in over it: never
 * more than two layers, never a queue. At rest there is exactly one layer and
 * nothing running.
 *
 * Every layer is `data-native-underlay-clear`: while a stream draws on the
 * native surface beneath the webview, the tint must go transparent with the
 * rest of the chain above the video (styles/layout.css).
 */

interface Layer {
  id: number;
  hue: number;
}

export interface TintLayersProps {
  hue: number;
  kind: 'side' | 'main';
}

export function TintLayers({ hue, kind }: TintLayersProps) {
  const [layers, setLayers] = useState<Layer[]>(() => [{ id: 0, hue }]);
  const elements = useRef(new Map<number, HTMLDivElement>());
  const running = useRef<Animation | null>(null);
  const settled = useRef<() => void>(() => {});

  // A new hue: a new layer on top (render), then its fade (layout effect below).
  const top = layers[layers.length - 1];
  if (top.hue !== hue) {
    // Cut short a fade still running: the layer it was fading in is the only one
    // kept under the new one. The top layer always has the highest id.
    setLayers([top, { id: top.id + 1, hue }]);
  }

  const topId = layers[layers.length - 1].id;
  useLayoutEffect(() => {
    if (layers.length < 2) return;
    // Commit the previous fade (its own settle is disposed: this one takes over).
    settled.current();
    commit([running.current]);
    const animation = crossfadeLayers(elements.current.get(topId) ?? null, { id: `ix-tint:${kind}` });
    running.current = animation;
    settled.current = onSettle([animation], () => {
      running.current = null;
      setLayers((current) => current.filter((layer) => layer.id === topId));
    });
    // Only a new top layer starts a fade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topId]);

  useLayoutEffect(
    () => () => {
      settled.current();
      running.current?.cancel();
    },
    [],
  );

  return (
    <>
      {layers.map((layer) => (
        <div
          key={layer.id}
          ref={(element) => {
            if (element) elements.current.set(layer.id, element);
            else elements.current.delete(layer.id);
          }}
          aria-hidden="true"
          data-native-underlay-clear=""
          data-ix-tint={kind}
          data-hue={layer.hue}
          className={`ix-tint ${kind === 'side' ? 'ix-hue-side' : 'ix-hue-main'}`}
          style={{ '--ix-hue': layer.hue } as CSSProperties}
        />
      ))}
    </>
  );
}
