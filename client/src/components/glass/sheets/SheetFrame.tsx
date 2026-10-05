import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { cn } from '../../../lib/utils';
import { IxGlyph } from '../../ix/glyphs';
import { SHEET_EXIT_MS, useExitPresence } from '../../ix/sheets/useExitPresence';
import { IX_SHEET_HOST_ID } from '../../ix/shell/slots';
import { PHONE_SLIDE_MS } from '../shell/phoneMotion';
import { useIsPhone } from '../../ix/shell/phone/phoneLayout';
import { pushSheet } from '../../ix/shell/phone/pushedSheets';

/**
 * A sheet: the Index page that opens inside main on its right (docs/index-spec.md
 * §6.1; WP IX-9). Inset 10, width 400 (480 for search), radius 24, near-solid
 * `--ix-pop` with a hairline edge, opaque under Reduced transparency. The
 * geometry is the frame's (`#ix-sheet-host`, components/ix/shell); this fills it.
 *
 *   header   58px: the title (17/700) and, under it, a line (12.5, ink-3); a back
 *            button before the title for a page pushed on another; the close
 *            button at the right edge (34x34, like the toolbar's tools).
 *   body     a scroller for lists, or (`body="fill"`) a flex column for a
 *            conversation that owns its own scroller and message box.
 *
 * The conversation stays usable to the left (there is no scrim). Escape closes,
 * focus goes into the sheet and comes back to what opened it, and Tab stays
 * inside (the shared `useFocusTrap`), so the sheet is a modal dialog for a
 * keyboard and a screen reader; one sheet is open at a time (`sheetStore`).
 *
 * Where it renders: a portal into `#ix-sheet-host` (inside main). On a phone it
 * is the whole screen (a portal to the window); with no host on the page (a
 * test, a page rendered alone) it falls back to the window too. There is no call
 * pill: the Index call lives in the sidebar's card (index-spec §4.3).
 *
 * Motion (§5.17): in from `translateX(24px)` + fade, 115ms spring; out 75ms
 * ease. Transform and opacity only; reduced motion is a 65ms fade.
 *
 * On a phone (index-spec §9; IX-16) a sheet is a pushed page: it slides in from
 * the right over the whole screen, 110ms on the spring, while the screen it
 * covers moves 30% left beneath it (`pushSheet`); its header leads with a back
 * chevron (which closes it) instead of the close button, and the edge swipe
 * drags it away.
 */

export interface SheetFrameProps {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  /** `data-sheet`: which sheet this is. Styles and tests key on it. */
  kind: string;
  title?: ReactNode;
  /** The id of the title element, for a consumer that names its dialog by it. */
  titleId?: string;
  subtitle?: ReactNode;
  /** Replaces the title block entirely (the search field). */
  header?: ReactNode;
  /** A page pushed over another: shows a back button that pops it. */
  onBack?: () => void;
  backLabel?: string;
  /** Extra header actions, before the close button. */
  actions?: ReactNode;
  closeLabel?: string;
  /** External ref to the dialog, for a consumer that runs its own focus trap. */
  panelRef?: RefObject<HTMLElement | null>;
  /** False when the consumer already traps focus on `panelRef`. Default true. */
  manageFocus?: boolean;
  /** `scroll`: the body scrolls (lists). `fill`: a flex column the page fills. */
  body?: 'scroll' | 'fill';
  /** The body element, for a page that pages its results off the scroller. */
  bodyRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

function sheetHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(IX_SHEET_HOST_ID);
}

export function SheetFrame({
  open,
  onClose,
  label,
  kind,
  title,
  titleId,
  subtitle,
  header,
  onBack,
  backLabel = 'Back',
  actions,
  closeLabel = 'Close',
  panelRef,
  manageFocus = true,
  body = 'scroll',
  bodyRef,
  className,
  bodyClassName,
  children,
}: SheetFrameProps) {
  // The phone frame's own boundary (`useIxLayout` asks the same question).
  const phone = useIsPhone();
  const { mounted, exiting } = useExitPresence(open, phone ? PHONE_SLIDE_MS : SHEET_EXIT_MS);

  // A pushed page covers the screen it was opened from, which steps back beneath it.
  useLayoutEffect(() => {
    if (!open || !phone) return undefined;
    return pushSheet();
  }, [open, phone]);
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = (panelRef ?? ownRef) as RefObject<HTMLDivElement | null>;

  useFocusTrap(ref, open && manageFocus, onClose);

  // The trap puts focus on the first control (the back or close button); a page
  // with a field (search) names it, and it wins.
  useEffect(() => {
    if (!open || !manageFocus) return;
    const preferred = ref.current?.querySelector<HTMLElement>('[data-sheet-autofocus]');
    preferred?.focus({ preventScroll: true });
  }, [open, manageFocus, ref]);

  if (!mounted || typeof document === 'undefined') return null;

  // On a phone the sheet is the whole screen; elsewhere it is the host's. With
  // no host to fill it falls back to the window.
  const pane = phone ? null : sheetHost();
  const host = pane ?? document.body;
  const inPane = pane !== null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-sheet={kind}
      data-host={inPane ? 'pane' : 'window'}
      data-native-overlay-occlude
      className={cn('ix-sheet', exiting ? 'is-leaving' : 'is-entering', className)}
      // A sheet that is leaving is scenery for the beat it takes: out of the
      // accessibility tree and the tab order.
      {...(exiting ? { 'aria-hidden': true as const, inert: true as const } : null)}
    >
      <div className="ix-sheet__header">
        {phone && !onBack && (
          <button
            type="button"
            className="ix-sheet__btn ix-sheet__back"
            aria-label={closeLabel === 'Close' ? 'Back' : closeLabel}
            title={closeLabel === 'Close' ? 'Back' : closeLabel}
            data-ix-sheet-dismiss=""
            onClick={onClose}
          >
            <IxGlyph name="chevron" size={18} />
          </button>
        )}
        {onBack && (
          <button
            type="button"
            className="ix-sheet__btn ix-sheet__back"
            aria-label={backLabel}
            title={backLabel}
            onClick={onBack}
          >
            <IxGlyph name="chevron" size={18} />
          </button>
        )}
        {header ?? (
          <div className="ix-sheet__heading">
            {title != null && (
              <h2 id={titleId} className="ix-sheet__title">
                {title}
              </h2>
            )}
            {subtitle != null && subtitle !== '' && <p className="ix-sheet__sub">{subtitle}</p>}
          </div>
        )}
        {actions && <div className="ix-sheet__actions">{actions}</div>}
        {/* On a phone the back chevron above closes it, and with a page pushed on
            the sheet the close stays: it takes the whole stack away. */}
        {(!phone || onBack) && (
          <button
            type="button"
            className="ix-sheet__btn ix-sheet__close"
            aria-label={closeLabel}
            title={closeLabel}
            data-ix-sheet-dismiss={phone ? '' : undefined}
            onClick={onClose}
          >
            <IxGlyph name="x" size={18} />
          </button>
        )}
      </div>
      <div
        ref={bodyRef}
        className={cn('ix-sheet__body', bodyClassName)}
        data-body={body}
      >
        {children}
      </div>
    </div>,
    host,
  );
}
