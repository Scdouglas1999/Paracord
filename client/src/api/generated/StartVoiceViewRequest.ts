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
 * `POST /api/v2/voice/{channel_id}/view`: start a view session.
 */
export interface StartVoiceViewRequest {
  kind: VoiceViewKind;
  /**
   * The streamer (a member of the channel with `self_stream`).
   */
  user_id: string;
  [k: string]: unknown | undefined;
}
