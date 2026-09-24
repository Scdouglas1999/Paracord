import { useMemo, type ReactNode } from 'react';
import { ArrowUpRight, Play } from 'lucide-react';
import type { FeedEmbedMeta } from '../../api/feeds';
import type { MessageEmbed } from '../../types';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { relativeTime } from '../../lib/formatters';
import { safeClientResourceUrl, safeExternalUrl } from '../../lib/security';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/uiStore';
import { ResourceImage } from '../ui/ResourceImage';

/** The embed a feed posts: a card, or the "and N more from <source>" line. */
export type FeedEmbed = MessageEmbed & { feed: FeedEmbedMeta };

export function isFeedEmbed(embed: MessageEmbed | null | undefined): embed is FeedEmbed {
  return Boolean(embed?.feed && typeof embed.feed === 'object' && typeof embed.feed.kind === 'string');
}

export interface FeedPostCardProps {
  embed: FeedEmbed;
  /**
   * Extra actions under the card. The YouTube card leaves room here for a
   * second action beside opening the video.
   */
  actions?: ReactNode;
  className?: string;
}

/**
 * A picture on a card. A server path (a Jellyfin poster the instance stored)
 * goes through the authenticated resource path; a picture on the open web
 * (a YouTube thumbnail) loads directly, like a link preview's.
 */
function useCardImage(raw: string | null | undefined): { src: string | null; stored: boolean } {
  const ticket = useDownloadTicket();
  return useMemo(() => {
    if (!raw) return { src: null, stored: false };
    const trimmed = raw.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      const safe = safeClientResourceUrl(trimmed);
      return { src: safe ? safeClientResourceUrl(resolveResourceUrl(safe, ticket)) : null, stored: true };
    }
    return { src: safeExternalUrl(trimmed), stored: false };
  }, [raw, ticket]);
}

function CardImage({ src, stored, className }: { src: string; stored: boolean; className?: string }) {
  if (stored) {
    return <ResourceImage src={src} alt="" loading="lazy" draggable={false} className={className} />;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      referrerPolicy="no-referrer"
      className={className}
    />
  );
}

/** "3 hours ago". A date in the future (a feed's clock or zone is off) reads as now. */
function publishedLabel(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return null;
  if (at > Date.now()) return 'just now';
  return relativeTime(timestamp);
}

/** The site an item links to, without "www.". */
function sourceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * A new item from a feed, in a channel or on the front page: the title as a
 * link, where it came from and when, a short summary, and its picture when it
 * has one. A YouTube video leads with its thumbnail and a play mark.
 */
export function FeedPostCard({ embed, actions, className }: FeedPostCardProps) {
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const url = safeExternalUrl(embed.url);
  const image = useCardImage(embed.thumbnail || embed.image);
  const kind = embed.feed.kind;
  const when = publishedLabel(embed.timestamp);
  // A home Jellyfin's address means nothing to members; name the source instead.
  const host = kind === 'jellyfin' ? 'Jellyfin' : sourceHost(url);

  if (typeof embed.feed.more === 'number' && embed.feed.more > 0) {
    const text = embed.title || `and ${embed.feed.more} more`;
    return url ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('pc-feed-more pc-focusable', className)}
      >
        <span className="truncate">{text}</span>
        <ArrowUpRight size={14} aria-hidden className="shrink-0" />
      </a>
    ) : (
      <p className={cn('pc-feed-more', className)}>{text}</p>
    );
  }

  const showImage = Boolean(image.src) && !lowBandwidthMode;
  const video = kind === 'youtube' && showImage;
  const poster = kind === 'jellyfin' && showImage;

  // The card sits under the feed's own name, so the kicker names the site.
  const kicker = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-text-muted">
      {host && <span className="pc-feed-host max-w-full truncate">{host}</span>}
      {host && when && <span aria-hidden className="pc-feed-host text-text-faint">·</span>}
      {when && (
        <time dateTime={embed.timestamp ?? undefined} className="shrink-0 tabular-nums">
          {when}
        </time>
      )}
    </div>
  );

  const title = embed.title ? (
    url ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="pc-feed-title pc-focusable rounded-[var(--radius-chip)]"
      >
        {embed.title}
      </a>
    ) : (
      <span className="pc-feed-title">{embed.title}</span>
    )
  ) : null;

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {kicker}
      {title}
      {embed.description && (
        <p className={cn('text-meta leading-relaxed text-text-secondary', video ? 'line-clamp-2' : 'line-clamp-3')}>
          {embed.description}
        </p>
      )}
    </div>
  );

  return (
    <article className={cn('pc-feed-card', video && 'is-video', className)} aria-label={embed.title || 'Feed post'}>
      {video && image.src && (
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="pc-feed-media pc-focusable-composed"
            aria-label={`Play ${embed.title ?? 'video'} on YouTube`}
          >
            <CardImage src={image.src} stored={image.stored} />
            <span className="pc-feed-play" aria-hidden>
              <Play size={20} fill="currentColor" />
            </span>
          </a>
        ) : (
          <div className="pc-feed-media">
            <CardImage src={image.src} stored={image.stored} />
          </div>
        )
      )}
      <div className="flex min-w-0 gap-3 px-3.5 py-3">
        {body}
        {!video && showImage && image.src && (
          <CardImage
            src={image.src}
            stored={image.stored}
            className={cn('pc-feed-thumb shrink-0 object-cover', poster ? 'is-poster' : 'is-square')}
          />
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3">{actions}</div>}
    </article>
  );
}
