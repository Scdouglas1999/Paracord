import { useEffect, useLayoutEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { createPortal } from 'react-dom';
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
}

interface ContextMenuProps {
  label?: string;
  anchorRef?: RefObject<HTMLElement | null>;
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose, label = 'Context menu', anchorRef }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

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
      const anchor = anchorRef?.current?.getBoundingClientRect();
      const targetX = anchor ? anchor.right - menu.offsetWidth : position.x;
      const targetY = anchor ? anchor.bottom + 6 : position.y;
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
  }, [position.x, position.y, anchorRef]);

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
  }, [items, focusedIndex, onClose, anchorRef]);

  // Focus menu on mount for keyboard navigation
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[min(13rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-md border border-border-subtle bg-bg-floating p-1 shadow-lg outline-none"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      tabIndex={-1}
      role="menu"
      aria-label={label}
      data-native-overlay-occlude=""
      aria-activedescendant={focusedIndex >= 0 ? `context-menu-item-${focusedIndex}` : undefined}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={i} className="mx-1 my-1 h-px bg-border-subtle" />;
        }
        const active = focusedIndex === i;
        return (
          <button
            key={i}
            data-menu-index={i}
            id={`context-menu-item-${i}`}
            role="menuitem"
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 text-left text-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] [@media(pointer:coarse)]:min-h-11',
              item.danger ? 'text-accent-danger' : 'text-text-secondary',
              item.disabled && 'cursor-not-allowed text-text-muted',
              active &&
                !item.disabled &&
                (item.danger
                  ? 'bg-accent-danger text-text-on-danger'
                  : 'bg-accent-tint text-text-primary'),
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
              {item.icon && (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
              )}
              <span className="min-w-0"><span className="block truncate">{item.label}</span>{item.description && <span className="mt-0.5 block max-w-56 whitespace-normal text-meta text-text-muted">{item.description}</span>}</span>
            </span>
            {item.shortcut && (
              <span className="shrink-0 text-meta text-text-muted">{item.shortcut}</span>
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
