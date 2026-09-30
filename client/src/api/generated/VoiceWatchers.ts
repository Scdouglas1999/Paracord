/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * Watcher counts for one voice channel: `GET
 * /api/v2/voice/{channel_id}/watchers` and the `VOICE_WATCHERS_UPDATE`
 * gateway event. A complete snapshot for the channel: a stream that is not
 * listed has no watchers.
 */
export interface VoiceWatchers {
  channel_id: string;
  guild_id: string;
  streams: VoiceStreamWatchers[];
  [k: string]: unknown | undefined;
}
/**
 * One stream's watcher count.
 */
export interface VoiceStreamWatchers {
  /**
   * The streamer.
   */
  user_id: string;
  watchers: number;
  [k: string]: unknown | undefined;
}
