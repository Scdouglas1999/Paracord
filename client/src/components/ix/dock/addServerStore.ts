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
  /** An invite link to put in the Join tab's field (a deep link or the clipboard); the field takes it and clears it. */
  joinDraft: string | null;
  openSheet: (tab?: AddServerTab, joinDraft?: string) => void;
  clearJoinDraft: () => void;
  closeSheet: () => void;
  toggleSheet: () => void;
  setTab: (tab: AddServerTab) => void;
}

export const useAddServerStore = create<AddServerState>()((set) => ({
  open: false,
  tab: 'create',
  joinDraft: null,
  openSheet: (tab = 'create', joinDraft) => set({ open: true, tab, joinDraft: joinDraft ?? null }),
  clearJoinDraft: () => set({ joinDraft: null }),
  closeSheet: () => set({ open: false }),
  toggleSheet: () => set((state) => (state.open ? { open: false } : { open: true, tab: 'create' })),
  setTab: (tab) => set({ tab }),
}));

registerSessionReset('ix-add-server', () => useAddServerStore.setState({ open: false, tab: 'create' }));

/** Open the Add a server sheet, on Create unless `tab` says otherwise; `joinDraft` fills the Join field. */
export function openAddServer(tab?: AddServerTab, joinDraft?: string): void {
  useAddServerStore.getState().openSheet(tab, joinDraft);
}

export function closeAddServer(): void {
  useAddServerStore.getState().closeSheet();
}
