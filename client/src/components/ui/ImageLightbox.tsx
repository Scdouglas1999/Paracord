import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { useLightboxStore } from '../../stores/lightboxStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { safeClientResourceUrl } from '../../lib/security';
import { cn } from '../../lib/utils';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export function ImageLightbox() {
  const isOpen = useLightboxStore((s) => s.isOpen);
  const images = useLightboxStore((s) => s.images);
  const currentIndex = useLightboxStore((s) => s.currentIndex);
  const close = useLightboxStore((s) => s.close);
  const next = useLightboxStore((s) => s.next);
  const prev = useLightboxStore((s) => s.prev);

  const [zoom, setZoom] = useState(1);
  const backdropRef = useRef<HTMLDivElement>(null);

  const currentImage = images[currentIndex];
  const safeImageSrc = currentImage ? safeClientResourceUrl(currentImage.src) : null;
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

  if (!isOpen || !currentImage || !safeImageSrc) return null;

  // Floating control chip — 36px, radius-sm, shadow-md, visible focus ring (§7).
  const controlClass =
    'flex h-9 w-9 items-center justify-center rounded-sm text-white/85 shadow-md outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-white focus-visible:shadow-[var(--focus-ring)]';
  const chipStyle = { backgroundColor: 'rgba(0,0,0,0.45)' } as const;

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      style={{
        backgroundColor: 'var(--overlay-backdrop)',
        animation: 'overlay-enter 0.15s ease-out',
      }}
      onClick={handleBackdropClick}
    >
      {/* Top bar */}
      <div className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between gap-3 p-3">
        <span
          className="truncate rounded-sm px-2.5 py-1 text-meta text-white/85 shadow-md"
          style={chipStyle}
        >
          {currentImage.filename}
          {images.length > 1 && (
            <span className="ml-2 font-code text-white/55">
              {currentIndex + 1} / {images.length}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-sm px-1 shadow-md" style={chipStyle}>
            <button
              onClick={() => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM))}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-white/80 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-white/10 hover:text-white focus-visible:shadow-[var(--focus-ring)]"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut size={18} />
            </button>
            <span className="min-w-[3rem] text-center font-code text-meta text-white/60">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM))}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-white/80 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-white/10 hover:text-white focus-visible:shadow-[var(--focus-ring)]"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn size={18} />
            </button>
          </div>
          <button
            onClick={handleDownload}
            className={controlClass}
            style={chipStyle}
            title="Download"
            aria-label="Download image"
          >
            <Download size={18} />
          </button>
          <button
            onClick={close}
            className={controlClass}
            style={chipStyle}
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
          style={chipStyle}
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
          style={chipStyle}
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
        <img
          src={safeImageSrc}
          alt={currentImage.alt}
          draggable={false}
          style={{
            transform: `scale(${zoom})`,
            transition: 'transform 0.15s ease-out',
            maxWidth: '90vw',
            maxHeight: '85vh',
            objectFit: 'contain',
            userSelect: 'none',
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
