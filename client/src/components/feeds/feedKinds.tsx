import { useState } from 'react';
import { Github, Rss, Tv, Twitch, Youtube, type LucideIcon } from 'lucide-react';
import type { FeedKind } from '../../api/feeds';
import { safeExternalUrl } from '../../lib/security';
import { cn } from '../../lib/utils';

export interface FeedKindMeta {
  label: string;
  Icon: LucideIcon;
  /** One line on the source picker. */
  blurb: string;
  inputLabel: string;
  placeholder: string;
  hint: string;
}

export const FEED_KIND_META: Record<FeedKind, FeedKindMeta> = {
  rss: {
    label: 'RSS or Atom',
    Icon: Rss,
    blurb: 'Any blog, news site or podcast with a feed.',
    inputLabel: 'Feed or web page address',
    placeholder: 'https://example.com/feed.xml',
    hint: 'A web page works too, if it lists its feed.',
  },
  youtube: {
    label: 'YouTube channel',
    Icon: Youtube,
    blurb: 'New videos from a channel.',
    inputLabel: 'Channel or video address',
    placeholder: 'https://www.youtube.com/@channel',
    hint: 'A channel address, an @handle, or any video from the channel.',
  },
  github: {
    label: 'GitHub repository',
    Icon: Github,
    blurb: 'Releases, commits or tags from a public repository.',
    inputLabel: 'Repository',
    placeholder: 'owner/repo',
    hint: 'Type owner/repo, or paste the repository address.',
  },
  twitch: {
    label: 'Twitch channel',
    Icon: Twitch,
    blurb: 'A post when the channel goes live.',
    inputLabel: 'Channel',
    placeholder: 'twitch.tv/name',
    hint: 'Posts once per stream, with its title and game.',
  },
  jellyfin: {
    label: 'Jellyfin',
    Icon: Tv,
    blurb: 'Movies, episodes and albums added to your library.',
    inputLabel: 'Server address',
    placeholder: 'http://192.168.1.20:8096',
    hint: 'The address this instance can reach your Jellyfin server at.',
  },
};

export function feedKindMeta(kind: string | null | undefined): FeedKindMeta {
  return FEED_KIND_META[(kind as FeedKind) ?? 'rss'] ?? FEED_KIND_META.rss;
}

/**
 * A feed's picture: the source's own icon when it has one, the source kind's
 * glyph otherwise (and when the icon does not load).
 */
export function FeedSourceIcon({
  kind,
  iconUrl,
  size = 32,
  className,
}: {
  kind: string | null | undefined;
  iconUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = iconUrl ? safeExternalUrl(iconUrl) : null;
  const { Icon } = feedKindMeta(kind);
  const radius = 'rounded-[var(--radius-thumb)]';
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn('pc-feed-icon shrink-0 object-cover', radius, className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn('pc-feed-icon pc-feed-icon-glyph flex shrink-0 items-center justify-center', radius, className)}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}
