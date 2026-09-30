/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * What a reaction on a stream is. Extensible: a later version adds kinds, and
 * a client that does not know a kind skips that reaction.
 */
export type StreamReactionKind = 'flame' | 'heart';

/**
 * The `STREAM_REACTIONS` gateway event: the reactions one voice channel
 * received in the last quarter second, in the order they arrived. Sent to
 * the channel's voice members and its watch viewers only.
 */
export interface StreamReactions {
  channel_id: string;
  guild_id: string;
  /**
   * @minItems 1
   */
  reactions: [StreamReaction, ...StreamReaction[]];
  [k: string]: unknown | undefined;
}
/**
 * One reaction (possibly several merged taps) from one person.
 */
export interface StreamReaction {
  avatar_hash: string | null;
  count: number;
  display_name: string | null;
  kind: StreamReactionKind;
  /**
   * The sender's nonce, when it sent one.
   */
  nonce: string | null;
  /**
   * The streamer whose stream it reacts to.
   */
  stream_user_id: string;
  /**
   * Who reacted.
   */
  user_id: string;
  /**
   * For the face in the bubble's corner when the roster does not have the
   * sender (a viewer outside the call).
   */
  username: string;
  [k: string]: unknown | undefined;
}
