/**
 * How a member takes part in a voice channel (docs/glass-spec.md §7).
 * `listen` hears the voices and never sends; everyone who can see the channel
 * sees the member as "Listening in". Absent on the wire from older servers,
 * which means `joined`.
 */
export type VoiceMode = 'joined' | 'listen';

export interface VoiceState {
  user_id: string;
  channel_id?: string;
  guild_id?: string;
  session_id: string;
  deaf: boolean;
  mute: boolean;
  self_deaf: boolean;
  self_mute: boolean;
  self_stream: boolean;
  self_video: boolean;
  suppress: boolean;
  request_to_speak_at?: string | null;
  username?: string;
  display_name?: string | null;
  avatar_hash?: string | null;
  /**
   * Talking right now, as the server last heard. Only on READY's snapshot;
   * live changes arrive as `VOICE_SPEAKING` (see `remoteSpeakingStore`).
   */
  speaking?: boolean;
  /** `listen` is "Listening in" on the roster. Absent means `joined`. */
  mode?: VoiceMode;
  /**
   * When this member's current stream started (RFC 3339), for "LIVE 42 MIN".
   * Non-null exactly while `self_stream` is true. The server stamps it; a
   * client never invents one.
   */
  self_stream_started_at?: string | null;
}
