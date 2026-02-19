import { create } from 'zustand';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
}

interface ConfirmState {
  isOpen: boolean;
  options: ConfirmOptions | null;
  resolve: ((confirmed: boolean) => void) | null;

  confirm: (options: ConfirmOptions) => Promise<boolean>;
  close: (confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  isOpen: false,
  options: null,
  resolve: null,

  confirm: (options) => {
    return new Promise<boolean>((resolve) => {
      set({ isOpen: true, options, resolve });
    });
  },

  close: (confirmed) => {
    const { resolve } = get();
    resolve?.(confirmed);
    set({ isOpen: false, options: null, resolve: null });
  },
}));

/** Convenience helper for use outside React components. */
export const confirm = (options: ConfirmOptions) =>
  useConfirmStore.getState().confirm(options);
