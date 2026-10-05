import { create } from 'zustand';
import { registerSessionReset } from './sessionReset';

/**
 * Layout state shared across the Index shell: the call view (the "stage") and
 * the sheet that is open over main (docs/index-spec.md §6.1, §7).
 *
 * Watching is store state, not a route: browsing channels while a stream plays
 * only works if the call view outlives navigation. The routes stay as they are;
 * `components/ix/call` and `components/ix/shell` read this store to decide what
 * is on screen and where.
 *
 * Nothing here is persisted. A reload starts in the conversation with no call
 * view and no sheet, which is what someone reopening the app expects.
 *
 * Invariants the actions keep:
 *   - `stage.mode === 'none'` exactly when `stage` has no target.
 *   - `stage.chat` (the call view's chat column) is false while no stage is open.
 *   - Watching never joins a call and closing the call view never leaves one: this
 *     store holds no media state and calls nothing in `voiceStore`.
 */

/** `main`: the call view over main; `theater`: over the whole window (index-spec §7.1). */
export type StageMode = 'none' | 'main' | 'theater';
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
 * opens it from the room card ("Open call") when there is no stream to watch.
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
   * H in the call view (docs/index-spec.md §7.1, §7.2): the room's own chat as a
   * column inside the call surface. Off when a call view opens; kept when
   * switching streams inside an open one; false whenever nothing is open.
   */
  chat: boolean;
  serverId: string | null;
  guildId: string | null;
  channelId: string | null;
  streamerId: string | null;
}

/** The sheets over main (index-spec §6.1). */
export type GlassSheet = 'search' | 'people' | 'account' | 'channel' | 'server';

export interface GlassState {
  stage: StageState;
  sheet: GlassSheet | null;

  /**
   * Watch: open the call view on a stream (or on the call itself). A fresh view
   * is in main unless `mode` says otherwise; switching streams keeps the current
   * mode.
   */
  openStage: (target: StageTarget, mode?: OpenStageMode) => void;
  /** Esc, "Back to chat". Never leaves a call. */
  closeStage: () => void;
  /** T: main <-> theater. Ignored while no stage is open. */
  setStageMode: (mode: OpenStageMode) => void;
  /** H in the call view: the chat column on or off. Ignored while no stage is open. */
  toggleChat: () => void;
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

type GlassData = Pick<GlassState, 'stage' | 'sheet'>;

const INITIAL: GlassData = {
  stage: NO_STAGE,
  sheet: null,
};

export const useGlassStore = create<GlassState>()((set, get) => ({
  ...INITIAL,

  openStage: (target, mode) => {
    const current = get().stage;
    const opening = current.mode === 'none';
    // Switching streams inside an open call view keeps the layout the person chose
    // unless the caller names one; a fresh Watch opens in main by default.
    const nextMode: OpenStageMode = mode ?? (opening ? 'main' : current.mode as OpenStageMode);
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
    });
  },

  closeStage: () => set({ stage: NO_STAGE }),

  setStageMode: (mode) => {
    const { stage } = get();
    if (stage.mode === 'none') return;
    set({ stage: { ...stage, mode } });
  },

  toggleChat: () => {
    const { stage } = get();
    if (stage.mode === 'none') return;
    set({ stage: { ...stage, chat: !stage.chat } });
  },

  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: null }),
  reset: () => set({ ...INITIAL }),
}));

/** True while a call view is open (main or theater). */
export const selectStageOpen = (s: GlassState): boolean => s.stage.mode !== 'none';

registerSessionReset('glass-layout', () => useGlassStore.getState().reset());
