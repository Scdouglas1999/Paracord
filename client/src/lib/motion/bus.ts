/**
 * A four-line event bus for the moments that cross a component boundary.
 *
 * §5.1's "a message has mass" ends with *the room's amber window flickers* —
 * and the window lives in the room header while the send lives in the composer,
 * two panes apart with no shared owner. Threading a ref through the layout to
 * say "flicker now" would put motion into the data model; a store would make a
 * one-frame gesture part of application state. So: a bus, carrying gestures
 * only. Nothing here is state, nothing here is persisted, and a missed event is
 * a missed animation and nothing else.
 */

export interface MotionEvents {
  /** A message left the composer for this channel. */
  'say:sent': { channelId: string; nonce: string };
  /** The server answered: this channel's send landed (or did not). */
  'say:settled': { channelId: string; nonce: string; ok: boolean };
}

type Handler<K extends keyof MotionEvents> = (detail: MotionEvents[K]) => void;

const handlers = new Map<string, Set<Handler<never>>>();

/** Subscribe to one gesture. Returns an unsubscribe. */
export function onMotion<K extends keyof MotionEvents>(event: K, handler: Handler<K>): () => void {
  const set = handlers.get(event) ?? new Set();
  handlers.set(event, set);
  set.add(handler as Handler<never>);
  return () => {
    set.delete(handler as Handler<never>);
  };
}

/** Fire one gesture. A throwing listener never breaks the sender. */
export function emitMotion<K extends keyof MotionEvents>(event: K, detail: MotionEvents[K]): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      (handler as Handler<K>)(detail);
    } catch {
      /* a listener that throws loses its animation, not the send */
    }
  }
}

/** Test seam. */
export function resetMotionBusForTests(): void {
  handlers.clear();
}
