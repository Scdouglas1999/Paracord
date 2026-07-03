import { useState } from 'react';
import { Bot, ArrowRight, Download, ShieldCheck, Star } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { StoreBot } from '../../api/botStore';
import { safeStoredImageDataUrl } from '../../lib/security';

interface BotStoreCardProps {
  bot: StoreBot;
  onAdd: (bot: StoreBot) => void;
  adding?: boolean;
  canManage: boolean;
}

export function BotStoreCard({ bot, onAdd, adding, canManage }: BotStoreCardProps) {
  const [iconError, setIconError] = useState(false);
  const iconSrc = safeStoredImageDataUrl(bot.icon_hash);

  return (
    <div className="card-surface flex flex-col rounded-2xl border border-border-subtle bg-bg-mod-subtle/40 p-5 transition-colors hover:border-border-strong hover:bg-bg-mod-subtle/60">
      <div className="flex items-start gap-4 mb-4">
        <div className="w-12 h-12 flex items-center justify-center rounded-xl flex-shrink-0 bg-accent-primary/10">
          {iconSrc && !iconError ? (
            <img
              src={iconSrc}
              alt={bot.name}
              className="w-12 h-12 rounded-xl object-cover"
              onError={() => setIconError(true)}
            />
          ) : (
            <Bot size={24} className="text-accent-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-text-primary truncate">{bot.name}</h3>
            {bot.verified_developer && (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent-success/40 bg-accent-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-success">
                <ShieldCheck size={11} />
                Verified
              </span>
            )}
          </div>
          <p className="text-[13px] text-text-muted mt-0.5 line-clamp-2 leading-relaxed">
            {bot.description || 'No description provided.'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {bot.category && (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-accent-primary bg-accent-primary/10 px-2 py-0.5 rounded-full">
            {bot.category}
          </span>
        )}
        {bot.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="text-[11px] font-medium text-text-muted bg-bg-mod-strong/50 px-2 py-0.5 rounded-full"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-auto pt-4 border-t border-border-subtle/50 flex items-center justify-between">
        <div className="space-y-0.5">
          <span className="text-xs font-semibold text-text-muted flex items-center gap-1">
            <Download size={12} />
            {bot.install_count.toLocaleString()} {bot.install_count === 1 ? 'server' : 'servers'}
          </span>
          {typeof bot.average_rating === 'number' && typeof bot.review_count === 'number' && (
            <span className="text-[11px] text-text-muted inline-flex items-center gap-1">
              <Star size={11} className="text-accent-warning" />
              {bot.average_rating.toFixed(1)} ({bot.review_count})
            </span>
          )}
        </div>
        <button
          onClick={() => onAdd(bot)}
          disabled={!canManage || adding}
          className={cn(
            'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-70 disabled:cursor-not-allowed',
            'bg-accent-primary hover:bg-accent-primary-hover text-on-accent shadow-sm shadow-accent-primary/20 hover:shadow-accent-primary/40',
          )}
        >
          {adding ? 'Adding...' : 'Add to Server'}
          {!adding && <ArrowRight size={14} />}
        </button>
      </div>
    </div>
  );
}
