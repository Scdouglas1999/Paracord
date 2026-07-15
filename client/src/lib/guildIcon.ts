import { safeStoredImageDataUrl } from './security';

/** Resolve a guild/space icon for `<img src>` (prefers `icon_hash`, falls back to `icon`). */
export function resolveGuildIconUrl(
  guild: { icon?: string | null; icon_hash?: string | null } | null | undefined,
): string | null {
  if (!guild) return null;
  return safeStoredImageDataUrl(guild.icon_hash ?? guild.icon ?? null);
}

/** Two-letter initials chip used when a space has no icon. */
export function guildInitials(name: string, max = 2): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, max)
      .toUpperCase() || '?'
  );
}
