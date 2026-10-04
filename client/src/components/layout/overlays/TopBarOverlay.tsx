import { useEffect, type ReactNode, type RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SheetFrame } from '../../glass/sheets/SheetFrame';

interface TopBarOverlayProps {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  children: ReactNode;
  /** Standard header title (20/600). Omit when passing a custom `header`. */
  title?: string;
  /** Replaces the standard header's title block entirely. */
  header?: ReactNode;
  /** Accessible label for the built-in close button. */
  closeLabel?: string;
  /**
   * Kept so existing callers compile: the dialog's size and its body padding
   * belong to the sheet now (the pane's column), so these no longer apply.
   */
  panelClassName?: string;
  bodyClassName?: string;
  icon?: LucideIcon;
}

/**
 * What a few overlays still render in (the pinned messages dialog, the inbox): a
 * sheet in main's sheet host (docs/index-spec.md §6.1), the same page the search,
 * pins and threads sheets are, instead of a dialog floating over the page. Help
 * is a dialog now (`HelpOverlay`) and the inbox becomes People's page (IX-14).
 *
 * Consumers own their focus trap and Escape through `dialogRef` (their hooks
 * live beside their state), so the frame does not run one (`manageFocus`).
 */
export function TopBarOverlay({
  open,
  onClose,
  dialogRef,
  titleId,
  children,
  title,
  header,
  closeLabel = 'Close',
}: TopBarOverlayProps) {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const dispatch = () => {
      // The delayed closing repaint may outlive the page's window.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('paracord:native-underlay-repaint'));
      }
    };
    const raf = window.requestAnimationFrame(dispatch);
    dispatch();
    return () => {
      window.cancelAnimationFrame(raf);
      dispatch();
      window.setTimeout(dispatch, 280);
    };
  }, [open]);

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      kind="overlay"
      label={title ?? 'Details'}
      title={title}
      titleId={titleId}
      header={header}
      closeLabel={closeLabel}
      panelRef={dialogRef}
      manageFocus={false}
    >
      {children}
    </SheetFrame>
  );
}
