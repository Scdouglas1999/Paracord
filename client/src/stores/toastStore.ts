import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  addToast: (
    type: ToastType,
    message: string,
    duration?: number,
    action?: ToastAction
  ) => void;
  removeToast: (id: string) => void;
}

let nextId = 0;
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = 5000, action) => {
    const id = String(++nextId);
    set((state) => ({
      toasts: [...state.toasts, { id, type, message, duration, action }],
    }));
    const timer = setTimeout(() => {
      dismissTimers.delete(id);
      if (get().toasts.some((t) => t.id === id)) {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      }
    }, duration);
    dismissTimers.set(id, timer);
  },

  removeToast: (id) => {
    const timer = dismissTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      dismissTimers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Convenience helpers for use outside React components (e.g. in other stores). */
export const toast = {
  success: (message: string, duration?: number, action?: ToastAction) =>
    useToastStore.getState().addToast('success', message, duration, action),
  error: (message: string, duration?: number, action?: ToastAction) =>
    useToastStore.getState().addToast('error', message, duration, action),
  info: (message: string, duration?: number, action?: ToastAction) =>
    useToastStore.getState().addToast('info', message, duration, action),
  warning: (message: string, duration?: number, action?: ToastAction) =>
    useToastStore.getState().addToast('warning', message, duration, action),
};
