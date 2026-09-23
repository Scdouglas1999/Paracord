import { useEffect, useRef, useState } from 'react';
import { landscapeStage } from './timeline';

/**
 * A phone on its side: a touch screen whose screen reports landscape, with a
 * short, wide viewport. A desktop window dragged short is not one, and neither
 * is a portrait phone whose keyboard has squeezed the viewport.
 */
export function isSidewaysPhone(view: Window = window): boolean {
  if (typeof view.matchMedia !== 'function') return false;
  if (!view.matchMedia('(pointer: coarse)').matches) return false;
  const type = view.screen?.orientation?.type ?? '';
  if (!type.startsWith('landscape')) return false;
  return landscapeStage(view.innerWidth, view.innerHeight);
}

/**
 * Whether the phone is on its side. `onTurn` hears each change as it happens,
 * from the resize or orientation event, never on the first render.
 */
export function useSidewaysPhone(onTurn?: (sideways: boolean) => void): boolean {
  const [sideways, setSideways] = useState(() => (typeof window === 'undefined' ? false : isSidewaysPhone()));
  const listener = useRef(onTurn);
  useEffect(() => {
    listener.current = onTurn;
  });
  useEffect(() => {
    let last = isSidewaysPhone();
    const read = () => {
      const next = isSidewaysPhone();
      if (next === last) return;
      last = next;
      setSideways(next);
      listener.current?.(next);
    };
    const orientation = window.screen?.orientation;
    window.addEventListener('resize', read);
    orientation?.addEventListener?.('change', read);
    return () => {
      window.removeEventListener('resize', read);
      orientation?.removeEventListener?.('change', read);
    };
  }, []);
  return sideways;
}

/** Someone typing keeps the chat: turning the phone mid-sentence should not take it away. */
export function editingText(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  const tag = active.tagName;
  return tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes((active as HTMLInputElement).type));
}
