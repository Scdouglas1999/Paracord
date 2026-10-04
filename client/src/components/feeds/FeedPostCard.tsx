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

function CardImage({
  src,
  stored,
  className,
  shape,
}: {
  src: string;
  stored: boolean;
  className?: string;
  /** The thumbnail beside the text: a square, or a tall poster. */
  shape?: 'square' | 'poster';
}) {
  if (stored) {
    return <ResourceImage src={src} alt="" loading="lazy" draggable={false} className={className} data-shape={shape} />;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      referrerPolicy="no-referrer"
      className={className}
      data-shape={shape}
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
 * A new item from a feed, in a channel or on the front page, as a card of the
 * event-card family (docs/index-spec.md §8.4): the title as a link, where it came
 * from and when, a short summary, and its picture when it has one. A YouTube
 * video leads with its thumbnail and a play mark.
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
      <a href={url} target="_blank" rel="noopener noreferrer" className={cn('ix-feed-more', className)}>
        <span className="truncate">{text}</span>
        <ArrowUpRight size={14} aria-hidden className="shrink-0" />
      </a>
    ) : (
      <p className={cn('ix-feed-more', className)}>{text}</p>
    );
  }

  const showImage = Boolean(image.src) && !lowBandwidthMode;
  const video = kind === 'youtube' && showImage;
  const poster = kind === 'jellyfin' && showImage;

  // The card sits under the feed's own name, so the kicker names the site.
  const kicker = (
    <div className="ix-feed__kicker">
      {host && <span className="ix-feed__host">{host}</span>}
      {host && when && <span aria-hidden>·</span>}
      {when && (
        <time dateTime={embed.timestamp ?? undefined} className="tabular-nums">
          {when}
        </time>
      )}
    </div>
  );

  const title = embed.title ? (
    url ? (
      <a href={url} target="_blank" rel="noopener noreferrer" className="ix-feed__title">
        {embed.title}
      </a>
    ) : (
      <span className="ix-feed__title">{embed.title}</span>
    )
  ) : null;

  const body = (
    <div className="ix-feed__body">
      {kicker}
      {title}
      {embed.description && <p className="ix-feed__desc">{embed.description}</p>}
    </div>
  );

  return (
    <article
      className={cn('ix-card ix-feed', className)}
      data-video={video || undefined}
      aria-label={embed.title || 'Feed post'}
    >
      {video && image.src && (
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ix-feed__media"
            aria-label={`Play ${embed.title ?? 'video'} on YouTube`}
          >
            <CardImage src={image.src} stored={image.stored} />
            <span className="ix-feed__play" aria-hidden>
              <Play size={20} fill="currentColor" />
            </span>
          </a>
        ) : (
          <div className="ix-feed__media">
            <CardImage src={image.src} stored={image.stored} />
          </div>
        )
      )}
      <div className="ix-feed__main">
        {body}
        {!video && showImage && image.src && (
          <CardImage
            src={image.src}
            stored={image.stored}
            className="ix-feed__thumb"
            shape={poster ? 'poster' : 'square'}
          />
        )}
      </div>
      {actions && <div className="ix-feed__actions">{actions}</div>}
    </article>
  );
}
