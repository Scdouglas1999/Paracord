import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

/**
 * z-index for floating UI over live video.
 * Stack: maximized StreamViewer z-50 → VoiceControlBar z-70 → these overlays
 * z-80 (same as InCallDeviceMenu). Must mount on `document.body` so menus sit
 * in the webview paint order ABOVE the Linux underlay hole (not nested inside
 * `data-native-surface-boundary` / CSS-transformed video ancestors, which
 * break outside-click and glue translucent panels into the stream).
 *
 * Underlay backends do not blank the GL tile for these portals; solid paints
 * via `data-native-overlay-occlude` keep the panel readable over live video.
 */
export const STREAM_OVERLAY_Z_CLASS = 'z-[80]';

export type StreamOverlayPlacement =
  | 'below-start'
  | 'below-end'
  | 'above-start'
  | 'above-end';

export interface AnchoredOverlayCoords {
  top?: number;
  bottom?: number;
  left: number;
}

/**
 * Measure an anchor for a fixed, body-portaled panel. Clamps into the viewport
 * with an 8px gutter so menus stay clickable on narrow layouts.
 */
export function measureAnchoredOverlay(
  anchor: DOMRect,
  opts: {
    placement: StreamOverlayPlacement;
    panelWidth: number;
    gap?: number;
  },
): AnchoredOverlayCoords {
  const gap = opts.gap ?? 8;
  const maxLeft = Math.max(8, window.innerWidth - opts.panelWidth - 8);
  const left = Math.max(8, Math.min(anchor.left, maxLeft));
  const endLeft = Math.max(
    8,
    Math.min(anchor.right - opts.panelWidth, maxLeft),
  );

  switch (opts.placement) {
    case 'below-start':
      return { top: anchor.bottom + gap, left };
    case 'below-end':
      return { top: anchor.bottom + gap, left: endLeft };
    case 'above-start':
      return {
        bottom: Math.max(8, window.innerHeight - anchor.top + gap),
        left,
      };
    case 'above-end':
      return {
        bottom: Math.max(8, window.innerHeight - anchor.top + gap),
        left: endLeft,
      };
  }
}

/** Keep a fixed overlay positioned against an anchor while open. */
export function useAnchoredOverlayCoords(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  placement: StreamOverlayPlacement,
  panelWidth: number,
  gap = 8,
): AnchoredOverlayCoords | null {
  const [coords, setCoords] = useState<AnchoredOverlayCoords | null>(null);

  const update = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    setCoords(
      measureAnchoredOverlay(el.getBoundingClientRect(), {
        placement,
        panelWidth,
        gap,
      }),
    );
  }, [anchorRef, gap, panelWidth, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, update]);

  return open ? coords : null;
}

/**
 * Close when the user points outside both the trigger and the portaled panel.
 * Prefer pointerdown so transparent video / underlay holes that swallow `click`
 * still deliver a dismiss signal when the event reaches the document.
 */
export function useOverlayDismiss(
  open: boolean,
  onClose: () => void,
  isInside: (target: Node) => boolean,
  opts?: { escape?: boolean },
): void {
  const escape = opts?.escape ?? true;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (isInside(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!escape || event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, isInside, escape]);
}

/**
 * Body portal for UI that must sit above native stream underlays.
 * Always mount here — never nest these panels inside
 * `data-native-surface-boundary` or a transformed video ancestor.
 *
 * Marks the host with `data-stream-overlay-portal` + `data-native-overlay-occlude`
 * so underlay CSS forces opaque paint (menus stay readable over live video).
 * Opening a menu must not blank the GL tile — underlay uses `occlusion: false`.
 */
export function StreamOverlayPortal({
  children,
  className,
  style,
  panelRef,
  role,
  'aria-label': ariaLabel,
  'aria-modal': ariaModal,
  tabIndex,
  onMouseEnter,
  onMouseLeave,
  onPointerDown,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  panelRef?: RefObject<HTMLDivElement | null>;
  role?: string;
  'aria-label'?: string;
  'aria-modal'?: boolean | 'true' | 'false';
  tabIndex?: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      aria-modal={ariaModal}
      tabIndex={tabIndex}
      className={cn('fixed', STREAM_OVERLAY_Z_CLASS, className)}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onPointerDown={onPointerDown}
      onClick={onClick}
      data-stream-overlay-portal=""
      data-native-overlay-occlude=""
    >
      {children}
    </div>,
    document.body,
  );
}
