import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { lightboxImageSource, useLightboxStore, type LightboxImage } from '../../stores/lightboxStore';
import { extractApiError } from '../../api/client';
import { safeClientResourceUrl } from '../../lib/security';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { IX_SPRING, IX_REDUCED_MS, canAnimate, flipFromRect, invertTransform, ixReduced, measureRect, onSettle } from '../ix/motion';
import { cn } from '../../lib/utils';
import { MediaPreview } from '../file/MediaPreview';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/** The picture grows out of its bubble, and shrinks back into it (§6.10, §5: 205ms on the spring). */
const VIEWER_FLIP_MS = 205;
/** How long a press stays "what opened the viewer" (an attachment may be fetched first). */
const SOURCE_WINDOW_MS = 10_000;

/**
 * What was pressed last: the viewer is opened by a store call that carries no
 * element, so the media bubble it should grow out of is found by the press that
 * caused it. A press is remembered for a few seconds and used once.
 */
let lastPress: { element: Element; at: number } | null = null;

if (typeof document !== 'undefined') {
  const remember = (event: Event) => {
    const target = event.target;
    if (target instanceof Element) lastPress = { element: target, at: performance.now() };
  };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' || event.key === ' ') remember(event);
    },
    true,
  );
}

/** The picture inside whatever was pressed, if it is still on screen. */
function takeSource(): Element | null {
  const press = lastPress;
  lastPress = null;
  if (!press || performance.now() - press.at > SOURCE_WINDOW_MS || !press.element.isConnected) return null;
  const trigger = press.element.closest('button, a, [role="button"]') ?? press.element;
  const media = trigger.matches('img, video, canvas') ? trigger : (trigger.querySelector('img, video, canvas') ?? trigger);
  const rect = measureRect(media);
  if (!rect || rect.width < 8 || rect.height < 8) return null;
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return null;
  return media;
}

/**
 * The source of a deferred entry, fetched when it becomes the current one and
 * released when the viewer moves on or closes.
 */
function useDeferredSource(image: LightboxImage | undefined): { src: string | null; error: string | null } {
  const [state, setState] = useState<{ image: LightboxImage; src: string | null; error: string | null } | null>(null);
  useEffect(() => {
    const load = image?.load;
    if (!image || !load) return;
    let canceled = false;
    let objectUrl: string | null = null;
    load().then(
      (resolved) => {
        const safe = resolved.startsWith('blob:') ? resolved : safeClientResourceUrl(resolved);
        if (resolved.startsWith('blob:')) objectUrl = resolved;
        if (canceled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        setState({ image, src: safe, error: safe ? null : 'the file address was refused' });
      },
      (err: unknown) => {
        if (!canceled) setState({ image, src: null, error: extractApiError(err) });
      },
    );
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image]);
  if (!state || state.image !== image) return { src: null, error: null };
  return { src: state.src, error: state.error };
}

/** What is on screen, kept so the leave can play after the store has dropped its images. */
interface Shown {
  image: LightboxImage;
  src: string | null;
  error: string | null;
  index: number;
  total: number;
}

type Phase = 'closed' | 'open' | 'closing';

/**
 * The media viewer (docs/index-spec.md §6.10): near-black (`--ix-viewer`) over the
 * whole window; the picture grows out of the bubble that was pressed (a FLIP,
 * 205ms on the spring) and shrinks back into it on close; close, download and
 * the arrows are 40px controls; the caption line sits at the bottom. Escape and
 * the arrow keys keep working; the wheel and +/- zoom.
 */
export function ImageLightbox() {
  const isOpen = useLightboxStore((s) => s.isOpen);
  const images = useLightboxStore((s) => s.images);
  const currentIndex = useLightboxStore((s) => s.currentIndex);
  const close = useLightboxStore((s) => s.close);
  const next = useLightboxStore((s) => s.next);
  const prev = useLightboxStore((s) => s.prev);

  const [zoom, setZoom] = useState(1);
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<Element | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [phase, setPhase] = useState<Phase>('closed');

  const currentImage = images[currentIndex];
  const deferred = useDeferredSource(currentImage);
  const safeImageSrc = currentImage
    ? currentImage.load ? deferred.src : lightboxImageSource(currentImage)
    : null;
  const hasNext = currentIndex < images.length - 1;
  const hasPrev = currentIndex > 0;

  // Opening and closing are decided during render so the picture is in the tree
  // on the commit that opens it (the FLIP measures it in a layout effect).
  const viewable = isOpen && Boolean(currentImage) && (Boolean(safeImageSrc) || Boolean(currentImage?.load));
  if (viewable && phase !== 'open') setPhase('open');
  else if (!isOpen && phase === 'open') setPhase('closing');

  // What is on screen is kept in state, so the leave can play after the store has
  // dropped its images.
  if (
    viewable &&
    currentImage &&
    (!shown ||
      shown.image !== currentImage ||
      shown.src !== safeImageSrc ||
      shown.error !== deferred.error ||
      shown.index !== currentIndex ||
      shown.total !== images.length)
  ) {
    setShown({ image: currentImage, src: safeImageSrc, error: deferred.error, index: currentIndex, total: images.length });
  }

  useFocusTrap(backdropRef, phase === 'open', close);

  // Reset zoom when the image changes.
  useEffect(() => {
    // The zoom belongs to the picture on screen.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // Growing out of the bubble: the first commit of an open viewer, with the
  // picture in the tree. Video, an error and a source that has scrolled away
  // fade in instead.
  const openedFor = useRef<LightboxImage | null>(null);
  useLayoutEffect(() => {
    if (phase !== 'open') {
      openedFor.current = null;
      return;
    }
    if (openedFor.current) return;
    const stage = stageRef.current;
    if (!stage || !shown?.src || shown.image.kind === 'video') return;
    openedFor.current = shown.image;
    const source = takeSource();
    sourceRef.current = source;
    const from = measureRect(source);
    if (!from) return;
    const grow = () =>
      flipFromRect(stage, from, { duration: VIEWER_FLIP_MS, easing: IX_SPRING, scale: 'xy', id: 'ix-viewer:grow' });
    // The picture's size is known once it has loaded; until then there is nothing to move.
    const picture = stage.querySelector('img');
    if (picture && !picture.complete) {
      picture.addEventListener('load', grow, { once: true });
      return () => picture.removeEventListener('load', grow);
    }
    grow();
  }, [phase, shown?.src, shown?.image]);

  // Shrinking back into it: the store has already dropped its images, so the
  // leave plays from what was on screen, then the viewer is removed.
  useLayoutEffect(() => {
    if (phase !== 'closing') return;
    const stage = stageRef.current;
    const backdrop = backdropRef.current;
    const source = sourceRef.current;
    const to = measureRect(source);
    const animations: Animation[] = [];
    if (backdrop && canAnimate(backdrop)) {
      const fade = backdrop.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: ixReduced() ? IX_REDUCED_MS : 135,
        easing: 'ease-out',
        fill: 'forwards',
      });
      fade.id = 'ix-viewer:scrim';
      animations.push(fade);
    }
    if (stage && to && canAnimate(stage) && !ixReduced()) {
      const transform = invertTransform(to, stage.getBoundingClientRect(), 'xy');
      if (transform) {
        const shrink = stage.animate(
          [
            { transform: 'none', transformOrigin: '0 0' },
            { transform, transformOrigin: '0 0' },
          ],
          {
            duration: VIEWER_FLIP_MS,
            easing: IX_SPRING,
            fill: 'forwards',
          },
        );
        shrink.id = 'ix-viewer:shrink';
        animations.push(shrink);
      }
    }
    return onSettle(animations, () => {
      sourceRef.current = null;
      setShown(null);
      setPhase('closed');
    });
  }, [phase]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((z) => Math.min(Math.max(z + delta, MIN_ZOOM), MAX_ZOOM));
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) close();
    },
    [close],
  );

  const handleDownload = useCallback(() => {
    if (!shown?.src) return;
    const a = document.createElement('a');
    a.href = shown.src;
    a.download = shown.image.filename;
    a.click();
  }, [shown]);

  if (phase === 'closed' || !shown) return null;
  const leaving = phase === 'closing';
  const { image: currentShown, src: shownSrc, error: shownError } = shown;

  // A 40px control over the viewer's near-black: the quiet fill and the ink,
  // one step lighter on hover (§6.10).
  const controlClass =
    'pc-focusable flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--ix-fill-ctl)] text-[var(--ix-ink-2)] transition-colors duration-[55ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-ctl-hover)] hover:text-[var(--ix-ink)]';

  return createPortal(
    <div
      ref={backdropRef}
      className={cn(
        'fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--ix-viewer)] text-[var(--ix-ink)]',
        !leaving && 'pc-scrim-in',
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      onClick={handleBackdropClick}
      {...(leaving ? { 'aria-hidden': true as const, inert: true as const } : null)}
    >
      {/* Top bar */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 flex items-center justify-end gap-2 p-4">
        <div className="pointer-events-auto flex h-10 items-center gap-0.5 rounded-[12px] bg-[var(--ix-fill-ctl)] px-1">
          <button
            onClick={() => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM))}
            className="pc-focusable flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--ix-ink-2)] transition-colors duration-[55ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-2)] hover:text-[var(--ix-ink)]"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={18} />
          </button>
          <span className="min-w-[3rem] text-center text-[12.5px] font-medium tabular-nums text-[var(--ix-ink-2)]">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM))}
            className="pc-focusable flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--ix-ink-2)] transition-colors duration-[55ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-2)] hover:text-[var(--ix-ink)]"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={18} />
          </button>
        </div>
        <button
          onClick={handleDownload}
          className={cn(controlClass, 'pointer-events-auto')}
          title="Download"
          aria-label="Download image"
        >
          <Download size={18} />
        </button>
        <button
          onClick={close}
          className={cn(controlClass, 'pointer-events-auto')}
          title="Close (Esc)"
          aria-label="Close image viewer"
        >
          <X size={20} />
        </button>
      </div>

      {/* Navigation arrows */}
      {hasPrev && !leaving && (
        <button
          onClick={prev}
          className={cn(controlClass, 'absolute left-4 top-1/2 z-10 -translate-y-1/2')}
          title="Previous"
          aria-label="Previous image"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {hasNext && !leaving && (
        <button
          onClick={next}
          className={cn(controlClass, 'absolute right-4 top-1/2 z-10 -translate-y-1/2')}
          title="Next"
          aria-label="Next image"
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* The picture: the stage is what the FLIP moves, the zoom is the picture's own.
          The stage is the scroller itself, so its own travel is never clipped by it. */}
      <div
        ref={stageRef}
        className="flex items-center justify-center overflow-auto"
        style={{ maxWidth: '90vw', maxHeight: '82vh' }}
        onWheel={handleWheel}
      >
        <div className="flex items-center justify-center">
          {!shownSrc ? (
            shownError ? (
              <p role="alert" className="rounded-[12px] bg-[var(--ix-fill-ctl)] px-3 py-2 text-[14px] text-[var(--ix-danger-ink)]">
                Could not load {currentShown.filename}: {shownError}
              </p>
            ) : (
              <p className="rounded-[12px] bg-[var(--ix-fill-ctl)] px-3 py-2 text-[14px] text-[var(--ix-ink-2)]">Loading…</p>
            )
          ) : currentShown.kind === 'video' ? (
            // The same player as a message's video, so a gallery video can take captions too.
            <div className="rounded-[18px] bg-[var(--ix-card)] p-2">
              <MediaPreview
                key={shownSrc}
                src={shownSrc}
                filename={currentShown.filename}
                kind="video"
                autoPlay
                videoStyle={{ maxWidth: '88vw', maxHeight: 'calc(82vh - 4.5rem)' }}
              />
            </div>
          ) : (
            <img
              src={shownSrc}
              alt={currentShown.alt}
              draggable={false}
              style={{
                transform: `scale(${zoom})`,
                transition: 'transform 55ms var(--ix-ease)',
                maxWidth: '90vw',
                maxHeight: '82vh',
                objectFit: 'contain',
                userSelect: 'none',
                borderRadius: 4,
              }}
            />
          )}
        </div>
      </div>

      {/* The caption line */}
      <p className="pointer-events-none absolute bottom-0 left-0 right-0 flex items-baseline justify-center gap-2 px-6 pb-5 text-[13px] text-[var(--ix-ink-2)]">
        <span className="truncate">{currentShown.filename}</span>
        {shown.total > 1 && (
          <span className="shrink-0 tabular-nums text-[var(--ix-ink-3)]">
            {shown.index + 1} / {shown.total}
          </span>
        )}
      </p>
    </div>,
    document.body,
  );
}
