import type { ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { cn } from '../../../lib/utils';

interface TopBarOverlayProps {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  panelClassName: string;
  children: ReactNode;
  /** Standard header title (Subhead step). Omit when passing a custom `header`. */
  title?: string;
  /** Optional leading lucide icon for the standard header. */
  icon?: LucideIcon;
  /** Replaces the standard header entirely (e.g. the search input row). */
  header?: ReactNode;
  /** Accessible label for the built-in close button. */
  closeLabel?: string;
  /** Extra classes for the scroll body wrapper. */
  bodyClassName?: string;
}

const CLOSE_BUTTON =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-text-muted ' +
  'outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] ' +
  'hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]';

/**
 * Shared top-anchored floating shell for the TopBar surfaces (search, inbox,
 * pins, help, summary, follows). It renders the design-spec popover recipe
 * (bg --bg-floating, radius-md, --shadow-lg) over the base Modal — one family
 * of chrome for every launcher. Consumers own their own focus trap via
 * `dialogRef`, so this routes through Modal with `manageFocus={false}`.
 */
export function TopBarOverlay({
  open,
  onClose,
  dialogRef,
  titleId,
  panelClassName,
  children,
  title,
  icon: Icon,
  header,
  closeLabel = 'Close',
  bodyClassName,
}: TopBarOverlayProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      panelRef={dialogRef}
      manageFocus={false}
      labelledBy={titleId}
      placement="top"
      zIndexClassName="z-50"
      backdropClassName="px-2 pb-[calc(var(--safe-bottom)+0.75rem)] pt-[calc(var(--safe-top)+3.75rem)] sm:px-4 sm:pt-20"
      panelClassName={cn(
        'flex flex-col rounded-md border-border-subtle bg-bg-floating shadow-lg',
        panelClassName,
      )}
    >
      {header ?? (
        <header className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-5 py-3.5">
          {Icon && <Icon size={18} className="shrink-0 text-text-secondary" />}
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-subhead text-text-primary">
            {title}
          </h2>
          <button type="button" className={CLOSE_BUTTON} onClick={onClose} aria-label={closeLabel}>
            <X size={18} />
          </button>
        </header>
      )}
      <div className={cn('min-h-0 flex-1 overflow-y-auto scrollbar-thin', bodyClassName)}>
        {children}
      </div>
    </Modal>
  );
}
