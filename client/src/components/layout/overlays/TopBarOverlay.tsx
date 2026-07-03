import type { ReactNode, RefObject } from 'react';
import { Modal } from '../../ui/Modal';

interface TopBarOverlayProps {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  panelClassName: string;
  children: ReactNode;
}

/**
 * Shared top-anchored overlay shell for the TopBar surfaces (search, inbox,
 * pins, help). Consumers own their own focus trap via `dialogRef`, so this
 * routes through the base Modal with `manageFocus={false}`.
 */
export function TopBarOverlay({
  open,
  onClose,
  dialogRef,
  titleId,
  panelClassName,
  children,
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
      panelClassName={`rounded-xl border sm:rounded-2xl ${panelClassName}`}
    >
      {children}
    </Modal>
  );
}
