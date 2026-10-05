import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AppWindow, Check, ImageOff, Monitor, RefreshCw, Volume2 } from 'lucide-react';

import type { ScreenShareSource } from '../../lib/media/mediaEngine';
import { Modal, ModalCloseButton, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';
import { EmptyState } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Tabs } from '../ui/Tabs';
import { PEOPLE_PLACE, useOptionalIxShell, usePlaceHue } from '../ix/shell';
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
  selected,
  onChoose,
  thumbnailUrl,
}: {
  source: ScreenShareSource;
  selected: boolean;
  onChoose: (source: ScreenShareSource) => void;
  thumbnailUrl?: string | null;
}) {
  const icon = source.kind === 'window' ? <AppWindow size={15} /> : <Monitor size={15} />;
  const safeThumbnailUrl = typeof thumbnailUrl === 'string'
    ? safeClientResourceUrl(thumbnailUrl) ?? (isSafeImageDataUrl(thumbnailUrl) ? thumbnailUrl : null)
    : thumbnailUrl;

  // A quiet card with a hairline (§6.12); the one you chose wears the hue
  // selection (`ix-hue-selected`) and a check, so the choice never rests on color.
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onChoose(source)}
      className={cn(
        'pc-focusable group flex flex-col justify-start rounded-[18px] p-2.5 text-left outline-none transition-colors duration-[120ms] ease-[var(--ix-ease)]',
        selected
          ? 'ix-hue-selected'
          : 'bg-[var(--ix-fill-card)] shadow-[inset_0_0_0_1px_var(--ix-line)] hover:bg-[var(--ix-fill-card-hover)]',
      )}
    >
      <div className="flex w-full flex-col gap-2.5">
        <div
          className="pc-well relative overflow-hidden rounded-[12px]"
          style={{ aspectRatio: '16 / 9' }}
        >
          {typeof safeThumbnailUrl === 'string' ? (
            <img
              src={safeThumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : safeThumbnailUrl === undefined ? (
            <div className="flex h-full w-full items-center justify-center gap-2 text-[var(--ix-ink-3)]">
              <span className="text-[12.5px] font-medium">Loading preview…</span>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center gap-2 text-[var(--ix-ink-3)]">
              <ImageOff size={16} />
              <span className="text-[12.5px] font-medium">Preview unavailable</span>
            </div>
          )}
          <div className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-[8px] bg-[var(--ix-capsule)] text-[var(--ix-ink-2)]">
            {icon}
          </div>
          {selected && (
            <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ix-cream)] text-[var(--ix-cream-ink)]">
              <Check size={14} strokeWidth={3} aria-hidden />
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-[var(--ix-ink)]">{source.title}</div>
          {source.appName && (
            <div className="mt-0.5 truncate text-[12.5px] text-[var(--ix-ink-3)]">{source.appName}</div>
          )}
          {(source.audioSupported || source.requiresOsPicker || source.isSelf) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {source.audioSupported && (
                <span className="inline-flex items-center gap-1 rounded-[8px] bg-[var(--ix-fill)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--ix-ink-2)]">
                  <Volume2 size={11} />
                  Audio
                </span>
              )}
              {source.requiresOsPicker && (
                <span className="inline-flex items-center rounded-[8px] bg-[var(--ix-fill)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--ix-ink-2)]">
                  System chooser
                </span>
              )}
              {source.isSelf && (
                <span className="inline-flex items-center rounded-[8px] bg-[var(--ix-danger-fill)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--ix-danger-ink)]">
                  Paracord window
                </span>
              )}
            </div>
          )}
          {source.isSelf && (
            <div className="mt-1.5 text-[12.5px] text-[var(--ix-ink-3)]">
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
  const [chosenId, setChosenId] = useState<string | null>(null);
  // The dialog portals out of the frame, so the place's hue is carried in by hand.
  const shell = useOptionalIxShell();
  const hue = usePlaceHue(shell?.place ?? PEOPLE_PLACE);

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
    let canceled = false;
    setThumbnails({});

    const load = async () => {
      const concurrency = 4;
      for (let i = 0; i < sources.length; i += concurrency) {
        const batch = sources.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (source) => {
            try {
              const thumbnail = await loadThumbnail(source.id);
              if (canceled) return;
              setThumbnails((prev) => ({ ...prev, [source.id]: thumbnail }));
            } catch (error) {
              logVoiceDiagnostic('[picker] thumbnail load failed', {
                sourceId: source.id,
                error: error instanceof Error ? error.message : String(error),
              });
              if (canceled) return;
              setThumbnails((prev) => ({ ...prev, [source.id]: null }));
            }
          })
        );
        if (canceled) {
          return;
        }
      }
    };

    void load();
    return () => {
      canceled = true;
    };
  }, [sources, loadThumbnail]);

  const filters = [
    { value: 'all' as const, label: 'All', meta: String(sources.length) },
    { value: 'screen' as const, label: 'Screens', meta: String(displays.length), disabled: displays.length === 0 },
    { value: 'window' as const, label: 'Windows', meta: String(windows.length), disabled: windows.length === 0 },
  ];
  // A source that has gone (a refresh) cannot stay chosen.
  const chosen = sources.find((source) => source.id === chosenId) ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      labeledBy="screen-share-picker-title"
      describedBy="screen-share-picker-subtitle"
      panelClassName="w-[min(94vw,52rem)]"
    >
      <div className="flex max-h-[min(88dvh,46rem)] flex-col" style={{ '--ix-hue': hue } as CSSProperties}>
        <ModalHeader className="pb-2">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <ModalTitle id="screen-share-picker-title">Share your screen</ModalTitle>
              <ModalDescription id="screen-share-picker-subtitle" className="mt-1">
                Choose what to share with the call. Desktop capture runs natively in Paracord.
              </ModalDescription>
            </div>
            <div className="-mr-2 -mt-1 flex shrink-0 items-center gap-0.5">
              <IconButton label="Refresh sources" onClick={onRefresh}>
                <RefreshCw size={17} className={loading ? 'animate-spin' : undefined} />
              </IconButton>
              <ModalCloseButton className="static" />
            </div>
          </div>
        </ModalHeader>

        {(sources.length > 0 || loading) && (
          <div className="flex items-center px-[22px] pb-1 pt-1">
            <Tabs label="Show" items={filters} value={filter} onChange={setFilter} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-[22px] py-3">
          {error && (
            <div role="alert" className="mb-3 rounded-[12px] bg-[var(--ix-danger-fill)] px-3.5 py-2.5 text-[13px] font-medium leading-relaxed text-[var(--ix-danger-ink)]">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-3 text-[14px] text-[var(--ix-ink-2)]">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Looking for screens and windows…
            </div>
          ) : sources.length === 0 ? (
            <EmptyState
              icon={<Monitor size={20} />}
              title="No windows available to share yet"
              description="Open an app or bring a screen into view, then refresh to pick what your call sees."
              action={
                <Button variant="glass" onClick={onRefresh}>
                  <RefreshCw size={16} />
                  Refresh sources
                </Button>
              }
            />
          ) : (
            <div role="radiogroup" aria-label="What to share" className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {visibleSources.map((source) => (
                <ScreenShareSourceCard
                  key={source.id}
                  source={source}
                  selected={source.id === chosen?.id}
                  onChoose={(picked) => setChosenId(picked.id)}
                  thumbnailUrl={thumbnails[source.id]}
                />
              ))}
            </div>
          )}
        </div>

        <ModalFooter className="pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={() => chosen && onSelect(chosen)}>
            Share
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
