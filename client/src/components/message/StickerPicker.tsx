import { useState, useEffect, useRef, useCallback } from 'react';
import { extractApiError } from '../../api/client';
import { guildApi } from '../../api/guilds';
import type { Sticker } from '../../types/message.types';
import { resolveResourceUrl } from '../../lib/apiBaseUrl';
import { getAccessToken } from '../../lib/authToken';
import { safeClientResourceUrl } from '../../lib/security';

interface StickerPickerProps {
  guildId?: string;
  onSelect: (stickerId: string) => void;
  onClose: () => void;
}

function resolveStickerImageUrl(url: string): string | null {
  const rawUrl = url.trim();
  const safeRawUrl = safeClientResourceUrl(rawUrl);
  if (!safeRawUrl) return null;
  return safeClientResourceUrl(resolveResourceUrl(safeRawUrl, getAccessToken()));
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
      className="popup-enter"
      style={{
        width: 340,
        maxHeight: 420,
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
      {/* Header */}
      <div
        style={{
          padding: '10px 12px 6px',
          flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--text-muted)',
            marginBottom: 8,
          }}
        >
          Stickers
        </div>
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
            width="14"
            height="14"
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
            placeholder="Search stickers..."
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

      {/* Sticker grid */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px',
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--scrollbar-auto-thumb) transparent',
        }}
      >
        {error && (
          <div
            role="alert"
            style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}
          >
            <div>{error}</div>
            {guildId && (
              <button
                type="button"
                onClick={() => void fetchStickers()}
                style={{
                  marginTop: 10,
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-mod-subtle)',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {loading && !error && (
          <div style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            Loading stickers...
          </div>
        )}

        {!loading && !error && filtered.length === 0 && stickers.length === 0 && (
          <div style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            {guildId ? 'This server has no stickers yet.' : 'No stickers available.'}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && stickers.length > 0 && (
          <div style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            No stickers match your search.
          </div>
        )}

        {filtered.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 6,
            }}
          >
            {filtered.map((sticker) => {
              const imageUrl = sticker.image_url ? resolveStickerImageUrl(sticker.image_url) : null;
              return (
                <button
                  key={sticker.id}
                  type="button"
                  onClick={() => onSelect(sticker.id)}
                  title={sticker.name}
                  aria-label={`Select sticker ${sticker.name}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 4,
                    background: 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 8,
                    cursor: 'pointer',
                    aspectRatio: '1',
                    transition: 'background 0.1s, border-color 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-mod-subtle)';
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-subtle)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent';
                  }}
                >
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt={sticker.name}
                      loading="lazy"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        borderRadius: 6,
                        display: 'block',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        color: 'var(--text-muted)',
                        textAlign: 'center',
                        wordBreak: 'break-word',
                        padding: 2,
                      }}
                    >
                      {sticker.name}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: sticker count */}
      {stickers.length > 0 && (
        <div
          style={{
            padding: '5px 12px',
            borderTop: '1px solid var(--border-subtle)',
            flexShrink: 0,
            fontSize: 10,
            color: 'var(--text-muted)',
            textAlign: 'right',
          }}
        >
          {filtered.length} sticker{filtered.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
