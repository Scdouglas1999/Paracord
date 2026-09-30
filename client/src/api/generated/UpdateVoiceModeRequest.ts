/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * How a member takes part in a voice channel. `listen` hears the voices and
 * never sends; everyone in the channel sees the member as listening in.
 */
export type VoiceMode = 'joined' | 'listen';

/**
 * `POST /api/v2/voice/{channel_id}/mode`: switch between listening in and a
 * full membership in place (no reconnect).
 */
export interface UpdateVoiceModeRequest {
  mode: VoiceMode;
  /**
   * The call receipt from the join. When present the switch applies only
   * to that call (409 otherwise).
   */
  session_id?: string | null;
  [k: string]: unknown | undefined;
}
