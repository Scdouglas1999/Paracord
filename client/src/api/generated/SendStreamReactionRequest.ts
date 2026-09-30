/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * What a reaction on a stream is. Extensible: a later version adds kinds, and
 * a client that does not know a kind skips that reaction.
 */
export type StreamReactionKind = 'flame' | 'heart';

/**
 * `POST /api/v2/voice/{channel_id}/stream-reactions`: react to a stream in
 * that voice channel. The caller must be in the channel's call or watching it
 * through a view session. One request a second per person (429 with
 * `Retry-After` otherwise).
 */
export interface SendStreamReactionRequest {
  /**
   * How many taps this request merges (default 1).
   */
  count?: number;
  kind: StreamReactionKind;
  /**
   * Echoed back in the event, so the sending client can drop the echo of a
   * reaction it has already drawn.
   */
  nonce?: string | null;
  /**
   * The streamer whose stream this reacts to (sharing in this channel now).
   */
  stream_user_id: string;
  [k: string]: unknown | undefined;
}
