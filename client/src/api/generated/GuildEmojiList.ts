/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export type GuildEmojiList = GuildEmoji[];

/**
 * A custom guild emoji. `creator_id` is null for emoji whose creator record
 * is gone; the field is always present.
 */
export interface GuildEmoji {
  animated: boolean;
  created_at: string;
  creator_id: string | null;
  guild_id: string;
  id: string;
  name: string;
  [k: string]: unknown | undefined;
}
