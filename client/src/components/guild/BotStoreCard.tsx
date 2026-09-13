import { useState } from 'react';
import { Bot, ArrowRight, Download, ShieldCheck, Star } from 'lucide-react';
import type { StoreBot } from '../../api/botStore';
import { safeStoredImageDataUrl } from '../../lib/security';
import { Button, Chip, Well } from '../ui';

interface BotStoreCardProps {
  bot: StoreBot;
  onAdd: (bot: StoreBot) => void;
  adding?: boolean;
  canManage: boolean;
}

/**
 * One listing in the public bot store — a **well-grounded row**, not another
 * bordered tile (docs/lantern-stage-spec.md §4, §6.8: identical-card tiling is
 * never the only rhythm). The mark grounds the row, the name carries the
 * Gabarito Name step, the description is one wrapped line, and the counts are
 * mono so a column of listings reads as a column of numbers.
 */
export function BotStoreCard({ bot, onAdd, adding, canManage }: BotStoreCardProps) {
  const [iconError, setIconError] = useState(false);
  const iconSrc = safeStoredImageDataUrl(bot.icon_hash);

  return (
    <Well bare className="flex gap-4 p-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-bg-raised shadow-[var(--shadow-raised)]">
        {iconSrc && !iconError ? (
          <img
            src={iconSrc}
            alt={bot.name}
            className="h-11 w-11 rounded-[var(--radius-card)] object-cover"
            onError={() => setIconError(true)}
          />
        ) : (
          <Bot size={22} className="text-text-secondary" aria-hidden />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="pc-display min-w-0 truncate text-name text-text-primary">{bot.name}</h3>
          {bot.verified_developer && (
            <Chip size="sm" tone="accent">
              <ShieldCheck size={11} aria-hidden />
              Verified
            </Chip>
          )}
        </div>

        <p className="text-body leading-relaxed text-text-secondary">
          {bot.description ||
            'This developer has not written a listing yet — open their page before you add it to a building.'}
        </p>

        {(bot.category || bot.tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {bot.category && <Chip size="sm">{bot.category}</Chip>}
            {bot.tags.slice(0, 3).map((tag) => (
              <Chip key={tag} size="sm">
                {tag}
              </Chip>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-text-faint">
            <span className="inline-flex items-center gap-1.5">
              <Download size={12} aria-hidden />
              <span className="pc-mono">
                {`${bot.install_count.toLocaleString()} ${bot.install_count === 1 ? 'building' : 'buildings'}`}
              </span>
            </span>
            {typeof bot.average_rating === 'number' && typeof bot.review_count === 'number' && (
              <span className="inline-flex items-center gap-1.5">
                <Star size={12} className="text-accent-warning" aria-hidden />
                <span className="pc-mono">
                  {bot.average_rating.toFixed(1)} ({bot.review_count})
                </span>
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAdd(bot)}
            disabled={!canManage || adding}
          >
            {adding ? 'Adding...' : 'Add to server'}
            {!adding && <ArrowRight size={14} aria-hidden />}
          </Button>
        </div>
      </div>
    </Well>
  );
}
