import { create } from 'zustand';

/** Which saved server the "Sign in again" dialog is open for, if any. */
interface ServerSignInDialogState {
  serverId: string | null;
  open: (serverId: string) => void;
  close: () => void;
}

export const useServerSignInDialog = create<ServerSignInDialogState>()((set) => ({
  serverId: null,
  open: (serverId) => set({ serverId }),
  close: () => set({ serverId: null }),
}));
