/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * How a member takes part in a voice channel. `listen` hears the voices and
 * never sends; everyone in the channel sees the member as listening in.
 */
export type VoiceMode = 'joined' | 'listen';

/**
 * Response of `POST /api/v2/voice/{channel_id}/mode`.
 */
export interface VoiceModeResponse {
  /**
   * Whether the relay now accepts this member's media. `joined` without the
   * SPEAK permission is still `false`.
   */
  can_publish: boolean;
  channel_id: string;
  mode: VoiceMode;
  session_id: string;
  [k: string]: unknown | undefined;
}
