import { useState, useEffect, useRef, useCallback } from 'react';
import { tenorApi } from '../../api/tenor';
import { safeExternalUrl } from '../../lib/security';
import { LoadingSpinner } from '../ui/Feedback';

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
      className="popup-enter"
      style={{
        width: 400,
        maxHeight: 460,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '1rem',
        background: 'linear-gradient(165deg, var(--glass-modal-fill-top), var(--glass-modal-fill-bottom))',
        backdropFilter: 'blur(22px) saturate(150%)',
        border: '1px solid var(--border-strong)',
        boxShadow: 'var(--shadow-xl)',
        overflow: 'hidden',
      }}
    >
      {/* Search input */}
      <div style={{ padding: '10px 12px 6px', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-mod-subtle)',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--text-muted)', flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search GIFs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 13,
              color: 'var(--text-primary)',
              lineHeight: 1.4,
            }}
          />
        </div>
      </div>

      {/* GIF grid */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 8px 8px',
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--scrollbar-auto-thumb) transparent',
        }}
      >
        {error && (
          <div style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            {error}
          </div>
        )}

        {loading && visibleGifs.length === 0 && !error && (
          <div className="py-4">
            <LoadingSpinner size="sm" />
          </div>
        )}

        {!loading && !error && visibleGifs.length === 0 && (
          <div style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            No GIFs found.
          </div>
        )}

        {visibleGifs.length > 0 && (
          <div style={{ columns: 2, columnGap: 6 }}>
            {visibleGifs.map(({ gif, renderData }) => {
              return (
                <button
                  key={gif.id}
                  type="button"
                  onClick={() => handleSelect(gif)}
                  title={gif.title || 'GIF'}
                  aria-label={`Select GIF ${gif.title || gif.id}`}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: 0,
                    marginBottom: 6,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 8,
                    cursor: 'pointer',
                    overflow: 'hidden',
                    breakInside: 'avoid',
                    aspectRatio: String(renderData.aspectRatio),
                  }}
                >
                  <img
                    src={renderData.thumbUrl}
                    alt={gif.title || 'GIF'}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 8,
                      display: 'block',
                    }}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Powered by Tenor attribution */}
      <div
        style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
          fontSize: 10,
          color: 'var(--text-muted)',
          textAlign: 'right',
        }}
      >
        Powered by Tenor
      </div>
    </div>
  );
}
