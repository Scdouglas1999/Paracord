import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router';
import { ChevronLeft, X } from 'lucide-react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { usePresence } from '../../../lib/motion';
import { cn } from '../../../lib/utils';
import { useMobile } from '../../../hooks/useMobile';
import { Tooltip } from '../../ui/Tooltip';
import { CallPill, useRegisterSheetCover } from '../pill';

/**
 * A sheet: a solid pane that slides over the conversation (docs/glass-spec.md
 * §1 "content is solid", §3; WP-G18). It is not a third pane. It covers the
 * conversation pane exactly (the pane's rect, radius and column), so the
 * header's title, search and face give way to the sheet's own header, and what
 * was underneath is inert until the sheet is dismissed.
 *
 *   header   76px, like the conversation's: the title (20/600) and a line
 *            under it (13, ink-2) start on the column's left edge; the close
 *            button sits at the pane's right edge, where the search button was.
 *            A page pushed on another gets a back button before the title.
 *   body     the column: a scroller for lists, or (`body="fill"`) a flex column
 *            for a conversation that owns its own scroller and message box.
 *
 * Where it renders:
 *   wide, compact  a portal into the conversation pane (`main#main-content`),
 *                  absolutely filling it, so the geometry follows the pane in
 *                  every layout (side by side is 420px, theater 380px).
 *   phone          a portal to the window, full screen, over the bottom bar.
 *
 * The call pill: a sheet covers the conversation's header, and the call's
 * controls have to stay reachable, so the sheet draws the pill itself
 * (`placement="sheet"`) where the header's was: in its own header, between the
 * title and the buttons, and on a phone in a row above it (the conversation's
 * place for it). The covered pill goes inert until the sheet does
 * (`pill/sheetCover.ts`). The pill sits after the close button in the document, so
 * focus still lands on the sheet's own first control; it is drawn before it.
 *
 * Keyboard: Escape closes, focus moves into the sheet and comes back to what
 * opened it, and Tab stays inside (the shared `useFocusTrap`). A sheet that
 * already runs its own trap passes `manageFocus={false}`. Escape on an expanded
 * pill only puts its roster away.
 *
 * Motion: the sheet slides in 28px and fades (transform and opacity only);
 * reduced motion lands it in place.
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

function paneHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('main-content');
}

/**
 * The call pill a sheet draws: the same one the conversation's header does, for
 * the same conversation (the route's server and channel; a DM has neither a
 * server nor a channel to ask for, as `ConversationPane` passes it).
 */
function SheetPill({ phone, className }: { phone: boolean; className: string }) {
  const { guildId, channelId } = useParams();
  return (
    <div className={className}>
      <CallPill
        guildId={guildId ?? null}
        channelId={guildId ? (channelId ?? null) : null}
        layout={phone ? 'stacked' : 'row'}
        placement="sheet"
      />
    </div>
  );
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
  // The phone frame's own boundary (`useGlassLayout` asks the same question).
  const phone = useMobile();
  const { mounted, exiting, scenery } = usePresence(open);
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = (panelRef ?? ownRef) as RefObject<HTMLDivElement | null>;

  useFocusTrap(ref, open && manageFocus, onClose);
  // Counted from the moment it is drawn to the end of its leave, so the pill
  // under it is never visible next to the sheet's own.
  useRegisterSheetCover(mounted);

  // The trap puts focus on the first control (the back or close button); a page
  // with a field (search) names it, and it wins.
  useEffect(() => {
    if (!open || !manageFocus) return;
    const preferred = ref.current?.querySelector<HTMLElement>('[data-sheet-autofocus]');
    preferred?.focus({ preventScroll: true });
  }, [open, manageFocus, ref]);

  if (!mounted || typeof document === 'undefined') return null;

  // On a phone the sheet is the whole screen; elsewhere it is the pane's. With
  // no pane to fill (a test, a page rendered alone) it falls back to the window.
  const pane = phone ? null : paneHost();
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
      className={cn('glass-sheet', exiting ? 'is-leaving' : 'is-entering', className)}
      {...scenery}
    >
      <div className="glass-sheet__header">
        {onBack && (
          <div className="glass-sheet__back-slot">
            <Tooltip content={backLabel} side="bottom">
              <button
                type="button"
                className="glass-sheet__btn glass-focusable"
                aria-label={backLabel}
                onClick={onBack}
              >
                <ChevronLeft size={20} aria-hidden />
              </button>
            </Tooltip>
          </div>
        )}
        {header ?? (
          <div className="glass-sheet__heading">
            {title != null && (
              <h2 id={titleId} className="glass-sheet__title">
                {title}
              </h2>
            )}
            {subtitle != null && subtitle !== '' && <p className="glass-sheet__sub">{subtitle}</p>}
          </div>
        )}
        {actions && <div className="glass-sheet__actions">{actions}</div>}
        <div className="glass-sheet__close-slot">
          <Tooltip content={closeLabel} side="bottom">
            <button
              type="button"
              className="glass-sheet__btn glass-focusable"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X size={18} aria-hidden />
            </button>
          </Tooltip>
        </div>
        {!phone && <SheetPill phone={false} className="glass-sheet__pill" />}
      </div>
      {phone && <SheetPill phone className="glass-sheet__phone-pill" />}
      <div ref={bodyRef} className={cn('glass-sheet__body', bodyClassName)} data-body={body}>
        {children}
      </div>
    </div>,
    host,
  );
}
