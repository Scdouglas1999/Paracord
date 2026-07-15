import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, WifiOff, RotateCw } from 'lucide-react';
import { tenorApi } from '../../api/tenor';
import { safeExternalUrl } from '../../lib/security';
import { EmptyState } from '../ui/Feedback';
import { Skeleton } from '../ui/Skeleton';

interface TenorGif {
  id: string;
  title: string;
  media_formats: {
    gif?: { url: string; dims: [number, number] };
    tinygif?: { url: string; dims: [number, number] };
  };
}

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

function getSafeGifRenderData(gif: TenorGif): { thumbUrl: string; selectUrl: string; aspectRatio: number } | null {
  const thumb = gif.media_formats.tinygif ?? gif.media_formats.gif;
  if (!thumb) return null;

  const thumbUrl = safeExternalUrl(thumb.url);
  const selectUrl = safeExternalUrl(gif.media_formats.gif?.url ?? thumb.url);
  const [width, height] = thumb.dims;
  if (!thumbUrl || !selectUrl || width <= 0 || height <= 0) return null;

  return {
    thumbUrl,
    selectUrl,
    aspectRatio: width / height,
  };
}

type SafeGif = {
  gif: TenorGif;
  renderData: NonNullable<ReturnType<typeof getSafeGifRenderData>>;
};

export function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<TenorGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const fetchGifs = useCallback(async (searchQuery: string) => {
    setLoading(true);
    setError(null);
    try {
      const resp = searchQuery.trim()
        ? await tenorApi.search(searchQuery.trim(), 30)
        : await tenorApi.trending(30);
      setGifs(resp.data?.results ?? []);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 503) {
        setError('GIF search is not available. Server admin needs to configure a Tenor API key.');
      } else {
        setError('Failed to load GIFs.');
      }
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: trending
  useEffect(() => {
    fetchGifs('');
  }, [fetchGifs]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchGifs(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchGifs]);

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

  const handleSelect = (gif: TenorGif) => {
    const renderData = getSafeGifRenderData(gif);
    if (renderData) {
      onSelect(renderData.selectUrl);
    }
  };

  const visibleGifs = gifs
    .map((gif) => ({ gif, renderData: getSafeGifRenderData(gif) }))
    .filter((item): item is SafeGif => item.renderData !== null);

  return (
    <div
      ref={pickerRef}
      className="popup-enter flex w-[min(25rem,calc(100vw-1rem))] max-h-[min(28.75rem,calc(100dvh-1rem))] flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-floating shadow-lg"
    >
      {/* Inset search */}
      <div className="shrink-0 px-3 pb-1.5 pt-3">
        <div className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-2 transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            type="text"
            placeholder="Search GIFs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            className="flex-1 bg-transparent text-body text-text-primary placeholder:text-text-muted outline-none"
          />
        </div>
      </div>

      {/* GIF grid */}
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {error ? (
          <EmptyState
            role="alert"
            icon={<WifiOff size={20} className="text-accent-danger" />}
            title="GIF search is offline"
            description={error}
            action={
              <button
                type="button"
                onClick={() => void fetchGifs(query)}
                className="inline-flex items-center gap-1.5 rounded-sm bg-accent-primary px-3.5 py-2 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)]"
              >
                <RotateCw size={15} />
                Try again
              </button>
            }
          />
        ) : loading && visibleGifs.length === 0 ? (
          <div className="p-1 [column-gap:0.5rem] [columns:2]" aria-busy="true" aria-label="Loading GIFs">
            {[168, 120, 148, 132, 176, 112].map((h, i) => (
              <div key={i} className="mb-2 [break-inside:avoid]">
                <Skeleton height={h} borderRadius="var(--radius-sm)" />
              </div>
            ))}
          </div>
        ) : visibleGifs.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title="No GIFs found"
            description={
              query.trim()
                ? `Nothing matches "${query.trim()}" — try a broader search.`
                : 'Search Tenor for a reaction, moment, or meme to drop in chat.'
            }
          />
        ) : (
          <div className="p-1 [column-gap:0.5rem] [columns:2]">
            {visibleGifs.map(({ gif, renderData }) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => handleSelect(gif)}
                title={gif.title || 'GIF'}
                aria-label={`Select GIF ${gif.title || gif.id}`}
                className="mb-2 block w-full overflow-hidden rounded-sm outline-none transition-[box-shadow] duration-[140ms] ease-[var(--ease-out)] [break-inside:avoid] hover:shadow-md focus-visible:shadow-[var(--focus-ring)]"
                style={{ aspectRatio: String(renderData.aspectRatio) }}
              >
                <img
                  src={renderData.thumbUrl}
                  alt={gif.title || 'GIF'}
                  loading="lazy"
                  className="block h-full w-full rounded-sm object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Attribution */}
      <div className="shrink-0 border-t border-border-subtle px-3 py-1.5 text-right text-[10px] text-text-muted">
        Powered by Tenor
      </div>
    </div>
  );
}
