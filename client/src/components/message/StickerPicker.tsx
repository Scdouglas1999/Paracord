import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, RotateCw, AlertCircle } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { guildApi } from '../../api/guilds';
import type { Sticker } from '../../types/message.types';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { getDownloadTicket } from '../../lib/downloadTicket';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { safeClientResourceUrl } from '../../lib/security';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { ResourceImage } from '../ui/ResourceImage';
import { Skeleton, SkeletonSwap } from '../ui/Skeleton';

interface StickerPickerProps {
  guildId?: string;
  onSelect: (stickerId: string) => void;
  onClose: () => void;
  /**
   * The picker has been dismissed and is playing its leave (§5.2): it shrinks
   * back toward its anchor and takes no more input. The host keeps it mounted
   * for the beat with `useLingering`.
   */
  leaving?: boolean;
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

export function StickerPicker({ guildId, onSelect, onClose, leaving = false }: StickerPickerProps) {
  // Sticker images are authenticated by a download ticket minted after the
  // first paint; re-render once it lands so the sheet is not a grid of
  // broken images.
  useDownloadTicket();
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [filtered, setFiltered] = useState<Sticker[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const fetchStickers = useCallback(async () => {
    if (!guildId) {
      setError('No server selected.');
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
    const onStickersChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ guild_id?: string }>).detail;
      if (detail?.guild_id && guildId && detail.guild_id !== guildId) return;
      void fetchStickers();
    };
    window.addEventListener('paracord:stickers-changed', onStickersChanged);
    return () => window.removeEventListener('paracord:stickers-changed', onStickersChanged);
  }, [fetchStickers, guildId]);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setFiltered(stickers);
    } else {
      setFiltered(stickers.filter((s) => s.name.toLowerCase().includes(q)));
    }
  }, [query, stickers]);

  // Close on click outside or Escape (ignore composer toggle buttons that own this picker)
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (pickerRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-composer-picker-toggle]')) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={pickerRef}
      className={`${leaving ? 'pc-pop-out' : 'pc-pop-in'} pc-floating flex w-[min(360px,calc(100vw-1rem))] h-[min(420px,calc(100dvh-1rem))] flex-col overflow-hidden rounded-[16px]`}
      aria-hidden={leaving || undefined}
    >
      {/* The search field (the host's tab already says Stickers). */}
      <div className="shrink-0 px-3 pb-1.5 pt-3">
        <div className="pc-field flex h-10 items-center gap-2 px-3">
          <Search size={16} className="shrink-0 text-[var(--ix-ink-3)]" />
          <input
            type="text"
            placeholder="Search stickers..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            className="flex-1 bg-transparent text-[15px] text-[var(--ix-ink)] placeholder:text-[var(--ix-ink-3)] outline-none"
          />
        </div>
      </div>

      {/* Sticker grid — the placeholder crossfades to the stickers (§5.3). */}
      <SkeletonSwap busy={loading && !error} className="scrollbar-thin flex-1 overflow-y-auto p-2">
        {error ? (
          <EmptyState
            role="alert"
            icon={<AlertCircle size={20} className="text-[var(--ix-danger-ink)]" />}
            title="Couldn't load stickers"
            description={error}
            action={
              guildId ? (
                <Button variant="glass" size="sm" onClick={() => void fetchStickers()}>
                  <RotateCw size={15} />
                  Try again
                </Button>
              ) : undefined
            }
          />
        ) : loading ? (
          <div className="grid grid-cols-4 gap-1.5" aria-busy="true" aria-label="Loading stickers">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} borderRadius="12px" className="aspect-square" />
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
                  className="pc-focusable flex aspect-square items-center justify-center rounded-[10px] p-1 outline-none transition-colors duration-[120ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill)] active:bg-[var(--ix-fill-2)]"
                >
                  <ResourceImage
                    src={imageUrl}
                    alt={sticker.name}
                    loading="lazy"
                    className="block h-full w-full rounded-[8px] object-contain"
                    fallback={
                      <span className="flex h-full w-full items-center justify-center break-words p-0.5 text-center text-[10px] text-[var(--ix-ink-3)]">
                        {sticker.name}
                      </span>
                    }
                  />
                </button>
              );
            })}
          </div>
        )}
      </SkeletonSwap>

      {/* Footer: sticker count */}
      {stickers.length > 0 && (
        <div className="shrink-0 px-3 py-2 text-right text-[12px] tabular-nums text-[var(--ix-ink-3)] shadow-[inset_0_1px_0_var(--ix-line)]">
          {filtered.length} sticker{filtered.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
