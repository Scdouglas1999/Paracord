import { AlertTriangle } from 'lucide-react';
import { useConfirmStore } from '../../stores/confirmStore';
import { cn } from '../../lib/utils';
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
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-danger/12 text-accent-danger">
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
            <button
              className="h-10 rounded-xl border border-border-strong px-5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
              onClick={() => close(false)}
            >
              {options.cancelLabel || 'Cancel'}
            </button>
            <button
              className={cn(
                'h-10 rounded-xl px-5 text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
                options.variant === 'danger'
                  ? 'bg-accent-danger hover:bg-accent-danger/85 focus-visible:ring-accent-danger'
                  : 'bg-accent-primary hover:bg-accent-primary-hover focus-visible:ring-accent-primary'
              )}
              onClick={() => close(true)}
              autoFocus
            >
              {options.confirmLabel || 'Confirm'}
            </button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
