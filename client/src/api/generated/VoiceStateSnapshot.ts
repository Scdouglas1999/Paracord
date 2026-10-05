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
   * When the member entered this channel (RFC 3339), for "live 12 min" on a
   * room: the room started at the earliest `joined_at` among its members.
   * Stamped on every join and listen join, kept while the member stays in
   * the channel, reset by a move. Null only on a status announcement whose
   * stored row could not be read.
   */
  joined_at?: string | null;
  /**
   * `listen` shows as "Listening in" on the roster.
   *
   * `mode`, `self_stream_started_at` and `joined_at` are always sent by this
   * server. They are optional in the contract for protocol-version
   * tolerance: servers from before them leave them out. An
   * absent `mode` is `joined` (there was no listening in); an absent time is
   * unknown, exactly as null, and a client shows nothing it would have
   * derived from it (a room reads "live", not "live N min").
   */
  mode?: 'joined' | 'listen';
  mute: boolean;
  request_to_speak_at?: string | null;
  self_deaf: boolean;
  self_mute: boolean;
  self_stream: boolean;
  /**
   * When the member's current stream started (RFC 3339), for "LIVE 42 MIN".
   * Non-null exactly while `self_stream` is true (when sent at all).
   */
  self_stream_started_at?: string | null;
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
