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

  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group mt-1.5 flex max-w-[480px] overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
    >
      {/* Accent bar — the source's own color, a single meaning marker */}
      <div className="w-1 shrink-0" style={{ backgroundColor: accentColor }} />

      <div className="flex min-w-0 flex-1 gap-3 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          {embed.site_name && (
            <div className="text-section uppercase text-text-muted">
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
          {!embed.title && !embed.description && (
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
            className="h-16 w-16 shrink-0 rounded-sm object-cover"
            loading="lazy"
          />
        )}
        {!hasImage && lowBandwidthMode && imageUrl && (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-bg-tertiary text-section uppercase text-text-muted">
            Image
          </div>
        )}
      </div>
    </a>
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
