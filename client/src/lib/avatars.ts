import { resolveResourceUrl } from './apiBaseUrl';
import { getAccessToken } from './authToken';

// Discord-like default avatar colors
const DEFAULT_AVATAR_COLORS = [
  '#5865f2', // blurple
  '#57f287', // green
  '#fee75c', // yellow
  '#eb459e', // fuchsia
  '#ed4245', // red
];

/**
 * Builds the URL for a user's avatar image.
 * Returns null if the user has no avatar set.
 */
export function getUserAvatarUrl(
  userId: string,
  avatarHash?: string | null
): string | null {
  if (!avatarHash) return null;
  return resolveResourceUrl(`/api/v1/users/${userId}/avatars/${avatarHash}`, getAccessToken());
}

/**
 * Builds the URL for a guild's icon image.
 * Returns null if the guild has no icon set.
 */
export function getGuildIconUrl(
  guildId: string,
  iconHash?: string | null
): string | null {
  if (!iconHash) return null;
  return resolveResourceUrl(`/api/v1/guilds/${guildId}/icons/${iconHash}`, getAccessToken());
}

/**
 * Returns a deterministic default avatar color index based on discriminator or user ID.
 * Mirrors Discord's behavior: discriminator % 5 (or id for pomelo users).
 */
export function getDefaultAvatarIndex(
  discriminatorOrId: string
): number {
  const num = parseInt(discriminatorOrId, 10);
  if (isNaN(num)) {
    // Hash the string for a stable index
    let hash = 0;
    for (let i = 0; i < discriminatorOrId.length; i++) {
      hash = ((hash << 5) - hash) + discriminatorOrId.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % DEFAULT_AVATAR_COLORS.length;
  }
  return num % DEFAULT_AVATAR_COLORS.length;
}

/**
 * Returns the default avatar background color for a user.
 */
export function getDefaultAvatarColor(discriminatorOrId: string): string {
  return DEFAULT_AVATAR_COLORS[getDefaultAvatarIndex(discriminatorOrId)];
}

/**
 * Returns the initial(s) to display in a default avatar circle.
 * Single character for users, up to 3 characters for guilds.
 */
export function getAvatarInitials(name: string, maxChars = 1): string {
  if (maxChars === 1) {
    return name.charAt(0).toUpperCase();
  }
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, maxChars)
    .toUpperCase();
}

/**
 * Returns the full set of default avatar colors (for displaying palettes, etc.).
 */
export function getDefaultAvatarColors(): readonly string[] {
  return DEFAULT_AVATAR_COLORS;
}
