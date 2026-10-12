import { useEffect, useState, type CSSProperties } from 'react';
import { create } from 'zustand';

import { Preview } from './preview/Preview';
import type { PreviewModel } from './preview/model';
import './firstRun.css';
import './preview/preview.css';

/**
 * The end of the Done transition (docs/setup-spec.md §1.13): the preview has
 * grown to the full window; the route has moved to the server's `general`;
 * the real app mounts underneath, and once it has drawn its frame this layer
 * crossfades out (120 ms) and goes away.
 *
 * Rendered by App outside the routes, so it outlives the first-run page.
 */

interface HandoffState {
  model: PreviewModel | null;
  hue: number;
  start: (model: PreviewModel, hue: number) => void;
  clear: () => void;
}

export const useHandoffStore = create<HandoffState>()((set) => ({
  model: null,
  hue: 18,
  start: (model, hue) => set({ model, hue }),
  clear: () => set({ model: null }),
}));

/** The app shell has drawn (the Index frame is on screen). */
function appDrawn(): boolean {
  return Boolean(document.querySelector('.ix-frame, [data-testid="ix-frame"]'));
}

const FADE_MS = 120;
/** Never hold the picture longer than this, whatever the app is doing. */
const LONGEST_MS = 4_000;

export function FirstRunHandoff() {
  const model = useHandoffStore((s) => s.model);
  const hue = useHandoffStore((s) => s.hue);
  const clear = useHandoffStore((s) => s.clear);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!model) {
      setLeaving(false);
      return;
    }
    let frame = 0;
    let fade = 0;
    const startedAt = performance.now();
    // A handful of frames while the shell's chunk and first data arrive; nothing runs once it is drawn.
    const wait = () => {
      if (appDrawn() || performance.now() - startedAt > LONGEST_MS) {
        setLeaving(true);
        fade = window.setTimeout(clear, FADE_MS);
        return;
      }
      frame = requestAnimationFrame(wait);
    };
    frame = requestAnimationFrame(wait);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fade);
    };
  }, [model, clear]);

  if (!model) return null;
  return (
    <div className="fr-handoff" data-leaving={leaving ? '' : undefined} style={{ '--fr-hue': hue } as CSSProperties} aria-hidden="true" data-testid="fr-handoff">
      <Preview model={model} badge={false} />
    </div>
  );
}
