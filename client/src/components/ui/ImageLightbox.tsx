import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { useLightboxStore } from '../../stores/lightboxStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { safeClientResourceUrl } from '../../lib/security';

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

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      style={{
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        animation: 'overlay-enter 0.15s ease-out',
      }}
      onClick={handleBackdropClick}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between p-3">
        <span className="truncate rounded-lg px-2 py-1 text-sm font-medium text-white/80" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
          {currentImage.filename}
          {images.length > 1 && (
            <span className="ml-2 text-white/50">
              {currentIndex + 1} / {images.length}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM))}
            className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={18} />
          </button>
          <span className="min-w-[3rem] text-center text-xs text-white/50">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM))}
            className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={18} />
          </button>
          <button
            onClick={handleDownload}
            className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Download"
            aria-label="Download image"
          >
            <Download size={18} />
          </button>
          <button
            onClick={close}
            className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
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
          className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          title="Previous"
          aria-label="Previous image"
        >
          <ChevronLeft size={28} />
        </button>
      )}
      {hasNext && (
        <button
          onClick={next}
          className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          title="Next"
          aria-label="Next image"
        >
          <ChevronRight size={28} />
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
