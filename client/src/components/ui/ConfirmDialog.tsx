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
      labelledBy="confirm-dialog-title"
      describedBy={options?.description ? 'confirm-dialog-desc' : undefined}
    >
      {options && (
        <>
          <ModalHeader
            icon={
              options.variant === 'danger' ? (
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-danger-tint text-accent-danger">
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
            <Button variant="secondary" onClick={() => close(false)}>
              {options.cancelLabel || 'Cancel'}
            </Button>
            <Button
              variant={options.variant === 'danger' ? 'destructive' : 'default'}
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
