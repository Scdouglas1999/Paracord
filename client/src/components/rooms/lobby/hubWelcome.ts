import { safeClientResourceUrl } from '../../../lib/security';
import type { HubSettings } from '../../../types';

/**
 * What a building's operator wrote about it (`hub_settings`), read for the
 * Lobby (docs/lantern-stage-spec.md §7.3).
 *
 * The Emerald Commons "Space briefing" — a banner hero, a welcome card and a
 * featured-channel list stacked under the rooms — is gone with the rest of that
 * design, and §7.3 has no slot shaped like it. These three facts are still
 * configured in space settings, though, and a setting nothing displays is a
 * bug. So each one goes where it is already true of the Lobby:
 *
 *   - the welcome line **is** the header's one sentence of facts, when the
 *     operator wrote one. It never stacks under the generated one; a building
 *     gets one sentence, and the person who runs it outranks the generator.
 *   - the banner **is** a thin band across the top of the Lobby plate. Not a
 *     hero, not a gradient, not a backdrop for text (§6.1, §6.2) — a strip of
 *     the building's own picture above its name.
 *   - featured rooms **are** the first rooms in the list. Not a separate
 *     section, not a badge with a light token in it (§6.3) — just first.
 *
 * Pure functions: no React, no store, no network.
 */

export interface HubWelcome {
  /** The operator's sentence, trimmed. Empty when they wrote none. */
  welcome: string;
  /**
   * The server banner's API path (`guilds.banner_hash`, uploaded in Server
   * settings → Overview), or null. The caller resolves it for `<img>`.
   */
  bannerSrc: string | null;
  /** Channel ids the operator pinned, in the order they pinned them. */
  featuredChannelIds: readonly string[];
}

const EMPTY: HubWelcome = { welcome: '', bannerSrc: null, featuredChannelIds: [] };

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read `hub_settings` and the server banner into the three things the Lobby
 * can show. The hub no longer carries a banner of its own; the band's picture
 * is the uploaded server banner, a same-server path and nothing else.
 *
 * `welcome_text` is the operator's greeting and `description` is the building's
 * blurb; §7.3's header has room for one sentence, so the greeting wins and the
 * description is the fallback. Both are collapsed to a single line — the header
 * is one band deep and a pasted paragraph must not push the rooms off screen.
 */
export function readHubWelcome(
  settings: HubSettings | null | undefined,
  bannerHash?: string | null,
): HubWelcome {
  const welcome = settings
    ? oneLine(trimmed(settings.welcome_text) || trimmed(settings.description))
    : '';
  const featuredChannelIds = settings && Array.isArray(settings.pinned_channels)
    ? settings.pinned_channels.filter((id): id is string => typeof id === 'string')
    : [];
  if (!settings && !bannerHash) return EMPTY;
  const safe = typeof bannerHash === 'string' ? safeClientResourceUrl(bannerHash) : null;
  const bannerSrc = safe && safe.startsWith('/api/') ? safe : null;
  return { welcome, bannerSrc, featuredChannelIds };
}

/** Collapse newlines and runs of whitespace; the header is one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Featured first, then everything else in the order it already had.
 *
 * The operator's order is the operator's order — a pinned room does not get
 * re-sorted by how lit it is, because being featured is the whole point. Rooms
 * that were not pinned keep whatever ordering the caller gave them.
 */
export function featuredFirst<T extends { channelId: string }>(
  rooms: readonly T[],
  featuredChannelIds: readonly string[],
): T[] {
  if (featuredChannelIds.length === 0) return [...rooms];
  const rank = new Map(featuredChannelIds.map((id, index) => [id, index]));
  const featured: T[] = [];
  const rest: T[] = [];
  for (const room of rooms) {
    (rank.has(room.channelId) ? featured : rest).push(room);
  }
  featured.sort((a, b) => (rank.get(a.channelId) ?? 0) - (rank.get(b.channelId) ?? 0));
  return [...featured, ...rest];
}
