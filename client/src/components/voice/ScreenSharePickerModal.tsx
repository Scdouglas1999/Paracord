import { useEffect, useMemo, useState } from 'react';
import { AppWindow, ImageOff, Monitor, RefreshCw, Volume2, X } from 'lucide-react';

import type { ScreenShareSource } from '../../lib/media/mediaEngine';
import { Modal } from '../ui/Modal';
import { EmptyState } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { logVoiceDiagnostic } from '../../lib/desktopDiagnostics';
import { isSafeImageDataUrl, safeClientResourceUrl } from '../../lib/security';
import { cn } from '../../lib/utils';

interface ScreenSharePickerModalProps {
  sources: ScreenShareSource[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (source: ScreenShareSource) => void;
  loadThumbnail: (sourceId: string) => Promise<string | null>;
}

type SourceFilter = 'all' | 'screen' | 'window';

function ScreenShareSourceCard({
  source,
  onSelect,
  thumbnailUrl,
}: {
  source: ScreenShareSource;
  onSelect: (source: ScreenShareSource) => void;
  thumbnailUrl?: string | null;
}) {
  const icon = source.kind === 'window' ? <AppWindow size={16} /> : <Monitor size={16} />;
  const safeThumbnailUrl = typeof thumbnailUrl === 'string'
    ? safeClientResourceUrl(thumbnailUrl) ?? (isSafeImageDataUrl(thumbnailUrl) ? thumbnailUrl : null)
    : thumbnailUrl;

  // Selectable tile (design-spec §7): resting hairline, hover/focus lifts to an
  // --accent-primary ring over an --accent-tint wash.
  return (
    <button
      type="button"
      onClick={() => onSelect(source)}
      className="group rounded-md border border-border-subtle bg-bg-secondary p-2.5 text-left outline-none ring-0 ring-accent-primary transition-[border-color,box-shadow,background-color] duration-[140ms] ease-[var(--ease-out)] hover:border-accent-primary hover:bg-accent-tint hover:ring-2 focus-visible:shadow-[var(--focus-ring)]"
    >
      <div className="flex flex-col gap-2.5">
        <div
          className="relative overflow-hidden rounded-sm border border-border-subtle"
          style={{ backgroundColor: 'var(--bg-tertiary)', aspectRatio: '16 / 9' }}
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
              <span className="text-meta font-medium">Loading preview…</span>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center gap-2 text-text-muted">
              <ImageOff size={16} />
              <span className="text-meta font-medium">Preview unavailable</span>
            </div>
          )}
          <div className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-sm border border-white/10 bg-black/65 text-white">
            {icon}
          </div>
        </div>

        <div className="min-w-0">
          <div className="truncate text-label text-text-primary">{source.title}</div>
          {source.appName && (
            <div className="mt-0.5 truncate text-meta text-text-secondary">{source.appName}</div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {source.audioSupported && (
              <span className="inline-flex items-center gap-1 rounded-xs bg-accent-tint px-1.5 py-0.5 text-meta font-semibold text-accent-primary">
                <Volume2 size={11} />
                Audio
              </span>
            )}
            {source.requiresOsPicker && (
              <span className="inline-flex items-center rounded-xs bg-warning-tint px-1.5 py-0.5 text-meta font-semibold text-accent-warning">
                System chooser
              </span>
            )}
            {source.isSelf && (
              <span className="inline-flex items-center rounded-xs bg-danger-tint px-1.5 py-0.5 text-meta font-semibold text-accent-danger">
                Paracord window
              </span>
            )}
          </div>
          {source.isSelf && (
            <div className="mt-1.5 text-meta text-text-muted">
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
  const [thumbnails, setThumbnails] = useState<Record<string, string | null | undefined>>({});
  const [filter, setFilter] = useState<SourceFilter>('all');

  const { displays, windows } = useMemo(() => {
    return {
      displays: sources.filter((source) => source.kind !== 'window'),
      windows: sources.filter((source) => source.kind === 'window'),
    };
  }, [sources]);

  const visibleSources = useMemo(() => {
    if (filter === 'screen') return displays;
    if (filter === 'window') return windows;
    return sources;
  }, [filter, displays, windows, sources]);

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

  const filters: { key: SourceFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: sources.length },
    { key: 'screen', label: 'Screens', count: displays.length },
    { key: 'window', label: 'Windows', count: windows.length },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="screen-share-picker-title"
      describedBy="screen-share-picker-subtitle"
      panelClassName="w-[min(94vw,56rem)]"
    >
      <div className="flex max-h-[min(88dvh,48rem)] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 pb-4 pt-6">
          <div className="min-w-0">
            <h2 id="screen-share-picker-title" className="font-display text-title text-text-primary">
              Share your screen
            </h2>
            <p id="screen-share-picker-subtitle" className="mt-1 text-body text-text-secondary">
              Choose what to share with the call. Desktop capture runs natively in Paracord.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh sources"
              className="flex h-9 w-9 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : undefined} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-9 w-9 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {(sources.length > 0 || loading) && (
          <div className="flex items-center gap-1 border-b border-border-subtle px-6 py-3">
            <div className="inline-flex items-center gap-0.5 rounded-sm bg-bg-tertiary p-0.5">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  disabled={f.count === 0 && f.key !== 'all'}
                  className={cn(
                    'rounded-xs px-3 py-1.5 text-label outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40',
                    filter === f.key
                      ? 'bg-bg-accent text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {f.label}
                  <span className="ml-1.5 tabular-nums text-text-muted">{f.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {error && (
            <div className="mb-4 rounded-sm bg-danger-tint px-3 py-2 text-meta font-medium text-accent-danger">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-3 text-body text-text-secondary">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Looking for screens and windows…
            </div>
          ) : sources.length === 0 ? (
            <EmptyState
              icon={<Monitor size={20} />}
              title="No windows available to share yet"
              description="Open an app or bring a screen into view, then refresh to pick what your call sees."
              action={
                <Button variant="secondary" onClick={onRefresh}>
                  <RefreshCw size={16} className="mr-1.5" />
                  Refresh sources
                </Button>
              }
            />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {visibleSources.map((source) => (
                <ScreenShareSourceCard
                  key={source.id}
                  source={source}
                  onSelect={onSelect}
                  thumbnailUrl={thumbnails[source.id]}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
