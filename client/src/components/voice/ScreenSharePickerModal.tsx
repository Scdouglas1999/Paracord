import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ImageOff, Monitor, RefreshCw, Volume2, X } from 'lucide-react';

import type { ScreenShareSource } from '../../lib/media/mediaEngine';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { logVoiceDiagnostic } from '../../lib/desktopDiagnostics';
import { isSafeImageDataUrl, safeClientResourceUrl } from '../../lib/security';

interface ScreenSharePickerModalProps {
  sources: ScreenShareSource[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (source: ScreenShareSource) => void;
  loadThumbnail: (sourceId: string) => Promise<string | null>;
}

function ScreenShareSourceCard({
  source,
  onSelect,
  thumbnailUrl,
}: {
  source: ScreenShareSource;
  onSelect: (source: ScreenShareSource) => void;
  thumbnailUrl?: string | null;
}) {
  const icon = source.kind === 'window' ? <AppWindow size={18} /> : <Monitor size={18} />;
  const safeThumbnailUrl = typeof thumbnailUrl === 'string'
    ? safeClientResourceUrl(thumbnailUrl) ?? (isSafeImageDataUrl(thumbnailUrl) ? thumbnailUrl : null)
    : thumbnailUrl;

  return (
    <button
      type="button"
      onClick={() => onSelect(source)}
      className="w-full rounded-2xl border p-3 text-left transition-colors hover:border-accent-primary/45 hover:bg-bg-mod-subtle"
      style={{
        borderColor: 'var(--border-subtle)',
        backgroundColor: 'var(--bg-secondary)',
      }}
    >
      <div className="flex flex-col gap-3">
        <div
          className="relative overflow-hidden rounded-2xl border"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-tertiary)',
            aspectRatio: '16 / 9',
          }}
        >
          {typeof safeThumbnailUrl === 'string' ? (
            <img
              src={safeThumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : safeThumbnailUrl === undefined ? (
            <div className="flex h-full w-full items-center justify-center gap-2 text-text-muted">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span className="text-xs font-medium">Loading preview...</span>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center gap-2 text-text-muted">
              <ImageOff size={16} />
              <span className="text-xs font-medium">Preview unavailable</span>
            </div>
          )}
          <div
            className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-xl border"
            style={{
              borderColor: 'rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(15, 18, 24, 0.76)',
              color: 'white',
            }}
          >
            {icon}
          </div>
        </div>

        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary">{source.title}</div>
          {source.appName && (
            <div className="mt-1 truncate text-xs text-text-secondary">{source.appName}</div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {source.audioSupported && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/35 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                <Volume2 size={11} />
                Audio
              </span>
            )}
            {source.requiresOsPicker && (
              <span className="inline-flex items-center rounded-full border border-amber-400/35 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                System Chooser
              </span>
            )}
            {source.isSelf && (
              <span className="inline-flex items-center rounded-full border border-accent-danger/35 bg-accent-danger/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-accent-danger">
                Paracord Window
              </span>
            )}
          </div>
          {source.isSelf && (
            <div className="mt-2 text-[11px] text-text-muted">
              Sharing this can create a recursive mirror effect.
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

export function ScreenSharePickerModal({
  sources,
  loading,
  error,
  onClose,
  onRefresh,
  onSelect,
  loadThumbnail,
}: ScreenSharePickerModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null | undefined>>({});
  useFocusTrap(dialogRef, true, onClose);

  const groupedSources = useMemo(() => {
    const displays = sources.filter((source) => source.kind !== 'window');
    const windows = sources.filter((source) => source.kind === 'window');
    return { displays, windows };
  }, [sources]);

  useEffect(() => {
    let cancelled = false;
    setThumbnails({});

    const load = async () => {
      const concurrency = 4;
      for (let i = 0; i < sources.length; i += concurrency) {
        const batch = sources.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (source) => {
            try {
              const thumbnail = await loadThumbnail(source.id);
              if (cancelled) return;
              setThumbnails((prev) => ({ ...prev, [source.id]: thumbnail }));
            } catch (error) {
              logVoiceDiagnostic('[picker] thumbnail load failed', {
                sourceId: source.id,
                error: error instanceof Error ? error.message : String(error),
              });
              if (cancelled) return;
              setThumbnails((prev) => ({ ...prev, [source.id]: null }));
            }
          })
        );
        if (cancelled) {
          return;
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [sources, loadThumbnail]);

  const modal = (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-share-picker-title"
        tabIndex={-1}
        className="glass-modal modal-content max-h-[min(88dvh,48rem)] w-[min(94vw,56rem)] overflow-auto rounded-3xl border"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="sticky top-0 z-10 border-b px-6 py-5 backdrop-blur-xl sm:px-7"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'color-mix(in srgb, var(--bg-primary) 92%, transparent)',
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="screen-share-picker-title" className="text-xl font-bold text-text-primary">
                Share your screen
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Choose what to share with the call. Desktop capture runs natively in Paracord.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onRefresh} className="icon-btn" aria-label="Refresh sources">
                <RefreshCw size={18} />
              </button>
              <button type="button" onClick={onClose} className="icon-btn" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>
          {error && (
            <div className="mt-4 rounded-2xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm font-medium text-accent-danger">
              {error}
            </div>
          )}
        </div>

        <div className="space-y-6 px-6 py-6 sm:px-7">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center">
              <div className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Loading sources...
              </div>
            </div>
          ) : (
            <>
              {groupedSources.displays.length > 0 && (
                <section>
                  <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-text-muted">
                    Screens
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {groupedSources.displays.map((source) => (
                      <ScreenShareSourceCard
                        key={source.id}
                        source={source}
                        onSelect={onSelect}
                        thumbnailUrl={thumbnails[source.id]}
                      />
                    ))}
                  </div>
                </section>
              )}

              {groupedSources.windows.length > 0 && (
                <section>
                  <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-text-muted">
                    Windows
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {groupedSources.windows.map((source) => (
                      <ScreenShareSourceCard
                        key={source.id}
                        source={source}
                        onSelect={onSelect}
                        thumbnailUrl={thumbnails[source.id]}
                      />
                    ))}
                  </div>
                </section>
              )}

              {sources.length === 0 && !loading && (
                <div className="flex min-h-48 items-center justify-center rounded-3xl border border-border-subtle bg-bg-secondary px-6 py-10 text-center">
                  <div>
                    <div className="text-base font-semibold text-text-primary">No shareable sources found</div>
                    <div className="mt-2 text-sm text-text-secondary">
                      Refresh the list or reopen any screen/window you want to share.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
