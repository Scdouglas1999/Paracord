import { AlertTriangle } from 'lucide-react';
import { useConfirmStore } from '../../stores/confirmStore';
import { Button } from './Button';
import {
  Modal,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from './Modal';

export function ConfirmDialog() {
  const isOpen = useConfirmStore((s) => s.isOpen);
  const options = useConfirmStore((s) => s.options);
  const close = useConfirmStore((s) => s.close);

  const open = isOpen && !!options;

  return (
    <Modal
      open={open}
      onClose={() => close(false)}
      role="alertdialog"
      size="sm"
      // A confirm is always raised *on top of* whatever asked for it, and the
      // windowed User/Building settings overlays sit at z-[150]. At the Modal
      // default (z-[60]) the prompt rendered *underneath* the settings plate:
      // the screen dimmed, nothing appeared, and the destructive action (delete
      // a channel, transfer ownership) could not be confirmed or dismissed
      // without closing settings first. Toasts stay above at z-[9999].
      zIndexClassName="z-[160]"
      labeledBy="confirm-dialog-title"
      describedBy={options?.description ? 'confirm-dialog-desc' : undefined}
    >
      {options && (
        <>
          <ModalHeader
            icon={
              options.variant === 'danger' ? (
                <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-well)] bg-danger-well text-accent-danger shadow-[var(--shadow-well)]">
                  <AlertTriangle size={20} />
                </div>
              ) : undefined
            }
          >
            <ModalTitle id="confirm-dialog-title">{options.title}</ModalTitle>
            {options.description && (
              <ModalDescription id="confirm-dialog-desc">
                {options.description}
              </ModalDescription>
            )}
          </ModalHeader>
          <ModalFooter>
            <Button variant="ghost" onClick={() => close(false)}>
              {options.cancelLabel || 'Cancel'}
            </Button>
            <Button
              variant={options.variant === 'danger' ? 'danger' : 'primary'}
              onClick={() => close(true)}
              autoFocus
            >
              {options.confirmLabel || 'Confirm'}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
