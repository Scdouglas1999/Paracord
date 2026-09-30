/**
 * Reactions on the stream (docs/glass-spec.md §6.5): flame and heart float up
 * from the bottom right of the stream for everyone watching, each with the
 * sender's face in its corner, rising about 270px and fading.
 *
 * STUB (WP-G14). The exports are the contract the stage uses; WP-G17 fills
 * them (the voice-channel-scoped gateway event, the store, the rising faces)
 * and owns this file from then on. Until then sending is honestly unavailable:
 * `available` is false with a sentence that says so, and the layer draws
 * nothing. Nothing pretends to send.
 *
 * Mount point: the stage renders `<StreamReactionsLayer target=… />` inside
 * the stream box (it is chrome over the video, inside the native-surface
 * boundary), positioned by the layer itself (bottom right, 24px in, §6.5).
 */

export type StreamReactionKind = 'fire' | 'heart';

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

const NOT_YET = 'Reactions on the stream are not available in this version yet.';

const UNAVAILABLE: StreamReactions = {
  available: false,
  unavailableReason: NOT_YET,
  send: () => {},
};

export function useStreamReactions(target: StreamReactionTarget | null): StreamReactions {
  void target;
  return UNAVAILABLE;
}

export interface StreamReactionsLayerProps {
  target: StreamReactionTarget;
}

/** The rising reactions over the stream. Draws nothing until WP-G17. */
export function StreamReactionsLayer(props: StreamReactionsLayerProps) {
  void props;
  return null;
}
