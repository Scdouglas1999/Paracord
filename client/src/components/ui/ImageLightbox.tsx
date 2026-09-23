import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { lightboxImageSource, useLightboxStore, type LightboxImage } from '../../stores/lightboxStore';
import { extractApiError } from '../../api/client';
import { safeClientResourceUrl } from '../../lib/security';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { MediaPreview } from '../file/MediaPreview';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/**
 * The source of a deferred entry, fetched when it becomes the current one and
 * released when the viewer moves on or closes.
 */
function useDeferredSource(image: LightboxImage | undefined): { src: string | null; error: string | null } {
  const [state, setState] = useState<{ image: LightboxImage; src: string | null; error: string | null } | null>(null);
  useEffect(() => {
    const load = image?.load;
    if (!image || !load) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    load().then(
      (resolved) => {
        const safe = resolved.startsWith('blob:') ? resolved : safeClientResourceUrl(resolved);
        if (resolved.startsWith('blob:')) objectUrl = resolved;
        if (cancelled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        setState({ image, src: safe, error: safe ? null : 'the file address was refused' });
      },
      (err: unknown) => {
        if (!cancelled) setState({ image, src: null, error: extractApiError(err) });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image]);
  if (!state || state.image !== image) return { src: null, error: null };
  return { src: state.src, error: state.error };
}

export function ImageLightbox() {
  const isOpen = useLightboxStore((s) => s.isOpen);
  const images = useLightboxStore((s) => s.images);
  const currentIndex = useLightboxStore((s) => s.currentIndex);
  const close = useLightboxStore((s) => s.close);
  const next = useLightboxStore((s) => s.next);
  const prev = useLightboxStore((s) => s.prev);

  const [zoom, setZoom] = useState(1);
  const backdropRef = useRef<HTMLDivElement>(null);
  const { mounted, exiting, scenery } = usePresence(isOpen);

  const currentImage = images[currentIndex];
  const deferred = useDeferredSource(currentImage);
  const safeImageSrc = currentImage
    ? currentImage.load ? deferred.src : lightboxImageSource(currentImage)
    : null;
  const hasNext = currentIndex < images.length - 1;
  const hasPrev = currentIndex > 0;

  useFocusTrap(backdropRef, isOpen, close);

  // Reset zoom when image changes
  useEffect(() => {
    setZoom(1);
  }, [currentIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case 'Escape':
          close();
          break;
        case 'ArrowLeft':
          if (hasPrev) prev();
          break;
        case 'ArrowRight':
          if (hasNext) next();
          break;
        case '+':
        case '=':
          setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
          break;
        case '-':
          setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
          break;
      }
    },
    [isOpen, close, next, prev, hasNext, hasPrev],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      return Math.min(Math.max(z + delta, MIN_ZOOM), MAX_ZOOM);
    });
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        close();
      }
    },
    [close],
  );

  const handleDownload = useCallback(() => {
    if (!currentImage || !safeImageSrc) return;
    const a = document.createElement('a');
    a.href = safeImageSrc;
    a.download = currentImage.filename;
    a.click();
  }, [currentImage, safeImageSrc]);

  if (!mounted || !currentImage) return null;
  if (!safeImageSrc && !currentImage.load) return null;

  // A control over arbitrary imagery is a name tag (spec §8 `pc-tag`): the tag
  // fill plus the primary ink. That is the system's answer to "ink over a
  // photo", so nothing here has to invent a literal white.
  const controlClass =
    'pc-tag pc-focusable flex h-9 w-9 items-center justify-center transition-[filter] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:brightness-125';

  return createPortal(
    <div
      ref={backdropRef}
      className={cn(
        'fixed inset-0 z-[10000] flex items-center justify-center',
        exiting ? 'pc-fade-out' : 'pc-fade-in',
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      style={{
        backgroundColor: 'var(--overlay-backdrop)',
      }}
      onClick={handleBackdropClick}
      {...scenery}
    >
      {/* Top bar */}
      <div className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between gap-3 p-3">
        <span className="pc-tag truncate px-2.5 py-1 text-meta">
          {currentImage.filename}
          {images.length > 1 && (
            <span className="pc-mono ml-2 text-text-secondary">
              {currentIndex + 1} / {images.length}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <div className="pc-tag flex items-center gap-1 px-1">
            <button
              onClick={() => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM))}
              className="pc-focusable flex h-8 w-8 items-center justify-center rounded-[var(--radius-chip)] text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-text-primary"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut size={18} />
            </button>
            <span className="pc-mono min-w-[3rem] text-center text-meta text-text-secondary">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM))}
              className="pc-focusable flex h-8 w-8 items-center justify-center rounded-[var(--radius-chip)] text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-text-primary"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn size={18} />
            </button>
          </div>
          <button
            onClick={handleDownload}
            className={controlClass}
            title="Download"
            aria-label="Download image"
          >
            <Download size={18} />
          </button>
          <button
            onClick={close}
            className={controlClass}
            title="Close (Esc)"
            aria-label="Close image viewer"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Navigation arrows */}
      {hasPrev && (
        <button
          onClick={prev}
          className={cn(controlClass, 'absolute left-3 top-1/2 z-10 -translate-y-1/2')}
          title="Previous"
          aria-label="Previous image"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {hasNext && (
        <button
          onClick={next}
          className={cn(controlClass, 'absolute right-3 top-1/2 z-10 -translate-y-1/2')}
          title="Next"
          aria-label="Next image"
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* Image */}
      <div
        className="flex items-center justify-center overflow-auto"
        style={{ maxWidth: '90vw', maxHeight: '85vh' }}
        onWheel={handleWheel}
      >
        {!safeImageSrc ? (
          deferred.error ? (
            <p role="alert" className="pc-tag px-3 py-2 text-label text-accent-danger">
              Could not load {currentImage.filename}: {deferred.error}
            </p>
          ) : (
            <p className="pc-tag px-3 py-2 text-label">Loading…</p>
          )
        ) : currentImage.kind === 'video' ? (
          // The same player as a message's video, so a gallery video can take captions too.
          <div className="pc-tag px-3 py-2">
            <MediaPreview
              key={safeImageSrc}
              src={safeImageSrc}
              filename={currentImage.filename}
              kind="video"
              autoPlay
              videoStyle={{ maxWidth: '88vw', maxHeight: 'calc(85vh - 4.5rem)' }}
            />
          </div>
        ) : (
          <img
            src={safeImageSrc}
            alt={currentImage.alt}
            draggable={false}
            style={{
              transform: `scale(${zoom})`,
              transition: 'transform var(--duration-fast) var(--ease-out)',
              maxWidth: '90vw',
              maxHeight: '85vh',
              objectFit: 'contain',
              userSelect: 'none',
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
