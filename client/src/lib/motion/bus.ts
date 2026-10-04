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

import type { SendOrigin } from './sendFlight';

export interface MotionEvents {
  /**
   * A plain text message is leaving the composer for this channel — emitted on
   * the keystroke, before anything is awaited. `origin` says where the words
   * sit (null where nothing may fly: reduced motion), so the timeline can send
   * a bubble from there to where the row will land (`sendFlight.ts`).
   */
  'say:sent': {
    channelId: string;
    nonce: string;
    text: string;
    /** The message being replied to, so the row it lands on has the room it needs. */
    replyToId?: string | null;
    origin: SendOrigin | null;
  };
  /**
   * The composer has finished with this send. `ok` is that it was accepted
   * (the outbox owns delivery from here); `false` is that it was not — the
   * draft is restored, or the delivery needs attention — and the bubble in
   * flight is to be let go of.
   */
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
