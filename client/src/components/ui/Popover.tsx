import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// §5.1/§5.3: the small-surface recipe (pc-pop-in / pc-pop-out) grown from the
// anchor's side; the presence hook keeps the surface mounted for its leave.
import { anchorOrigin, usePresence } from '../../lib/motion';
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
 * Popover: the floating-surface shell (docs/index-spec.md §6.2, §6.11), a
 * near-solid popover (`--ix-pop`) at radius 14 with a hairline and the room
 * card's shadow (the `pc-floating` recipe, which also goes fully opaque under
 * reduced transparency and High contrast). It owns placement, Escape,
 * outside-click and scroll dismissal; what goes inside is the caller's
 * business, and reads the Index inks (`ix-lt--pop`).
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
  // Stay mounted for the leave; the last coords carry the exit out where the
  // surface was.
  const { mounted, exiting, scenery } = usePresence(open);

  const reposition = useCallback(() => {
    const anchorEl = anchor.current;
    const surface = surfaceRef.current;
    if (!anchorEl || !surface) return;
    setCoords(position(anchorEl.getBoundingClientRect(), surface.getBoundingClientRect(), side, align));
  }, [anchor, side, align]);

  useLayoutEffect(() => {
    if (!open) return;
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

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={surfaceRef}
      role={role}
      aria-label={label}
      data-native-overlay-occlude
      className={cn(
        'pc-floating ix-lt--pop fixed z-[1100] min-w-[10rem] max-w-[calc(100vw-1rem)] p-1.5',
        exiting ? 'pc-pop-out' : 'pc-pop-in',
        className,
      )}
      style={
        {
          top: coords?.top ?? 0,
          left: coords?.left ?? 0,
          visibility: coords ? 'visible' : 'hidden',
          '--pc-origin': anchorOrigin(side, align),
        } as React.CSSProperties
      }
      {...scenery}
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
        'pc-focusable flex w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left',
        'h-9 text-[14px] font-medium',
        'transition-[background-color,color] duration-[55ms] ease-[var(--ix-ease)]',
        danger
          ? 'text-[var(--ix-danger-ink)] hover:bg-[var(--ix-danger-fill)]'
          : 'text-[var(--ix-ink)] hover:bg-[var(--ix-fill)] active:bg-[var(--ix-fill-2)]',
        'disabled:pointer-events-none disabled:opacity-[.45]',
        className,
      )}
      {...props}
    >
      {icon != null && (
        <span
          className={cn('flex h-4 w-4 shrink-0 items-center justify-center', !danger && 'text-[var(--ix-ink-3)]')}
          aria-hidden
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing != null && (
        <span className="ml-auto shrink-0 text-[12px] font-medium tabular-nums text-[var(--ix-ink-3)]">{trailing}</span>
      )}
    </button>
  );
});

/** A quiet group heading inside a menu: sentence case, 12.5/600, tertiary ink. */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2.5 text-[12.5px] font-semibold text-[var(--ix-ink-3)]">{children}</div>;
}
