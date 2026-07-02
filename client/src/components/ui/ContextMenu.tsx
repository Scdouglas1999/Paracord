import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  action: () => void;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth - 8) {
      x = window.innerWidth - rect.width - 8;
    }
    if (y + rect.height > window.innerHeight - 8) {
      y = window.innerHeight - rect.height - 8;
    }
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setAdjustedPosition({ x, y });
  }, [position]);

  // Close on click outside, scroll, or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = () => onClose();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
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
  }, [items, focusedIndex, onClose]);

  // Focus menu on mount for keyboard navigation
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu fixed z-[100]"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      tabIndex={-1}
      role="menu"
      aria-label="Context menu"
      aria-activedescendant={focusedIndex >= 0 ? `context-menu-item-${focusedIndex}` : undefined}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={i} className="mx-2 my-1.5 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />;
        }
        return (
          <button
            key={i}
            id={`context-menu-item-${i}`}
            role="menuitem"
            className={`context-menu-item${item.danger ? ' danger' : ''}`}
            style={{
              opacity: item.disabled ? 0.5 : 1,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              backgroundColor: focusedIndex === i ? 'var(--accent-primary)' : undefined,
              color: focusedIndex === i ? '#fff' : undefined,
            }}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.action();
              onClose();
            }}
            onMouseEnter={() => setFocusedIndex(i)}
            onMouseLeave={() => setFocusedIndex(-1)}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                {item.icon && <span className="flex h-4 w-4 items-center justify-center">{item.icon}</span>}
                {item.label}
              </span>
              {item.shortcut && (
                <span className="text-xs opacity-60">{item.shortcut}</span>
              )}
            </span>
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
