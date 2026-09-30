import { useEffect, useMemo } from 'react';
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
 */

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
  guildId: string;
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
  const dm = !target || !target.guildId || target.guildId === 'dm';
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

/** The rising reactions over the stream. */
export function StreamReactionsLayer({ target }: StreamReactionsLayerProps) {
  const key = streamKey(target.serverId, target.channelId, target.streamerId);
  useEffect(() => useStreamReactionStore.getState().watch(key), [key]);

  const all = useStreamReactionStore((state) => state.bubbles);
  const bubbles = useMemo(() => {
    const mine = all.filter((bubble) => bubble.key === key);
    return mine.length > 0 ? mine : EMPTY;
  }, [all, key]);

  if (bubbles.length === 0) return null;
  let stillRow = 0;
  return (
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
  );
}
