import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { MessageEmbed as EmbedType } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { safeClientResourceUrl, safeExternalUrl } from '../../lib/security';

interface MessageEmbedCardProps {
  embed: EmbedType;
}

export function MessageEmbedCard({ embed }: MessageEmbedCardProps) {
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const accentColor = embed.color || 'var(--accent-primary)';
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

  const surface =
    'group mt-1.5 flex max-w-[480px] overflow-hidden rounded-well border border-border-subtle bg-bg-raised shadow-[var(--shadow-chip)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';
  const Surface = url
    ? ({ children }: { children: ReactNode }) => (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${surface} hover:border-border-strong`}
        >
          {children}
        </a>
      )
    : ({ children }: { children: ReactNode }) => <div className={surface}>{children}</div>;

  return (
    <Surface>
      {/* Accent bar — the source's own color, a single meaning marker */}
      <div className="w-1 shrink-0" style={{ backgroundColor: accentColor }} />

      <div className="flex min-w-0 flex-1 gap-3 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          {embed.site_name && (
            <div className="text-section text-text-muted">
              {embed.site_name}
            </div>
          )}
          {embed.title && (
            <div className="mt-0.5 text-label font-semibold leading-snug text-accent-primary group-hover:underline">
              {embed.title}
            </div>
          )}
          {embed.description && (
            <div className="mt-1 line-clamp-2 text-meta leading-relaxed text-text-secondary">
              {embed.description}
            </div>
          )}
          {!embed.title && !embed.description && url && (
            <div className="flex items-center gap-1.5 text-meta text-text-muted">
              <ExternalLink size={13} />
              <span className="truncate">{url}</span>
            </div>
          )}
        </div>

        {hasImage && (
          <img
            src={imageUrl ?? undefined}
            alt=""
            className="h-16 w-16 shrink-0 rounded-chip object-cover"
            loading="lazy"
          />
        )}
        {!hasImage && lowBandwidthMode && imageUrl && (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-chip border border-border-subtle bg-bg-well text-section text-text-muted">
            Image
          </div>
        )}
      </div>
    </Surface>
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
