import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Which call pill a sheet's page is over (docs/design/glass-polish-2-checkpoint.md).
 *
 * A sheet is a solid page over the conversation, so it covers the conversation
 * header and the pill in it. Call controls have to stay reachable, so a sheet
 * draws a pill of its own in its header (`SheetFrame`), and the covered pill in
 * the conversation steps out of the accessibility tree and the tab order for as
 * long as the sheet is there (it is still mounted, so its place, its expanded
 * roster and its listeners are as they were when the sheet goes).
 *
 * `SheetFrame` registers here while it is mounted (its leave included), so every
 * sheet is counted, whichever page opened it.
 */
interface SheetCoverState {
  /** How many sheet frames are mounted over the conversation. */
  sheets: number;
  add: () => void;
  remove: () => void;
}

export const useSheetCoverStore = create<SheetCoverState>()((set) => ({
  sheets: 0,
  add: () => set((state) => ({ sheets: state.sheets + 1 })),
  remove: () => set((state) => ({ sheets: Math.max(0, state.sheets - 1) })),
}));

/** Whether a sheet is over the conversation, covering the pill in its header. */
export function useSheetCover(): boolean {
  return useSheetCoverStore((state) => state.sheets > 0);
}

/** Count this component as a sheet over the conversation while `active`. */
export function useRegisterSheetCover(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    useSheetCoverStore.getState().add();
    return () => useSheetCoverStore.getState().remove();
  }, [active]);
}
