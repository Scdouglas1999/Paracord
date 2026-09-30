/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * What a view session receives.
 *
 * - `watch`: the chosen stream's video and its own audio (never the voices).
 *   Counted in the channel's watcher counts, so others see "2 watching".
 * - `ambient`: the stream's lowest simulcast layer, keyframes only, at most
 *   one frame a second, video only. Not counted and not shown to anybody.
 */
export type VoiceViewKind = 'watch' | 'ambient';

/**
 * Response of `POST /api/v2/voice/{channel_id}/view`.
 *
 * When the caller is already in this channel's call (joined or listening),
 * the view rides that call: `via_membership` is true, `session_id` and
 * `media` are null, and the caller subscribes to the stream through its call
 * connection. Otherwise it is a separate view session with its own receipt
 * and media credentials; an account holds one at a time, and a new one
 * replaces the old (whose connection the relay closes).
 */
export interface VoiceViewSession {
  channel_id: string;
  guild_id: string;
  kind: VoiceViewKind;
  media: VoiceViewMedia | null;
  session_id: string | null;
  /**
   * The streamer being viewed.
   */
  user_id: string;
  via_membership: boolean;
  [k: string]: unknown | undefined;
}
/**
 * How to connect a view session's media (the same native endpoint a call
 * uses; the token admits only this view).
 */
export interface VoiceViewMedia {
  cert_hash: string | null;
  media_endpoint: string;
  media_endpoint_candidates: string[];
  media_token: string;
  room_name: string;
  [k: string]: unknown | undefined;
}
