import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export type PopoverSide = 'top' | 'right' | 'bottom' | 'left';
export type PopoverAlign = 'start' | 'center' | 'end';

const GAP = 6;
const EDGE = 8;

export interface PopoverProps {
  /** The element the surface is anchored to. */
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  /** Called on Escape, on a click outside, and on a scroll/resize that invalidates the anchor. */
  onClose: () => void;
  side?: PopoverSide;
  align?: PopoverAlign;
  /** Accessible name for the surface. */
  label?: string;
  /** `menu` wires the surface up as a menu for assistive tech. */
  role?: 'dialog' | 'menu' | 'listbox';
  className?: string;
  children: React.ReactNode;
}

function position(
  anchorRect: DOMRect,
  surface: DOMRect,
  side: PopoverSide,
  align: PopoverAlign,
): { top: number; left: number } {
  let top = 0;
  let left = 0;
  const alignMain = (start: number, size: number, own: number) =>
    align === 'start' ? start : align === 'end' ? start + size - own : start + size / 2 - own / 2;

  switch (side) {
    case 'top':
      top = anchorRect.top - surface.height - GAP;
      left = alignMain(anchorRect.left, anchorRect.width, surface.width);
      break;
    case 'bottom':
      top = anchorRect.bottom + GAP;
      left = alignMain(anchorRect.left, anchorRect.width, surface.width);
      break;
    case 'left':
      left = anchorRect.left - surface.width - GAP;
      top = alignMain(anchorRect.top, anchorRect.height, surface.height);
      break;
    case 'right':
      left = anchorRect.right + GAP;
      top = alignMain(anchorRect.top, anchorRect.height, surface.height);
      break;
  }

  // Keep the surface on screen.
  left = Math.max(EDGE, Math.min(left, window.innerWidth - surface.width - EDGE));
  top = Math.max(EDGE, Math.min(top, window.innerHeight - surface.height - EDGE));
  return { top, left };
}

/**
 * Popover — the floating-surface shell (spec §4): `--bg-floating` plus the plate
 * shadow, nothing else. It owns placement, Escape, outside-click and scroll
 * dismissal; what goes inside is the caller's business.
 *
 * No blur: WebKitGTK renders `backdrop-filter` on the CPU, and §9 requires the
 * surface to go fully opaque under reduced transparency anyway (the `pc-floating`
 * recipe handles that).
 */
export function Popover({
  anchor,
  open,
  onClose,
  side = 'bottom',
  align = 'start',
  label,
  role = 'dialog',
  className,
  children,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const anchorEl = anchor.current;
    const surface = surfaceRef.current;
    if (!anchorEl || !surface) return;
    setCoords(position(anchorEl.getBoundingClientRect(), surface.getBoundingClientRect(), side, align));
  }, [anchor, side, align]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    reposition();
  }, [open, reposition, children]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (surfaceRef.current?.contains(target)) return;
      if (anchor.current?.contains(target)) return;
      onClose();
    };
    const onScroll = () => reposition();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, onClose, reposition, anchor]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={surfaceRef}
      role={role}
      aria-label={label}
      data-native-overlay-occlude
      className={cn(
        'pc-floating pc-transition fixed z-[1100] min-w-[10rem] max-w-[calc(100vw-1rem)] p-1',
        className,
      )}
      style={{
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        visibility: coords ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  /** Trailing hint — a shortcut, a check. */
  trailing?: React.ReactNode;
  /** Destructive actions take the danger ink, not a red fill. */
  danger?: boolean;
}

/** A row inside a {@link Popover} with `role="menu"`. */
export const MenuItem = React.forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, trailing, danger = false, className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      role="menuitem"
      className={cn(
        'pc-focusable flex w-full items-center gap-2.5 rounded-[var(--radius-chip)] px-2.5 text-left',
        'h-[var(--h-list-row)] text-label',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        danger
          ? 'text-accent-danger hover:bg-danger-well'
          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
        'disabled:pointer-events-none disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {icon != null && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing != null && <span className="ml-auto shrink-0 text-meta text-text-faint">{trailing}</span>}
    </button>
  );
});

/** A quiet group heading inside a menu. Sentence case (spec §6.8). */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-section text-text-faint">{children}</div>;
}
