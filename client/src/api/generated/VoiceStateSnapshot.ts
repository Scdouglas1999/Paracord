/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * A voice state as READY lists it (`guilds[].voice_states[]`) and as a
 * `VOICE_STATE_UPDATE` for someone *in* a channel carries it. (A leave is
 * `channel_id: null` plus `prior_channel_id` and is not this shape.)
 */
export interface VoiceStateSnapshot {
  avatar_hash?: string | null;
  channel_id: string;
  deaf: boolean;
  /**
   * Null for a DM call.
   */
  guild_id: string | null;
  /**
   * `listen` shows as "Listening in" on the roster.
   */
  mode: 'joined' | 'listen';
  mute: boolean;
  request_to_speak_at?: string | null;
  self_deaf: boolean;
  self_mute: boolean;
  self_stream: boolean;
  /**
   * When the member's current stream started (RFC 3339), for "LIVE 42 MIN".
   * Non-null exactly while `self_stream` is true.
   */
  self_stream_started_at: string | null;
  self_video: boolean;
  session_id?: string | null;
  /**
   * READY only: talking right now.
   */
  speaking?: boolean | null;
  suppress: boolean;
  user_id: string;
  username?: string | null;
  [k: string]: unknown | undefined;
}
