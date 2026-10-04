import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';

/**
 * What the page in main tells the toolbar (docs/index-spec.md §4.9, §6.1).
 *
 * The toolbar is the frame's (it sits over the page's scroller, 58px, and never
 * remounts on navigation); what it SAYS is the page's. A page registers with
 * `useToolbar(...)`; registering also tells the frame that the page lays itself
 * out under the toolbar (its scroller starts with 58px of padding). A page that
 * does not register (today's Glass pages, until IX-15 and IX-10 replace them) is
 * pushed below the toolbar instead (`data-page="legacy"` on main).
 *
 * One page at a time: the last to register wins, and only the owner's
 * unregister clears it, so a page leaving after the next one mounted (a route
 * crossfade) cannot wipe the newcomer.
 */
export interface ToolbarPage {
  /** The folded title's text (the large title's). Omit for no folded title. */
  title?: string | null;
  /** The folded title is a button: the channel menu, or a DM's profile (§4.9, §4.11). */
  onTitleClick?: (() => void) | null;
  /** `aria-haspopup` for the title button (the channel menu is a `menu`). */
  titleHasPopup?: 'menu' | 'dialog' | null;
  /** True once the large title has scrolled 40px away (`useTitleFold`). */
  folded?: boolean;
  /** A pushed page (a thread, a game, a forum post): the back chevron before the title (§6.1). */
  onBack?: (() => void) | null;
  /** The back chevron's accessible name. Default "Back". */
  backLabel?: string;
  /** A DM's call button, left of search (§4.9, §7.5; IX-15 from `useDmCall`). */
  call?: ReactNode;
  /** Message search (the search sheet). Default: shown when the route has a server or a conversation. */
  search?: boolean;
  /** The people sheet. Default as `search`; the label is "Members", or "People in this message" in a DM. */
  members?: boolean;
}

interface ToolbarState {
  page: ToolbarPage | null;
  owner: symbol | null;
  register: (owner: symbol, page: ToolbarPage) => void;
  unregister: (owner: symbol) => void;
}

export const useToolbarStore = create<ToolbarState>()((set, get) => ({
  page: null,
  owner: null,
  register: (owner, page) => set({ owner, page }),
  unregister: (owner) => {
    if (get().owner === owner) set({ owner: null, page: null });
  },
}));

/**
 * Register the page in main with the toolbar. Call it from the page component
 * (`LargeTitlePage` does); the values may change every render.
 */
export function useToolbar(page: ToolbarPage): void {
  const owner = useRef<symbol | null>(null);
  if (owner.current === null) owner.current = Symbol('ix-toolbar-page');
  const { title, onTitleClick, titleHasPopup, folded, onBack, backLabel, call, search, members } = page;
  useLayoutEffect(() => {
    useToolbarStore.getState().register(owner.current as symbol, {
      title,
      onTitleClick,
      titleHasPopup,
      folded,
      onBack,
      backLabel,
      call,
      search,
      members,
    });
  }, [title, onTitleClick, titleHasPopup, folded, onBack, backLabel, call, search, members]);
  useLayoutEffect(() => {
    const token = owner.current as symbol;
    return () => useToolbarStore.getState().unregister(token);
  }, []);
}
