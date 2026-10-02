import { useEffect, useMemo, useRef, useState } from 'react';
import { Heart } from 'lucide-react';

import {
  streamKey,
  useStreamReactionStore,
  type StreamBubble,
  type StreamReactionKind as WireReactionKind,
} from '../../../stores/streamReactionStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { Face } from '../places/Lead';
import { FlameGlyph } from '../primitives';
import './StreamReactionsLayer.css';

/**
 * Reactions on the stream (docs/glass-spec.md §6.5, WP-G17): flame and heart
 * float up from the bottom right of the stream for everyone watching, each with
 * the sender's face in its corner, rising about 270px and fading.
 *
 * `useStreamReactions` drives the stage's flame and heart buttons (and their
 * More entries on a narrow pane); `StreamReactionsLayer` draws the bubbles. The
 * store (`stores/streamReactionStore.ts`) owns the gateway event, the queue, the
 * merging and the one-a-second sender.
 *
 * Mount point: the stage renders `<StreamReactionsLayer target=… />` inside the
 * stream box (chrome over the video, inside the native-surface boundary). The
 * layer places itself 24px in from the box's bottom right; a stage that needs
 * it elsewhere (theater) sets `--stream-reactions-right` and
 * `--stream-reactions-bottom` on an ancestor. It never takes pointer events.
 *
 * Screen readers. The bubbles are pictures (`aria-hidden`), so the layer also
 * keeps a visually hidden, polite live region that says what they show:
 * "Brendan reacted with a flame". It speaks at most once every
 * {@link ANNOUNCE_INTERVAL_MS}: reactions that arrive in between are held and
 * said together ("3 reactions") when the interval is up, so a busy stream is one
 * short line every couple of seconds and never a queue of them. Your own
 * reactions are never said (you just pressed the button). The region is always
 * in the page, because a live region that appears with its text is not reliably
 * announced.
 */

/** The most often the live region speaks; reactions in between are merged. */
export const ANNOUNCE_INTERVAL_MS = 2000;
/** How long a sentence stays in the live region before it is cleared. */
const ANNOUNCE_CLEAR_MS = 6000;

/**
 * The stage's name for a kind. The stage's buttons were written against
 * `'fire'` (WP-G14); the wire says `flame`. `toWireKind` is the one place the
 * two meet.
 */
export type StreamReactionKind = 'fire' | 'heart';

export function toWireKind(kind: StreamReactionKind): WireReactionKind {
  return kind === 'fire' ? 'flame' : 'heart';
}

/** The stream being reacted to: the watch's target. */
export interface StreamReactionTarget {
  serverId: string;
  /** The server, or null for a direct message call (no reactions there). */
  guildId: string | null;
  channelId: string;
  streamerId: string;
}

export interface StreamReactions {
  available: boolean;
  /** Why not, for the buttons' tooltips; null when available. */
  unavailableReason: string | null;
  /** Send one reaction. At most one a second per person is sent; the rest merge (§6.5). */
  send: (kind: StreamReactionKind) => void;
}

const DM_ONLY = 'Reactions on the stream are for server voice channels.';
const NOT_WATCHING = 'You can react once the stream is on your screen.';

const noop = () => {};

/**
 * Whether this client may react to `target` now: the server takes reactions
 * from people in the channel's call (joined or listening) and from people
 * watching it through a view session, and this mirrors that. A watch that is
 * still connecting cannot react yet.
 */
export function useStreamReactions(target: StreamReactionTarget | null): StreamReactions {
  const inCall = useVoiceStore((state) =>
    Boolean(
      target
        && state.callScope?.serverId === target.serverId
        && state.channelId === target.channelId
        && state.callPhase === 'connected',
    ),
  );
  const watching = useVoiceStore((state) => {
    const view = state.watchView;
    return Boolean(
      target
        && view
        && view.phase === 'live'
        && view.scope.serverId === target.serverId
        && view.channelId === target.channelId
        && view.streamerId === target.streamerId,
    );
  });

  const serverId = target?.serverId ?? null;
  const channelId = target?.channelId ?? null;
  const streamerId = target?.streamerId ?? null;
  const dm = !target || target.guildId === null;
  const available = !dm && (inCall || watching);

  return useMemo<StreamReactions>(() => {
    if (!serverId || !channelId || !streamerId || dm) {
      return { available: false, unavailableReason: DM_ONLY, send: noop };
    }
    if (!available) return { available: false, unavailableReason: NOT_WATCHING, send: noop };
    return {
      available: true,
      unavailableReason: null,
      send: (kind) => useStreamReactionStore.getState().send({ serverId, channelId, streamerId }, toWireKind(kind)),
    };
  }, [serverId, channelId, streamerId, dm, available]);
}

export interface StreamReactionsLayerProps {
  target: StreamReactionTarget;
}

/** Bubbles in reduced motion stack in place, one row each, bottom up. */
const STILL_ROW_PX = 52;
const STILL_ROWS = 6;

const EMPTY: readonly StreamBubble[] = [];

/** What one bubble added since the announcer last looked. */
interface Arrival {
  /** Who, when one new bubble from one person is all it is; null for a merge. */
  name: string | null;
  kind: StreamBubble['kind'];
  /** Reactions it stands for. */
  taps: number;
}

const KIND_WORDS: Record<StreamBubble['kind'], string> = { flame: 'a flame', heart: 'a heart' };

/** "Brendan reacted with a flame", or "3 reactions" for a burst (or a merge: no one to name). */
export function reactionSentence(arrivals: readonly Arrival[]): string {
  const taps = arrivals.reduce((sum, arrival) => sum + arrival.taps, 0);
  const only = arrivals.length === 1 ? arrivals[0] : null;
  if (only && taps === 1 && only.name) return `${only.name} reacted with ${KIND_WORDS[only.kind]}`;
  return taps === 1 ? '1 reaction' : `${taps} reactions`;
}

/**
 * The sentence for the live region: what other people's bubbles added, at most
 * once per {@link ANNOUNCE_INTERVAL_MS}. `text` is replaced (a new `id`) for each
 * line, so the same line twice is heard twice.
 */
function useReactionAnnouncement(bubbles: readonly StreamBubble[]): { id: number; text: string } | null {
  const [line, setLine] = useState<{ id: number; text: string } | null>(null);
  const seen = useRef<Map<string, number> | null>(null);
  const waiting = useRef<Arrival[]>([]);
  const lastSpokeAt = useRef(Number.NEGATIVE_INFINITY);
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const counts = new Map<string, number>();
    const arrivals: Arrival[] = [];
    for (const bubble of bubbles) {
      // Yours is never said, and it is not counted: you just pressed the button.
      if (bubble.own) continue;
      counts.set(bubble.id, bubble.count);
      // What was already on screen when this began is not news.
      if (seen.current === null) continue;
      const before = seen.current.get(bubble.id) ?? 0;
      if (bubble.count > before) {
        arrivals.push({ name: before === 0 ? bubble.name : null, kind: bubble.kind, taps: bubble.count - before });
      }
    }
    seen.current = counts;
    if (arrivals.length === 0) return;
    waiting.current.push(...arrivals);

    const speak = () => {
      speakTimer.current = null;
      if (waiting.current.length === 0) return;
      const text = reactionSentence(waiting.current);
      waiting.current = [];
      lastSpokeAt.current = Date.now();
      sequence.current += 1;
      setLine({ id: sequence.current, text });
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => {
        clearTimer.current = null;
        setLine(null);
      }, ANNOUNCE_CLEAR_MS);
    };
    if (speakTimer.current) return; // already due: this joins the burst
    const wait = lastSpokeAt.current + ANNOUNCE_INTERVAL_MS - Date.now();
    if (wait <= 0) speak();
    else speakTimer.current = setTimeout(speak, wait);
  }, [bubbles]);

  useEffect(
    () => () => {
      if (speakTimer.current) clearTimeout(speakTimer.current);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  return line;
}

/** The rising reactions over the stream. */
export function StreamReactionsLayer({ target }: StreamReactionsLayerProps) {
  const key = streamKey(target.serverId, target.channelId, target.streamerId);
  useEffect(() => useStreamReactionStore.getState().watch(key), [key]);

  const all = useStreamReactionStore((state) => state.bubbles);
  const bubbles = useMemo(() => {
    const mine = all.filter((bubble) => bubble.key === key);
    return mine.length > 0 ? mine : EMPTY;
  }, [all, key]);
  const line = useReactionAnnouncement(bubbles);

  const live = (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="stream-reactions-live">
      {line && <span key={line.id}>{line.text}</span>}
    </div>
  );
  if (bubbles.length === 0) return live;
  let stillRow = 0;
  return (
    <>
      {live}
      <div className="glass-reactions" aria-hidden="true" data-testid="stream-reactions">
        {bubbles.map((bubble) => {
          const row = bubble.still ? stillRow++ % STILL_ROWS : 0;
          return (
            <span
              key={bubble.id}
              className="glass-reactions__bubble"
              data-kind={bubble.kind}
              data-own={bubble.own || undefined}
              data-still={bubble.still || undefined}
              style={{ left: bubble.lane, bottom: row * STILL_ROW_PX }}
            >
              <span className="glass-reactions__disc">
                {bubble.kind === 'flame' ? (
                  <FlameGlyph size={bubble.own ? 22 : 20} />
                ) : (
                  <Heart size={bubble.own ? 21 : 19} strokeWidth={1.8} aria-hidden="true" />
                )}
                {!bubble.own && (
                  <Face
                    className="glass-reactions__face"
                    face={{ userId: bubble.userId, name: bubble.name, avatar: bubble.avatar }}
                    size={20}
                  />
                )}
              </span>
              {bubble.count > 1 && <span className="glass-reactions__count glass-instrument">{bubble.count}</span>}
            </span>
          );
        })}
      </div>
    </>
  );
}
