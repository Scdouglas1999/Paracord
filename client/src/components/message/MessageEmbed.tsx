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
      className="group mt-1.5 flex max-w-[480px] overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/60 transition-colors hover:bg-bg-mod-subtle"
    >
      {/* Accent bar */}
      <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: accentColor }} />

      <div className="flex min-w-0 flex-1 gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {embed.site_name && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {embed.site_name}
            </div>
          )}
          {embed.title && (
            <div className="mt-0.5 text-sm font-semibold leading-snug text-accent-primary group-hover:underline">
              {embed.title}
            </div>
          )}
          {embed.description && (
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">
              {embed.description}
            </div>
          )}
          {!embed.title && !embed.description && (
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <ExternalLink size={12} />
              <span className="truncate">{url}</span>
            </div>
          )}
        </div>

        {hasImage && (
          <img
            src={imageUrl ?? undefined}
            alt=""
            className="h-16 w-16 shrink-0 rounded-lg object-cover"
            loading="lazy"
          />
        )}
        {!hasImage && lowBandwidthMode && imageUrl && (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-mod-subtle text-[10px] font-semibold uppercase tracking-wide text-text-muted">
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
