import axios from 'axios';
import { create } from 'zustand';

import { extractApiError } from '../api/client';
import type { StreamReaction, StreamReactionKind, StreamReactions } from '../api/generated/StreamReactions';
import { createCallVoiceApi } from '../api/voice';
import { captureOperationContext } from '../lib/operationContext';
import { prefersReducedMotion } from '../lib/motion/reducedMotion';
import { getServerUser } from '../lib/serverIdentity';
import { toast } from './toastStore';

/**
 * Reactions on the stream (docs/glass-spec.md §6.5): the bubbles rising over
 * the stream you are watching, and the one-a-second sender behind the flame and
 * heart buttons.
 *
 * Receiving. `STREAM_REACTIONS` reaches everyone in the call or watching it,
 * for every stream in the channel. Only a stream with a layer on screen keeps
 * its reactions (`watch`); the rest are dropped on arrival, so a call member
 * who is not watching holds no bubbles and no timers.
 *
 * Sending. Your own tap draws at once. The server takes one request a second
 * per person, so taps inside that second are merged into the next request
 * (`count`) instead of being sent or thrown away. The request carries a nonce;
 * the echo that comes back with it is dropped, because it is already drawn. A
 * 429 puts the taps back and waits for `Retry-After`; any other failure says so.
 *
 * Busy. A stream shows at most {@link MAX_LIVE} bubbles. Once {@link BUSY} are
 * rising, a new reaction joins the youngest bubble of the same kind (its count
 * goes up) instead of adding another.
 */

export type { StreamReactionKind };

/** The kinds this client can draw. A newer server's other kinds are skipped. */
export const DRAWABLE_KINDS: readonly StreamReactionKind[] = ['flame', 'heart'];

/** One request a second per person (the server's limit). */
export const SEND_INTERVAL_MS = 1000;
/** The most taps one request carries (`MAX_STREAM_REACTION_COUNT`). */
export const MAX_COUNT = 20;
/** From this many rising bubbles on, a new reaction merges into one of them. */
export const BUSY = 6;
/** Never more than this many bubbles on one stream. */
export const MAX_LIVE = 10;
/** How young a bubble must be to take a merge (it is still low on the stream). */
export const MERGE_WINDOW_MS = 900;
/** Someone else's bubble: the rise (§6.5, ~270px) and the fade. */
export const RISE_MS = 2600;
/** Your own bubble: the reference's `floatOnce`, a little longer and higher. */
export const OWN_RISE_MS = 2800;
/** Reduced motion: the bubble appears in place, briefly, and goes. */
export const STILL_MS = 1600;
/** An unanswered nonce is forgotten after this long. */
const NONCE_TTL_MS = 15_000;

/** Horizontal offsets inside the 72px column, in turn (the reference's). */
const LANES = [8, 22, 2, 16, 26, 12] as const;

/** The stream a bubble belongs to: one instance, one channel, one streamer. */
export function streamKey(serverId: string, channelId: string, streamerId: string): string {
  return `${serverId}\u0000${channelId}\u0000${streamerId}`;
}

export interface StreamBubble {
  id: string;
  key: string;
  kind: StreamReactionKind;
  /** Taps this bubble stands for (merged taps, merged senders). */
  count: number;
  own: boolean;
  userId: string;
  name: string;
  avatar: string | null;
  /** Offset from the column's left edge, px. */
  lane: number;
  bornAt: number;
  /** Drawn without motion (reduced motion was on when it arrived). */
  still: boolean;
}

export interface StreamReactionTarget {
  serverId: string;
  channelId: string;
  streamerId: string;
}

interface StreamReactionState {
  bubbles: readonly StreamBubble[];
  /** Streams with a layer on screen, with how many layers show each. */
  watching: ReadonlyMap<string, number>;
  /** Show this stream's reactions while the returned function is not called. */
  watch: (key: string) => () => void;
  /** `STREAM_REACTIONS` from the gateway of `serverId`. */
  receive: (serverId: string, payload: StreamReactions) => void;
  /** React to a stream: draws now, sends within the limit. */
  send: (target: StreamReactionTarget, kind: StreamReactionKind) => void;
  remove: (id: string) => void;
  /** Tests and logout. */
  reset: () => void;
}

export function isStreamReactions(data: unknown): data is StreamReactions {
  const value = data as Partial<StreamReactions> | null;
  return (
    !!value
    && typeof value.guild_id === 'string' && !!value.guild_id
    && typeof value.channel_id === 'string' && !!value.channel_id
    && Array.isArray(value.reactions)
    && value.reactions.every(isStreamReaction)
  );
}

function isStreamReaction(value: unknown): value is StreamReaction {
  const reaction = value as Partial<StreamReaction> | null;
  return (
    !!reaction
    && typeof reaction.user_id === 'string'
    && typeof reaction.stream_user_id === 'string'
    && typeof reaction.kind === 'string'
    && typeof reaction.count === 'number' && Number.isInteger(reaction.count) && reaction.count >= 1
    && (reaction.nonce === null || typeof reaction.nonce === 'string')
    && typeof reaction.username === 'string'
    && (reaction.display_name === null || typeof reaction.display_name === 'string')
    && (reaction.avatar_hash === null || typeof reaction.avatar_hash === 'string')
  );
}

function drawable(kind: string): kind is StreamReactionKind {
  return (DRAWABLE_KINDS as readonly string[]).includes(kind);
}

/* ---- Module state: timers, nonces, the outbox --------------------------------- */

let sequence = 0;
const expiry = new Map<string, ReturnType<typeof setTimeout>>();
/** Nonces of requests this client sent, to drop their echoes. */
const ownNonces = new Map<string, number>();
const warnedKinds = new Set<string>();

interface PendingTaps {
  /** The account that tapped: taps never outlive a sign-out or an account switch. */
  userId: string;
  target: StreamReactionTarget;
  kind: StreamReactionKind;
  count: number;
}

/** One per instance: the server's limit is per person on that instance. */
interface Outbox {
  pending: Map<string, PendingTaps>;
  /** No request before this time (ms). */
  nextAt: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const outboxes = new Map<string, Outbox>();

function outboxFor(serverId: string): Outbox {
  let outbox = outboxes.get(serverId);
  if (!outbox) {
    outbox = { pending: new Map(), nextAt: 0, inFlight: false, timer: null };
    outboxes.set(serverId, outbox);
  }
  return outbox;
}

function newNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rememberNonce(nonce: string, now: number): void {
  for (const [known, at] of ownNonces) {
    if (now - at > NONCE_TTL_MS) ownNonces.delete(known);
  }
  ownNonces.set(nonce, now);
}

/** How long a 429 says to wait, in ms (at least the interval). */
function retryAfterMs(error: unknown): number | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return null;
  const header = Number(error.response.headers?.['retry-after']);
  const body = Number((error.response.data as { retry_after?: unknown } | undefined)?.retry_after);
  const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(body) && body > 0 ? body : 1;
  return Math.max(SEND_INTERVAL_MS, seconds * 1000);
}

function schedule(serverId: string, outbox: Outbox, delay: number): void {
  if (outbox.timer) return;
  outbox.timer = setTimeout(() => {
    outbox.timer = null;
    pump(serverId);
  }, delay);
}

/** Send the oldest waiting taps if the limit allows, else wait for it. */
function pump(serverId: string): void {
  const outbox = outboxFor(serverId);
  if (outbox.inFlight || outbox.timer) return;
  const first = outbox.pending.entries().next();
  if (first.done) return;
  const now = Date.now();
  if (now < outbox.nextAt) {
    schedule(serverId, outbox, outbox.nextAt - now);
    return;
  }
  const [slot, taps] = first.value;
  const count = Math.min(taps.count, MAX_COUNT);
  if (taps.count > count) taps.count -= count;
  else outbox.pending.delete(slot);

  let context: ReturnType<typeof captureOperationContext>;
  try {
    context = captureOperationContext(serverId);
  } catch (error) {
    outbox.pending.clear();
    toast.error(`Your reaction was not sent: ${extractApiError(error)}`);
    return;
  }
  if (context.scope.userId !== taps.userId) {
    // Tapped by an account that is no longer the one signed in here.
    context.dispose();
    pump(serverId);
    return;
  }

  const nonce = newNonce();
  rememberNonce(nonce, now);
  outbox.inFlight = true;
  createCallVoiceApi(context)
    .streamReaction(taps.target.channelId, {
      kind: taps.kind,
      stream_user_id: taps.target.streamerId,
      count,
      nonce,
    })
    .then(
      () => {
        // Measured from the answer: the server saw this request before it
        // answered, so the next one cannot reach it inside the same second.
        outbox.nextAt = Date.now() + SEND_INTERVAL_MS;
      },
      (error: unknown) => {
        ownNonces.delete(nonce);
        const wait = retryAfterMs(error);
        if (wait !== null) {
          // Busy: put the taps back in front and try again when allowed.
          const again = outbox.pending.get(slot);
          if (again) again.count += count;
          else outbox.pending = new Map([[slot, { ...taps, count }], ...outbox.pending]);
          outbox.nextAt = Date.now() + wait;
          return;
        }
        outbox.nextAt = Date.now() + SEND_INTERVAL_MS;
        toast.error(`Your reaction was not sent: ${extractApiError(error)}`);
      },
    )
    .finally(() => {
      context.dispose();
      outbox.inFlight = false;
      if (outbox.pending.size > 0) pump(serverId);
    });
}

/* ---- The store ---------------------------------------------------------------- */

export const useStreamReactionStore = create<StreamReactionState>()((set, get) => {
  const expire = (id: string, lifetime: number) => {
    expiry.set(
      id,
      setTimeout(() => get().remove(id), lifetime),
    );
  };

  /** Add a bubble, or merge it into a young one of the same kind when busy. */
  const add = (incoming: Omit<StreamBubble, 'id' | 'lane' | 'bornAt' | 'still'>) => {
    const now = Date.now();
    const still = prefersReducedMotion();
    const state = get();
    const live = state.bubbles.filter((bubble) => bubble.key === incoming.key);
    if (live.length >= BUSY) {
      const full = live.length >= MAX_LIVE;
      const host = [...live]
        .reverse()
        .find((bubble) => bubble.kind === incoming.kind && bubble.own === incoming.own && (full || now - bubble.bornAt <= MERGE_WINDOW_MS));
      if (host) {
        set({
          bubbles: state.bubbles.map((bubble) =>
            bubble.id === host.id ? { ...bubble, count: bubble.count + incoming.count } : bubble,
          ),
        });
        return;
      }
    }
    let bubbles = state.bubbles;
    if (live.length >= MAX_LIVE) {
      const oldest = live[0];
      clearTimeout(expiry.get(oldest.id));
      expiry.delete(oldest.id);
      bubbles = bubbles.filter((bubble) => bubble.id !== oldest.id);
    }
    sequence += 1;
    const bubble: StreamBubble = {
      ...incoming,
      id: `reaction-${sequence}`,
      lane: LANES[sequence % LANES.length],
      bornAt: now,
      still,
    };
    set({ bubbles: [...bubbles, bubble] });
    expire(bubble.id, still ? STILL_MS : incoming.own ? OWN_RISE_MS : RISE_MS);
  };

  return {
    bubbles: [],
    watching: new Map(),

    watch: (key) => {
      set((state) => {
        const watching = new Map(state.watching);
        watching.set(key, (watching.get(key) ?? 0) + 1);
        return { watching };
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set((state) => {
          const watching = new Map(state.watching);
          const left = (watching.get(key) ?? 1) - 1;
          if (left > 0) {
            watching.set(key, left);
            return { watching };
          }
          watching.delete(key);
          // Nobody shows this stream any more: its bubbles go with it.
          const bubbles = state.bubbles.filter((bubble) => {
            if (bubble.key !== key) return true;
            clearTimeout(expiry.get(bubble.id));
            expiry.delete(bubble.id);
            return false;
          });
          return { watching, bubbles };
        });
      };
    },

    receive: (serverId, payload) => {
      for (const reaction of payload.reactions) {
        const key = streamKey(serverId, payload.channel_id, reaction.stream_user_id);
        if (!get().watching.has(key)) continue;
        if (reaction.nonce && ownNonces.delete(reaction.nonce)) continue; // our own, already drawn
        if (!drawable(reaction.kind)) {
          if (!warnedKinds.has(reaction.kind)) {
            warnedKinds.add(reaction.kind);
            console.warn(`[stream reactions] this version cannot draw "${reaction.kind}" reactions; skipping them`);
          }
          continue;
        }
        add({
          key,
          kind: reaction.kind,
          count: Math.min(reaction.count, MAX_COUNT),
          own: false,
          userId: reaction.user_id,
          name: reaction.display_name || reaction.username,
          avatar: reaction.avatar_hash,
        });
      }
    },

    send: (target, kind) => {
      const key = streamKey(target.serverId, target.channelId, target.streamerId);
      const userId = getServerUser(target.serverId)?.id;
      if (!userId) {
        toast.error('Sign in to this instance to react.');
        return;
      }
      add({ key, kind, count: 1, own: true, userId, name: '', avatar: null });
      const outbox = outboxFor(target.serverId);
      const slot = `${userId}\u0000${key}\u0000${kind}`;
      const taps = outbox.pending.get(slot);
      if (taps) taps.count += 1;
      else outbox.pending.set(slot, { userId, target, kind, count: 1 });
      pump(target.serverId);
    },

    remove: (id) => {
      clearTimeout(expiry.get(id));
      expiry.delete(id);
      set((state) => {
        const bubbles = state.bubbles.filter((bubble) => bubble.id !== id);
        return bubbles.length === state.bubbles.length ? state : { bubbles };
      });
    },

    reset: () => {
      for (const timer of expiry.values()) clearTimeout(timer);
      expiry.clear();
      ownNonces.clear();
      for (const outbox of outboxes.values()) if (outbox.timer) clearTimeout(outbox.timer);
      outboxes.clear();
      warnedKinds.clear();
      sequence = 0;
      set({ bubbles: [], watching: new Map() });
    },
  };
});
