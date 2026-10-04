import { create } from 'zustand';

import { registerSessionReset } from '../../../stores/sessionReset';

/**
 * Whether the Add a server sheet is open, and on which page (docs/index-spec.md
 * §4.8). The dock's `+` toggles it; anything else that wants to send a person
 * there (a command, an empty state) calls `openAddServer`. The sheet itself is
 * mounted by the dock, so it is always where the shell expects a sheet to be.
 */
export type AddServerTab = 'create' | 'join' | 'discover';

interface AddServerState {
  open: boolean;
  tab: AddServerTab;
  openSheet: (tab?: AddServerTab) => void;
  closeSheet: () => void;
  toggleSheet: () => void;
  setTab: (tab: AddServerTab) => void;
}

export const useAddServerStore = create<AddServerState>()((set) => ({
  open: false,
  tab: 'create',
  openSheet: (tab = 'create') => set({ open: true, tab }),
  closeSheet: () => set({ open: false }),
  toggleSheet: () => set((state) => (state.open ? { open: false } : { open: true, tab: 'create' })),
  setTab: (tab) => set({ tab }),
}));

registerSessionReset('ix-add-server', () => useAddServerStore.setState({ open: false, tab: 'create' }));

/** Open the Add a server sheet, on Create unless `tab` says otherwise. */
export function openAddServer(tab?: AddServerTab): void {
  useAddServerStore.getState().openSheet(tab);
}

export function closeAddServer(): void {
  useAddServerStore.getState().closeSheet();
}
