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
}
