import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, RotateCw, AlertCircle } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { guildApi } from '../../api/guilds';
import type { Sticker } from '../../types/message.types';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { getDownloadTicket } from '../../lib/downloadTicket';
import { safeClientResourceUrl } from '../../lib/security';
import { EmptyState } from '../ui/Feedback';
import { Skeleton } from '../ui/Skeleton';

interface StickerPickerProps {
  guildId?: string;
  onSelect: (stickerId: string) => void;
  onClose: () => void;
}

function resolveStickerImageUrl(url: string): string | null {
  const rawUrl = url.trim();
  const safeRawUrl = safeClientResourceUrl(rawUrl);
  if (!safeRawUrl) return null;
  return safeClientResourceUrl(resolveResourceUrl(safeRawUrl, getDownloadTicket()));
}

function stickerPickerError(action: string, err: unknown): string {
  const detail = extractApiError(err);
  return detail ? `${action}: ${detail}` : action;
}

export function StickerPicker({ guildId, onSelect, onClose }: StickerPickerProps) {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [filtered, setFiltered] = useState<Sticker[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const fetchStickers = useCallback(async () => {
    if (!guildId) {
      setError('No guild selected.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await guildApi.listStickers(guildId);
      const data = resp.data ?? [];
      setStickers(data);
      setFiltered(data);
    } catch (err: unknown) {
      setError(stickerPickerError('Failed to load stickers', err));
    } finally {
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    void fetchStickers();
  }, [fetchStickers]);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setFiltered(stickers);
    } else {
      setFiltered(stickers.filter((s) => s.name.toLowerCase().includes(q)));
    }
  }, [query, stickers]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={pickerRef}
      className="popup-enter flex flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-floating shadow-lg"
      style={{ width: 340, maxHeight: 420 }}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-border-subtle px-3 pb-2.5 pt-3">
        <div className="text-section mb-2 uppercase text-text-muted">Stickers</div>
        <div className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-2 transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            type="text"
            placeholder="Search stickers..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            className="flex-1 bg-transparent text-body text-text-primary placeholder:text-text-muted outline-none"
          />
        </div>
      </div>

      {/* Sticker grid */}
      <div className="scrollbar-thin flex-1 overflow-y-auto p-2">
        {error ? (
          <EmptyState
            role="alert"
            icon={<AlertCircle size={20} className="text-accent-danger" />}
            title="Couldn't load stickers"
            description={error}
            action={
              guildId ? (
                <button
                  type="button"
                  onClick={() => void fetchStickers()}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-accent-primary px-3.5 py-2 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)]"
                >
                  <RotateCw size={15} />
                  Try again
                </button>
              ) : undefined
            }
          />
        ) : loading ? (
          <div className="grid grid-cols-4 gap-1.5" aria-busy="true" aria-label="Loading stickers">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} borderRadius="var(--radius-sm)" className="aspect-square" />
            ))}
          </div>
        ) : filtered.length === 0 && stickers.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title={guildId ? 'No stickers yet' : 'Stickers live in a server'}
            description={
              guildId
                ? "This server hasn't added any stickers. Upload some in Server Settings to react with them here."
                : 'Open a channel inside a community to browse its sticker pack.'
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title="No stickers found"
            description={`Nothing matches "${query.trim()}" — try a shorter term.`}
          />
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {filtered.map((sticker) => {
              const imageUrl = sticker.image_url ? resolveStickerImageUrl(sticker.image_url) : null;
              return (
                <button
                  key={sticker.id}
                  type="button"
                  onClick={() => onSelect(sticker.id)}
                  title={sticker.name}
                  aria-label={`Select sticker ${sticker.name}`}
                  className="flex aspect-square items-center justify-center rounded-sm p-1 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                >
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt={sticker.name}
                      loading="lazy"
                      className="block h-full w-full rounded-xs object-contain"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center break-words p-0.5 text-center text-[10px] text-text-muted">
                      {sticker.name}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: sticker count */}
      {stickers.length > 0 && (
        <div className="shrink-0 border-t border-border-subtle px-3 py-1.5 text-right text-[10px] text-text-muted">
          {filtered.length} sticker{filtered.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
