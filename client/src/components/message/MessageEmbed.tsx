import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { MessageEmbed as EmbedType } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { safeClientResourceUrl, safeExternalUrl } from '../../lib/security';

interface MessageEmbedCardProps {
  embed: EmbedType;
}

/**
 * A link preview, as a card of the event-card family (docs/index-spec.md §8.4):
 * the site, the title as the link, two lines of the page, a thumbnail at the end.
 * The source's own color, when it sends one, is a 4px edge: the one place a
 * color that is not Index's is shown, because it is the source's mark.
 */
export function MessageEmbedCard({ embed }: MessageEmbedCardProps) {
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const accentColor = embed.color || null;
  const imageUrl = safeClientResourceUrl(embed.image || embed.thumbnail || '');
  const hasImage = !lowBandwidthMode && Boolean(imageUrl);
  const url = safeExternalUrl(embed.url);

  // An embed does not have to lead anywhere: a webhook can post one that is
  // only a title and a description, and such an embed used to be dropped on
  // the floor here (and, before `safeExternalUrl` tolerated a missing url,
  // took the whole message feed down with it). Render that as a plain card.
  //
  // An embed that *claims* a destination the client refuses to open is a
  // different thing, and still renders nothing: a card whose link was quietly
  // removed invites the click it can no longer honor.
  const claimsDestination = Boolean(embed.url);
  const hasBody = Boolean(embed.site_name || embed.title || embed.description || imageUrl);
  if (!url && (claimsDestination || !hasBody)) return null;

  const content: ReactNode = (
    <>
      {accentColor && <span className="ix-embed__accent" style={{ backgroundColor: accentColor }} aria-hidden />}
      <span className="ix-embed__body">
        {embed.site_name && <span className="ix-embed__site">{embed.site_name}</span>}
        {embed.title && <span className="ix-embed__title">{embed.title}</span>}
        {embed.description && <span className="ix-embed__desc">{embed.description}</span>}
        {!embed.title && !embed.description && url && (
          <span className="ix-embed__url">
            <ExternalLink size={13} aria-hidden />
            <span>{url}</span>
          </span>
        )}
      </span>

      {hasImage && <img src={imageUrl ?? undefined} alt="" className="ix-embed__thumb" loading="lazy" />}
      {!hasImage && lowBandwidthMode && imageUrl && <span className="ix-embed__thumb">Image</span>}
    </>
  );

  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="ix-card ix-embed" data-accent={accentColor ? '' : undefined}>
        {content}
      </a>
    );
  }
  return (
    <div className="ix-card ix-embed" data-accent={accentColor ? '' : undefined}>
      {content}
    </div>
  );
}

/**
 * Extract URLs from message content for client-side link preview rendering.
 * Only matches standalone HTTP(S) URLs, not already-linked markdown.
 */
const URL_REGEX = /https?:\/\/[^\s<>\])"']+/gi;

export function extractUrls(content: string | null): string[] {
  if (!content) return [];
  const matches = content.match(URL_REGEX);
  if (!matches) return [];
  // Deduplicate
  return [...new Set(matches)];
}
