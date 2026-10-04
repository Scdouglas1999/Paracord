import { create } from 'zustand';
import { registerSessionReset } from './sessionReset';

/**
 * Glass layout state (docs/glass-spec.md §3, §5, §6; docs/design/glass-plan.md
 * §1.2). Created by WP-G7, consumed by every Glass package.
 *
 * Watching is store state, not a route: browsing channels while a stream plays
 * (§6.3) only works if the stage outlives navigation. The routes stay as they
 * are; the shell (`components/glass/shell`) reads this store to decide which
 * panes are on screen and where.
 *
 * Nothing here is persisted. A reload starts in the conversation with no stage,
 * no sheet and no overlay, which is what someone reopening the app expects.
 *
 * Invariants the actions keep:
 *   - `stage.mode === 'none'` exactly when `stage` has no target.
 *   - `browseOpen` and `chatHidden` are only ever true while a stage is open.
 *   - `chatHidden` is only ever true in theater (H hides the chat there only).
 *   - `stage.chat` (the Index call view's chat column, IX-4) is false while no
 *     stage is open.
 *   - Watching never joins a call and closing the stage never leaves one: this
 *     store holds no media state and calls nothing in `voiceStore`.
 */

export type StageMode = 'none' | 'side' | 'theater';
export type OpenStageMode = Exclude<StageMode, 'none'>;

/**
 * What the stage shows: one person's stream in a call, or the call itself.
 *
 * A call is a server voice channel or a direct message call. A DM belongs to no
 * server, so its `guildId` is null (never a sentinel string: `voiceStore`'s
 * `'dm'` is its own wire convention and stays at that boundary, see
 * `pill/pillActions.ts` `voiceGuildOf`).
 *
 * `streamerId` null is the call itself: nobody's screen, the people and their
 * cameras, and the call's controls (share, camera, More). A joined person
 * opens it from the pill ("Show the call") when there is no stream to watch.
 */
export interface StageTarget {
  /** The instance (AccountScope.serverId) whose API and relay carry the call. */
  serverId: string;
  /** The server, or null for a direct message call. */
  guildId: string | null;
  channelId: string;
  /** Whose screen is watched, or null for the call itself. */
  streamerId: string | null;
}

/** A stage target that watches somebody's screen. */
export type StreamStageTarget = StageTarget & { streamerId: string };

export function isStreamTarget(target: StageTarget): target is StreamStageTarget {
  return target.streamerId !== null;
}

/** The stage target the store holds, or null while no stage is open. */
export function stageTargetOf(stage: StageState): StageTarget | null {
  if (stage.mode === 'none' || !stage.serverId || !stage.channelId) return null;
  return { serverId: stage.serverId, guildId: stage.guildId, channelId: stage.channelId, streamerId: stage.streamerId };
}

export interface StageState {
  mode: StageMode;
  /**
   * H in the Index call view (docs/index-spec.md §7.1, §7.2): the room's own
   * chat as a column inside the call surface. Off when a call view opens; kept
   * when switching streams inside an open one; false whenever nothing is open.
   * (Glass's `chatHidden` is the old theater-only inverse; it goes in M2.)
   */
  chat: boolean;
  serverId: string | null;
  guildId: string | null;
  channelId: string | null;
  streamerId: string | null;
}

/** The sheets over the conversation column (WP-G18). */
export type GlassSheet = 'search' | 'people' | 'account' | 'channel' | 'server';

export interface GlassState {
  stage: StageState;
  /** S: the places panel slid back in while a stage is open (§6.3). */
  browseOpen: boolean;
  /** H: the conversation hidden in theater (§6.2). */
  chatHidden: boolean;
  /** The call pill grown to the column's width (§5). */
  pillExpanded: boolean;
  /** Below ~860px the places panel is an overlay opened from the header (§3). */
  placesOverlayOpen: boolean;
  sheet: GlassSheet | null;

  /**
   * Watch: open the stage on a stream. A fresh stage is side by side unless
   * `mode` says otherwise; switching streams keeps the current mode.
   */
  openStage: (target: StageTarget, mode?: OpenStageMode) => void;
  /** Esc, "Stop watching". Never leaves a call. */
  closeStage: () => void;
  /** T: side by side <-> theater. Ignored while no stage is open. */
  setStageMode: (mode: OpenStageMode) => void;
  toggleBrowse: () => void;
  setBrowseOpen: (open: boolean) => void;
  toggleChatHidden: () => void;
  /** H in the Index call view: the chat column on or off. Ignored while no stage is open. */
  toggleChat: () => void;
  setChatHidden: (hidden: boolean) => void;
  setPillExpanded: (expanded: boolean) => void;
  setPlacesOverlayOpen: (open: boolean) => void;
  openSheet: (sheet: GlassSheet | null) => void;
  closeSheet: () => void;
  reset: () => void;
}

const NO_STAGE: StageState = {
  mode: 'none',
  chat: false,
  serverId: null,
  guildId: null,
  channelId: null,
  streamerId: null,
};

type GlassData = Pick<
  GlassState,
  'stage' | 'browseOpen' | 'chatHidden' | 'pillExpanded' | 'placesOverlayOpen' | 'sheet'
>;

const INITIAL: GlassData = {
  stage: NO_STAGE,
  browseOpen: false,
  chatHidden: false,
  pillExpanded: false,
  placesOverlayOpen: false,
  sheet: null,
};

export const useGlassStore = create<GlassState>()((set, get) => ({
  ...INITIAL,

  openStage: (target, mode) => {
    const current = get().stage;
    const opening = current.mode === 'none';
    // Switching streams inside an open stage keeps the layout the person chose
    // unless the caller names one; a fresh Watch is side by side by default.
    const nextMode: OpenStageMode = mode ?? (opening ? 'side' : current.mode as OpenStageMode);
    set({
      stage: {
        mode: nextMode,
        // A fresh view opens without the chat column; switching streams keeps it.
        chat: opening ? false : current.chat,
        serverId: target.serverId,
        guildId: target.guildId,
        channelId: target.channelId,
        streamerId: target.streamerId,
      },
      // The stage grows out of the pill; the pill is compact again under it.
      pillExpanded: false,
      // A fresh Watch starts with the conversation beside the stream.
      browseOpen: opening ? false : get().browseOpen,
      chatHidden: nextMode === 'theater' && (current.mode !== 'theater' || get().chatHidden),
    });
  },

  closeStage: () => set({ stage: NO_STAGE, browseOpen: false, chatHidden: false }),

  setStageMode: (mode) => {
    const { stage } = get();
    if (stage.mode === 'none') return;
    set({
      stage: { ...stage, mode },
      // Enter theater with the stream unobstructed; side by side restores chat.
      chatHidden: mode === 'theater' && (stage.mode !== 'theater' || get().chatHidden),
    });
  },

  toggleBrowse: () => {
    if (get().stage.mode === 'none') return;
    set((s) => ({ browseOpen: !s.browseOpen }));
  },

  setBrowseOpen: (open) => {
    if (open && get().stage.mode === 'none') return;
    set({ browseOpen: open });
  },

  toggleChatHidden: () => {
    if (get().stage.mode !== 'theater') return;
    set((s) => ({ chatHidden: !s.chatHidden }));
  },

  toggleChat: () => {
    const { stage } = get();
    if (stage.mode === 'none') return;
    set({ stage: { ...stage, chat: !stage.chat } });
  },

  setChatHidden: (hidden) => {
    if (hidden && get().stage.mode !== 'theater') return;
    set({ chatHidden: hidden });
  },

  setPillExpanded: (pillExpanded) => set({ pillExpanded }),
  setPlacesOverlayOpen: (placesOverlayOpen) => set({ placesOverlayOpen }),
  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: null }),
  reset: () => set({ ...INITIAL }),
}));

/** True while a stage is open (side by side or theater). */
export const selectStageOpen = (s: GlassState): boolean => s.stage.mode !== 'none';

registerSessionReset('glass-layout', () => useGlassStore.getState().reset());
