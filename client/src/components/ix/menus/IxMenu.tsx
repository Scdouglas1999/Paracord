import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';
import { IxGlyph } from '../glyphs';
import { MENU_EXIT_MS, useExitPresence } from '../sheets/useExitPresence';
import { ACTION_SHEET_EXIT_MS } from '../shell/phone/actionSheet';
import { useIsPhone } from '../shell/phone/phoneLayout';
import { isElementAnchor, type MenuAnchor } from './anchor';

/**
 * The Index popover menu (docs/index-spec.md §6.2-6.5; §5.17: `scale(.97)` + fade
 * from the anchor, 80ms ease in, 55ms out). Near-solid `--ix-pop`, radius 14,
 * rows 36 (14/500, glyph 16 ink-3), hairline separators; opaque under Reduced
 * transparency.
 *
 * Two pieces:
 *
 *   `IxMenuSurface`  the positioned, dismissable, keyboard-driven surface. It
 *                    knows nothing about what is in it beyond `role="menuitem*"`
 *                    elements, so the account menu can put a text field between
 *                    its rows.
 *   `IxMenuItems`    renders a model (`IxMenuEntry[]`): rows, separators, labels
 *                    and a group that expands in place (the "Notifications"
 *                    row of the server menu).
 *
 * Keyboard: ArrowUp/Down, Home/End move through the rows, typing a letter jumps to
 * the next row that starts with it, Enter/Space choose, Right opens a group and
 * Left closes it, Escape closes (and only this layer: it stops the event), Tab
 * closes. Focus lands on the first row (or the checked one) when it opens and
 * returns to what had it when it closes, unless a choice put it somewhere else.
 *
 * On a phone (docs/index-spec.md §9; IX-16) the same menu is a bottom action
 * sheet: the full width less 8 on each side, above the safe area, radius 20,
 * rows 52, over a scrim, with Cancel under the rows. It rises from the bottom
 * and drops back (ix-phone.css); the anchor only says what opened it.
 */

export type MenuCloseReason = 'escape' | 'outside' | 'select' | 'tab' | 'blur';

/* ---- The model --------------------------------------------------------------------- */

export interface IxMenuItemEntry {
  type: 'item';
  id: string;
  label: string;
  /** A 16px glyph (lucide at stroke 1.7, or an `IxGlyph`). */
  icon?: ReactNode;
  /** A second line under the label (12.5, ink-3): why a row is disabled. */
  description?: string;
  /** Trailing text: a shortcut ("Ctrl ,"). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** One of a set of choices, and whether this is the one in force: a radio row with a check. */
  checked?: boolean;
  /** Keep the menu open after the choice (a toggle the person may press again). */
  keepOpen?: boolean;
  onSelect: () => void;
  testId?: string;
}

export interface IxMenuGroupEntry {
  type: 'group';
  id: string;
  label: string;
  icon?: ReactNode;
  /** The value in force, shown at the row's right ("All messages"). */
  value?: string;
  items: IxMenuItemEntry[];
  defaultOpen?: boolean;
  testId?: string;
}

export interface IxMenuSeparatorEntry {
  type: 'separator';
  id: string;
}

export interface IxMenuLabelEntry {
  type: 'label';
  id: string;
  label: string;
}

export type IxMenuEntry = IxMenuItemEntry | IxMenuGroupEntry | IxMenuSeparatorEntry | IxMenuLabelEntry;

/* ---- The surface -------------------------------------------------------------------- */

const EDGE = 8;
const ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

function enabledItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (element) => !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true',
  );
}

export interface IxMenuSurfaceProps {
  open: boolean;
  onClose: (reason: MenuCloseReason) => void;
  anchor: MenuAnchor | null;
  /** The menu's accessible name. */
  label: string;
  /** Width in px. Default 240 (the server menu). */
  width?: number;
  className?: string;
  /** Selector for the row that takes focus when the menu opens (default: the checked row, else the first). */
  initialFocus?: string;
  /** Give focus back to what had it when the menu opened. Default true. */
  restoreFocus?: boolean;
  /** Where focus goes when nothing had it at open (Safari does not focus a button on click). */
  restoreTo?: () => HTMLElement | null;
  children: ReactNode;
  testId?: string;
}

interface Placement {
  left: number;
  top: number;
  origin: string;
}

const SHEET_PLACEMENT: Placement = { left: 0, top: 0, origin: '50% 100%' };

export function IxMenuSurface({
  open,
  onClose,
  anchor,
  label,
  width = 240,
  className,
  initialFocus,
  restoreFocus = true,
  restoreTo,
  children,
  testId,
}: IxMenuSurfaceProps) {
  const phone = useIsPhone();
  const { mounted, exiting } = useExitPresence(open, phone ? ACTION_SHEET_EXIT_MS : MENU_EXIT_MS);
  const ref = useRef<HTMLDivElement>(null);
  const phoneRef = useRef(phone);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // The anchor and onClose are read through refs so the document listeners below
  // are installed once per open, not once per render.
  const anchorRef = useRef(anchor);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    anchorRef.current = anchor;
    onCloseRef.current = onClose;
    phoneRef.current = phone;
  });

  // Remember what had focus when the menu opened; hand it back after the leave.
  useEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpen.current && restoreFocus) {
      const target = opener.current ?? restoreTo?.() ?? null;
      const frame = requestAnimationFrame(() => {
        const current = document.activeElement;
        // Something real already has focus (a dialog a choice opened, a field the
        // person clicked): leave it. Lost, or inside what is leaving: give it back.
        const lost =
          !(current instanceof HTMLElement) ||
          current === document.body ||
          current.closest('.ix-menu, [inert]') !== null;
        if (lost && target && document.contains(target)) target.focus({ preventScroll: true });
      });
      wasOpen.current = open;
      return () => cancelAnimationFrame(frame);
    }
    wasOpen.current = open;
    return undefined;
    // `restoreTo` is read when the menu closes; a new function each render must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, restoreFocus]);

  const place = useCallback(() => {
    const menu = ref.current;
    const at = anchorRef.current;
    if (!menu || !at) return;
    // An action sheet sits at the foot of the screen (CSS); the anchor does not place it.
    if (phoneRef.current) {
      menu.style.maxHeight = '';
      setPlacement((previous) => previous ?? SHEET_PLACEMENT);
      return;
    }
    const viewport = window.visualViewport;
    const left0 = viewport?.offsetLeft ?? 0;
    const top0 = viewport?.offsetTop ?? 0;
    const vw = viewport?.width ?? window.innerWidth;
    const vh = viewport?.height ?? window.innerHeight;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let left: number;
    let top: number;
    let origin: string;
    if (isElementAnchor(at)) {
      const rect = at.element.getBoundingClientRect();
      const gap = at.gap ?? 6;
      left = at.align === 'start' ? rect.left : rect.right - w;
      top = rect.bottom + gap;
      origin = at.align === 'start' ? '0% 0%' : '100% 0%';
      // No room below and more above: open upward, from the bottom edge.
      if (top + h > top0 + vh - EDGE && rect.top - gap - h >= top0 + EDGE) {
        top = rect.top - gap - h;
        origin = at.align === 'start' ? '0% 100%' : '100% 100%';
      }
    } else {
      left = at.x;
      top = at.y;
      origin = '0% 0%';
    }
    const x = Math.max(left0 + EDGE, Math.min(left, left0 + vw - w - EDGE));
    const y = Math.max(top0 + EDGE, Math.min(top, top0 + vh - h - EDGE));
    if (!isElementAnchor(at)) origin = `${Math.max(0, at.x - x)}px ${Math.max(0, at.y - y)}px`;
    menu.style.maxHeight = `${Math.max(0, vh - 2 * EDGE)}px`;
    setPlacement((previous) =>
      previous && previous.left === x && previous.top === y && previous.origin === origin
        ? previous
        : { left: x, top: y, origin },
    );
  }, []);

  // Measured before paint, and again when the menu's own size changes (a group
  // expanding) or the window does.
  useLayoutEffect(() => {
    if (!mounted) return undefined;
    place();
    const menu = ref.current;
    const observer = typeof ResizeObserver === 'function' && menu ? new ResizeObserver(place) : null;
    if (observer && menu) observer.observe(menu);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [mounted, anchor, place]);

  // Focus the first row (or the one in force) once the menu is placed.
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      const menu = ref.current;
      if (!menu) return;
      // The person already went somewhere in it (clicked a field): leave their focus alone.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== menu && menu.contains(active)) return;
      const target =
        (initialFocus ? menu.querySelector<HTMLElement>(initialFocus) : null) ??
        menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
        enabledItems(menu)[0] ??
        menu;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialFocus]);

  // Dismissal and the keyboard.
  useEffect(() => {
    if (!open) return undefined;
    const typed = { text: '', at: 0 };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      const at = anchorRef.current;
      // The control that opened the menu toggles it itself.
      if (at && isElementAnchor(at) && at.element.contains(target)) return;
      onCloseRef.current('outside');
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const menu = ref.current;
      if (!menu) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current('escape');
        return;
      }
      if (event.key === 'Tab') {
        onCloseRef.current('tab');
        return;
      }
      const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      const items = enabledItems(menu);
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const move = (index: number) => {
        event.preventDefault();
        event.stopPropagation();
        items[(index + items.length) % items.length]?.focus({ preventScroll: false });
      };
      switch (event.key) {
        case 'ArrowDown':
          if (inField && !menu.contains(event.target as Node)) return;
          move(at + 1);
          return;
        case 'ArrowUp':
          if (inField && !menu.contains(event.target as Node)) return;
          move(at === -1 ? -1 : at - 1);
          return;
        case 'Home':
          if (inField) return;
          move(0);
          return;
        case 'End':
          if (inField) return;
          move(items.length - 1);
          return;
        default:
          break;
      }
      // Type a letter to jump to the next row that starts with it.
      if (!inField && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now();
        typed.text = now - typed.at > 700 ? event.key.toLowerCase() : typed.text + event.key.toLowerCase();
        typed.at = now;
        const start = typed.text.length > 1 ? Math.max(at, 0) : at + 1;
        for (let step = 0; step < items.length; step += 1) {
          const candidate = items[(start + step) % items.length];
          const text = (candidate.textContent ?? '').trim().toLowerCase();
          if (text.startsWith(typed.text)) {
            event.preventDefault();
            candidate.focus();
            return;
          }
        }
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  if (!mounted || typeof document === 'undefined') return null;

  if (phone) {
    return createPortal(
      <>
        <div className={cn('ix-action-scrim', exiting ? 'is-leaving' : 'is-entering')} aria-hidden="true" />
        <div
          ref={ref}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          data-testid={testId}
          data-presentation="sheet"
          data-native-overlay-occlude=""
          className={cn('ix-menu', 'ix-menu--sheet', exiting ? 'is-leaving' : 'is-entering', className)}
          {...(exiting ? { 'aria-hidden': true as const, inert: true as const } : null)}
        >
          <div className="ix-menu__sheet-rows">{children}</div>
          <button type="button" role="menuitem" className="ix-menu__cancel" data-testid="ix-menu-cancel" onClick={() => onCloseRef.current('escape')}>
            Cancel
          </button>
        </div>
      </>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      data-native-overlay-occlude=""
      className={cn('ix-menu', exiting ? 'is-leaving' : 'is-entering', className)}
      style={
        {
          width,
          left: placement?.left ?? 0,
          top: placement?.top ?? 0,
          visibility: placement ? 'visible' : 'hidden',
          '--ix-menu-origin': placement?.origin ?? '0% 0%',
        } as CSSProperties
      }
      {...(exiting ? { 'aria-hidden': true as const, inert: true as const } : null)}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ---- The rows ------------------------------------------------------------------------ */

interface RowProps {
  entry: IxMenuItemEntry;
  onChoose: () => void;
  nested?: boolean;
}

function ItemRow({ entry, onChoose, nested }: RowProps) {
  const radio = entry.checked !== undefined;
  return (
    <button
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? entry.checked : undefined}
      disabled={entry.disabled}
      data-testid={entry.testId}
      data-danger={entry.danger ? '' : undefined}
      className={cn('ix-menu__item', nested && 'ix-menu__item--nested')}
      onClick={onChoose}
    >
      <span className="ix-menu__glyph" aria-hidden>
        {entry.icon}
      </span>
      <span className="ix-menu__text">
        <span className="ix-menu__label">{entry.label}</span>
        {entry.description && <span className="ix-menu__desc">{entry.description}</span>}
      </span>
      {entry.hint && <span className="ix-menu__hint ix-menu__hint--key">{entry.hint}</span>}
      {entry.checked && (
        <span className="ix-menu__check" aria-hidden>
          <IxGlyph name="check" size={15} />
        </span>
      )}
    </button>
  );
}

function GroupRow({ entry, onChoose }: { entry: IxMenuGroupEntry; onChoose: (item: IxMenuItemEntry) => void }) {
  const [open, setOpen] = useState(Boolean(entry.defaultOpen));
  const id = useId();
  return (
    <div className="ix-menu__group">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        data-testid={entry.testId}
        className="ix-menu__item"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
          if (event.key === 'ArrowRight' && !open) {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === 'ArrowLeft' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span className="ix-menu__glyph" aria-hidden>
          {entry.icon}
        </span>
        <span className="ix-menu__text">
          <span className="ix-menu__label">{entry.label}</span>
        </span>
        {entry.value && <span className="ix-menu__hint">{entry.value}</span>}
        <span className="ix-menu__caret" data-open={open ? '' : undefined} aria-hidden>
          <IxGlyph name="chevron" size={14} />
        </span>
      </button>
      {open && (
        <div id={id} role="group" aria-label={entry.label} className="ix-menu__sub">
          {entry.items.map((item) => (
            <ItemRow key={item.id} entry={item} nested onChoose={() => onChoose(item)} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface IxMenuItemsProps {
  entries: IxMenuEntry[];
  onClose: (reason: MenuCloseReason) => void;
}

/** Renders a menu model. A choice runs its action and closes the menu, unless the row asked to stay open. */
export function IxMenuItems({ entries, onClose }: IxMenuItemsProps) {
  const choose = (entry: IxMenuItemEntry) => {
    if (entry.disabled) return;
    entry.onSelect();
    if (!entry.keepOpen) onClose('select');
  };
  return (
    <>
      {entries.map((entry) => {
        switch (entry.type) {
          case 'separator':
            return <div key={entry.id} role="separator" className="ix-menu__sep" />;
          case 'label':
            return (
              <div key={entry.id} role="presentation" className="ix-menu__label-row">
                {entry.label}
              </div>
            );
          case 'group':
            return <GroupRow key={entry.id} entry={entry} onChoose={choose} />;
          case 'item':
            return <ItemRow key={entry.id} entry={entry} onChoose={() => choose(entry)} />;
        }
      })}
    </>
  );
}

/** A convenience for the common case: a surface that shows a model. */
export function IxMenu({
  entries,
  ...surface
}: Omit<IxMenuSurfaceProps, 'children'> & { entries: IxMenuEntry[] }) {
  return (
    <IxMenuSurface {...surface}>
      <IxMenuItems entries={entries} onClose={surface.onClose} />
    </IxMenuSurface>
  );
}
