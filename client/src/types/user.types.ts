export interface User {
  id: string;
  username: string;
  discriminator: string | number;
  email?: string;
  avatar?: string;
  avatar_hash?: string | null;
  public_key?: string | null;
  banner?: string;
  bio?: string;
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
  theme: 'dark' | 'light' | 'amoled' | 'high-contrast';
  locale: string;
  message_display_compact: boolean;
  custom_css?: string;
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  custom_status?: string;
  crypto_auth_enabled: boolean;
  notifications?: Record<string, unknown>;
  keybinds?: Record<string, unknown>;
}

export interface Presence {
  user_id: string;
  guild_id?: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  activities: Activity[];
}

export interface Activity {
  name: string;
  type: number;
  activity_type?: number;
  details?: string;
  state?: string;
  started_at?: string;
  application_id?: string;
}

export const UserFlags = {
  ADMIN: 1 << 0,
} as const;

export function isAdmin(flags: number): boolean {
  return (flags & UserFlags.ADMIN) !== 0;
}
