import { useEffect, useLayoutEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
// §5.1/§5.3: the small-surface recipe (pc-pop-in / pc-pop-out), grown from the
// point that opened it; the presence hook keeps the menu mounted for its leave.
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';

export interface ContextMenuItem {
  label: string;
  description?: string;
  icon?: React.ReactNode;
  action: () => void;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
  shortcut?: string;
  /**
   * One of a set of choices, and whether this is the one in force. Set it and
   * the row becomes a radio for a screen reader and draws a check — so a menu
   * that changes a setting says what the setting currently is (§9).
   */
  selected?: boolean;
}

interface ContextMenuProps {
  label?: string;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorAlign?: 'start' | 'end';
  items: ContextMenuItem[];
  /**
   * Menu visibility (default true). Drive it rather than unmounting so the
   * shared exit can keep the node mounted for one beat.
   */
  open?: boolean;
  /** Where the menu opens. May go undefined while `open` is false — the last
   *  position is kept so the leave plays where the menu was. */
  position?: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, open = true, onClose, label = 'Context menu', anchorRef, anchorAlign = 'end' }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const { mounted, exiting, scenery } = usePresence(open);
  /** True when at least one row draws an icon, so every row reserves its column. */
  const anyIcon = items.some((item) => !item.divider && item.icon);
  // The caller drops `position` when it closes the menu, and the menu is still
  // on screen for the beat its leave takes — so the last one it was opened at
  // is kept, and the exit plays where the menu actually is. Adjusted during
  // render rather than in an effect: a menu that placed itself one commit late
  // would be drawn at the previous spot for a frame.
  const [anchor, setAnchor] = useState(position ?? { x: 0, y: 0 });
  if (position && (position.x !== anchor.x || position.y !== anchor.y)) {
    setAnchor(position);
  }
  const [adjustedPosition, setAdjustedPosition] = useState(anchor);

  // Measure before paint and after content/viewport changes. Explanations can
  // wrap after a width change; a one-time measurement leaves the menu clipped.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const place = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
      menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
      const anchorRect = anchorRef?.current?.getBoundingClientRect();
      const targetX = anchorRect ? (anchorAlign === 'start' ? anchorRect.left : anchorRect.right - menu.offsetWidth) : anchor.x;
      const targetY = anchorRect ? anchorRect.bottom + 6 : anchor.y;
      const x = Math.max(left + 8, Math.min(targetX, left + width - menu.offsetWidth - 8));
      const y = Math.max(top + 8, Math.min(targetY, top + height - menu.offsetHeight - 8));
      setAdjustedPosition(previous => previous.x === x && previous.y === y ? previous : { x, y });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener('resize', place);
    if (anchorRef) document.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  // `mounted` is a dependency because the menu node only exists while mounted:
  // a menu reopened at the same anchor is a new node that has to be measured
  // again, or it keeps the position of the last time it opened.
  }, [anchor.x, anchor.y, anchorRef, anchorAlign, mounted]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const item = menu?.querySelector<HTMLElement>(`[data-menu-index="${focusedIndex}"]`);
    if (!menu || !item) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }, [focusedIndex]);

  // Close on click outside, scroll, or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = (event: Event) => {
      // An anchored menu follows its trigger. Unrelated timeline scrolling must
      // not dismiss header controls while history or live messages settle.
      if (anchorRef) return;
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'Tab') { onClose(); return; }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const enabled = items.map((item, index) => !item.disabled && !item.divider ? index : -1).filter(index => index >= 0);
        setFocusedIndex((e.key === 'Home' ? enabled[0] : enabled.at(-1)) ?? -1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((prev) => {
          let next = prev + 1;
          while (next < items.length && (items[next].divider || items[next].disabled)) {
            next++;
          }
          return next >= items.length ? prev : next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((prev) => {
          let next = prev - 1;
          while (next >= 0 && (items[next].divider || items[next].disabled)) {
            next--;
          }
          return next < 0 ? prev : next;
        });
      } else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0) {
        e.preventDefault();
        const item = items[focusedIndex];
        if (item && !item.disabled && !item.divider) {
          item.action();
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [items, focusedIndex, onClose, anchorRef, open]);

  // Focus menu when it opens for keyboard navigation
  useEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        'pc-floating ix-lt--pop fixed z-[100] min-w-[min(13rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto p-1.5 outline-none',
        exiting ? 'pc-pop-out' : 'pc-pop-in',
      )}
      style={
        {
          left: adjustedPosition.x,
          top: adjustedPosition.y,
          // Grow out of the point that opened it: under a button, from the
          // corner that sits beneath it; at the pointer, from the pointer.
          '--pc-origin': anchorRef
            ? (anchorAlign === 'start' ? '0% 0%' : '100% 0%')
            : `${Math.max(0, anchor.x - adjustedPosition.x)}px ${Math.max(0, anchor.y - adjustedPosition.y)}px`,
        } as React.CSSProperties
      }
      tabIndex={-1}
      role="menu"
      aria-label={label}
      data-native-overlay-occlude=""
      aria-activedescendant={focusedIndex >= 0 ? `context-menu-item-${focusedIndex}` : undefined}
      {...scenery}
    >
      {/*
        One menu, one label column. A row without an icon used to close the gap
        its neighbors reserve, so "Follow the building" — the fourth choice of
        a four-way radio group — started 26px left of the three above it. When
        any row in a menu carries an icon, every row reserves the column; a
        menu with no icons at all still sits flush.
      */}
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={i} className="mx-2 my-1 h-px bg-[var(--ix-line)]" />;
        }
        const active = focusedIndex === i;
        return (
          <button
            key={i}
            data-menu-index={i}
            id={`context-menu-item-${i}`}
            role={item.selected === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.selected === undefined ? undefined : item.selected}
            className={cn(
              'flex min-h-9 w-full items-center justify-between gap-3 rounded-[10px] px-2.5 py-1.5 text-left text-[14px] font-medium outline-none transition-colors duration-[120ms] ease-[var(--ix-ease)] [@media(pointer:coarse)]:min-h-11',
              // A destructive item takes the one danger INK on its fill, never a
              // red surface (§1.4). Hover is one step lighter, press one darker.
              item.danger ? 'text-[var(--ix-danger-ink)]' : 'text-[var(--ix-ink)]',
              item.disabled && 'cursor-not-allowed text-[var(--ix-ink-3)]',
              !item.disabled && 'active:bg-[var(--ix-fill-2)]',
              active &&
                !item.disabled &&
                (item.danger ? 'bg-[var(--ix-danger-fill)]' : 'bg-[var(--ix-fill)]'),
            )}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.action();
              onClose();
            }}
            onMouseEnter={() => setFocusedIndex(i)}
            onMouseLeave={() => setFocusedIndex(-1)}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              {(item.icon || anyIcon) && (
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center',
                    !item.danger && 'text-[var(--ix-ink-3)]',
                  )}
                >
                  {item.icon}
                </span>
              )}
              <span className="min-w-0"><span className="block truncate">{item.label}</span>{item.description && <span className="mt-0.5 block max-w-56 whitespace-normal text-[12.5px] font-normal text-[var(--ix-ink-3)]">{item.description}</span>}</span>
            </span>
            {item.selected && <Check size={14} aria-hidden className="shrink-0 text-[var(--ix-ink)]" />}
            {item.shortcut && (
              <span className="shrink-0 text-[12px] font-medium tabular-nums text-[var(--ix-ink-3)]">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body
  );
}

interface ContextMenuState {
  isOpen: boolean;
  position: { x: number; y: number };
  items: ContextMenuItem[];
}

export function useContextMenu() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    position: { x: 0, y: 0 },
    items: [],
  });

  const onContextMenu = useCallback(
    (e: React.MouseEvent, items: ContextMenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        isOpen: true,
        position: { x: e.clientX, y: e.clientY },
        items,
      });
    },
    []
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  return { contextMenu, onContextMenu, closeContextMenu };
}
