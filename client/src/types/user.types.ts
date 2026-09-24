export interface User {
  id: string;
  username: string;
  discriminator: string | number;
  email?: string;
  avatar?: string;
  avatar_hash?: string | null;
  public_key?: string | null;
  banner?: string;
  banner_hash?: string | null;
  /** Profile accent as `0xRRGGBB`. */
  accent_color?: number | null;
  bio?: string | null;
  pronouns?: string | null;
  linked_accounts?: Array<{ label: string; url: string }>;
  display_name?: string | null;
  bot: boolean;
  system: boolean;
  flags: number;
  created_at: string;
}

export interface UserSettings {
  user_id: string;
  /**
   * Opaque server-stored string. The known values are the ids in
   * `src/lib/themes.ts`: dark/light/amoled/high-contrast, plus the looks
   * dusk/paper/slate/voices. Anything else collapses to dark on the way in.
   */
  theme: string;
  locale: string;
  message_display_compact: boolean;
  custom_css?: string | null;
  /** Opaque server-stored string; known values are online/idle/dnd/invisible. */
  status: string;
  custom_status?: string | null;
  crypto_auth_enabled: boolean;
  notifications?: Record<string, unknown>;
  keybinds?: Record<string, unknown>;
}

export interface Presence {
  user_id: string;
  guild_id?: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  activities: Activity[];
  /** The short line people set in the account menu. */
  custom_status?: string | null;
}

/**
 * Activity kinds, as sent in `Activity.type` (Discord's numbering, which the
 * server validates against).
 */
export const ActivityType = {
  PLAYING: 0,
  STREAMING: 1,
  LISTENING: 2,
  WATCHING: 3,
  CUSTOM: 4,
  COMPETING: 5,
} as const;

export interface Activity {
  /** The app: "Spotify", a game, or "Paracord" for a watch-together session. */
  name: string;
  type: number;
  activity_type?: number;
  /** Listening/watching: the title. Playing: a label. */
  details?: string | null;
  /** Listening: the artist. Playing: the window title. */
  state?: string | null;
  /** RFC 3339. Listening: when the track would have started at its current position. */
  started_at?: string | null;
  /** RFC 3339. Listening: when the track ends, when its length is known. */
  ends_at?: string | null;
  application_id?: string | null;
}

export const UserFlags = {
  ADMIN: 1 << 0,
} as const;

export function isAdmin(flags: number): boolean {
  return (flags & UserFlags.ADMIN) !== 0;
}
