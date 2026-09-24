import { create } from 'zustand';

import { registerSessionReset } from './sessionReset';

import {
  currentItem,
  formatPlaybackTime,
  type TogetherActivity,
  type TogetherActivityUpdate,
  type TogetherSession,
  type TogetherSessionUpdate,
} from '../lib/together/model';

/**
 * Watch together / Listen together, as this client knows it.
 *
 * Two feeds, both versioned by the server's monotonic `revision` so an update
 * that arrives late (a slow REST answer racing a gateway event) never rolls
 * the state back:
 *
 *  - `calls`: the full session of a call you are in (TOGETHER_SESSION_UPDATE,
 *    and every REST answer);
 *  - `activities`: the slim summary of every session in a server you can see
 *    (TOGETHER_ACTIVITY_UPDATE and `GET /guilds/{id}/together`).
 */

export interface CallEntry {
  revision: number;
  session: TogetherSession | null;
}

export interface ActivityEntry {
  guildId: string;
  revision: number;
  activity: TogetherActivity | null;
}

/** A quiet in-call line: "{person} paused". The view adds the name. */
export interface TogetherNotice {
  id: number;
  channelId: string;
  userId: string | null;
  /** What they did, after their name: "paused", "skipped to 12:40". */
  text: string;
}

/** Apply a session update unless it is older than what we have. */
export function reduceCall(prev: CallEntry | undefined, update: TogetherSessionUpdate): CallEntry | undefined {
  if (prev && update.revision <= prev.revision) return prev;
  return { revision: update.revision, session: update.session };
}

export function reduceActivity(
  prev: ActivityEntry | undefined,
  guildId: string,
  revision: number,
  activity: TogetherActivity | null,
): ActivityEntry | undefined {
  if (prev && revision <= prev.revision) return prev;
  return { guildId, revision, activity };
}

/** The words for someone else's change, or null for changes nobody needs told. */
export function noticeText(prev: TogetherSession | null, update: TogetherSessionUpdate): string | null {
  const action = update.action;
  if (!action) return null;
  const next = update.session;
  const itemTitle = (id: string | null) =>
    (id && (next?.items.find((item) => item.id === id) ?? prev?.items.find((item) => item.id === id))?.title) || null;
  switch (action.type) {
    case 'start':
      return next?.kind === 'listen' ? 'started listening together' : 'started watching together';
    case 'play':
      return 'resumed';
    case 'pause':
      return 'paused';
    case 'seek':
      return `skipped to ${formatPlaybackTime(action.position_ms ?? 0)}`;
    case 'skip': {
      const title = itemTitle(action.item_id);
      return title ? `played ${title}` : 'skipped ahead';
    }
    case 'add': {
      const title = itemTitle(action.item_id);
      const before = prev?.items.length ?? 0;
      const added = (next?.items.length ?? 0) - before;
      if (added > 1) return `added ${added} items to the queue`;
      return title ? `added ${title}` : 'added to the queue';
    }
    case 'remove': {
      const title = itemTitle(action.item_id);
      return title ? `removed ${title}` : 'removed an item';
    }
    case 'policy':
      return next?.controller_policy === 'starter' ? 'locked the controls' : 'opened the controls to everyone';
    case 'unlocked':
      return 'left, so everyone can control it now';
    case 'stop':
      return 'stopped it for everyone';
    default:
      // "ended", "reorder", "call_ended": the media speaks for itself.
      return null;
  }
}

/** What the shared player on this device reports to the controls around it. */
export interface TogetherPlayerStatus {
  itemId: string | null;
  /** Width / height of the playing video, once known. */
  aspect: number | null;
  durationMs: number | null;
  buffering: boolean;
  error: string | null;
  needsGesture: boolean;
}

const VOLUME_KEY = 'paracord:together-volume';

function readVolume(): number {
  try {
    const raw = Number(window.localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 && window.localStorage.getItem(VOLUME_KEY) !== null ? raw : 0.8;
  } catch {
    return 0.8;
  }
}

interface TogetherState {
  calls: Record<string, CallEntry>;
  activities: Record<string, ActivityEntry>;
  notices: TogetherNotice[];
  /** Your own volume for shared playback, 0–1. Nobody else hears it change. */
  volume: number;
  player: TogetherPlayerStatus;
  setVolume: (volume: number) => void;
  setPlayerStatus: (status: TogetherPlayerStatus) => void;
  applySessionUpdate: (update: TogetherSessionUpdate, selfUserId: string | null) => void;
  /** A REST answer is the session as of its revision. */
  applySessionSnapshot: (channelId: string, session: TogetherSession) => void;
  forgetCall: (channelId: string) => void;
  applyActivityUpdate: (update: TogetherActivityUpdate) => void;
  loadGuildActivities: (
    guildId: string,
    revision: number,
    activities: { channel_id: string; revision: number; activity: TogetherActivity }[],
  ) => void;
  dismissNotice: (id: number) => void;
  reset: () => void;
}

let nextNoticeId = 1;

export const useTogetherStore = create<TogetherState>()((set, get) => ({
  calls: {},
  activities: {},
  notices: [],
  volume: readVolume(),
  player: { itemId: null, aspect: null, durationMs: null, buffering: false, error: null, needsGesture: false },

  setVolume: (volume) => {
    const clamped = Math.min(1, Math.max(0, volume));
    try {
      window.localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      // storage is optional; the volume still applies for this session
    }
    set({ volume: clamped });
  },

  setPlayerStatus: (player) => set({ player }),

  applySessionUpdate: (update, selfUserId) => {
    const prev = get().calls[update.channel_id];
    const next = reduceCall(prev, update);
    if (!next || next === prev) return;
    const text = update.action && update.action.user_id !== selfUserId ? noticeText(prev?.session ?? null, update) : null;
    set((state) => ({
      calls: { ...state.calls, [update.channel_id]: next },
      notices: text
        ? [...state.notices.slice(-3), { id: nextNoticeId++, channelId: update.channel_id, userId: update.action?.user_id ?? null, text }]
        : state.notices,
    }));
    // The call's own summary moves with it, for the sidebar row and Live now.
    if (update.guild_id) {
      const session = update.session;
      get().applyActivityUpdate({
        guild_id: update.guild_id,
        channel_id: update.channel_id,
        revision: update.revision,
        activity: session ? activityOf(session) : null,
      });
    }
  },

  applySessionSnapshot: (channelId, session) => {
    get().applySessionUpdate(
      { channel_id: channelId, guild_id: session.guild_id, revision: session.revision, session, action: null },
      null,
    );
  },

  forgetCall: (channelId) =>
    set((state) => {
      if (!(channelId in state.calls)) return state;
      const calls = { ...state.calls };
      delete calls[channelId];
      return { calls, notices: state.notices.filter((notice) => notice.channelId !== channelId) };
    }),

  applyActivityUpdate: (update) => {
    const prev = get().activities[update.channel_id];
    const next = reduceActivity(prev, update.guild_id, update.revision, update.activity);
    if (!next || next === prev) return;
    set((state) => ({ activities: { ...state.activities, [update.channel_id]: next } }));
  },

  loadGuildActivities: (guildId, revision, list) =>
    set((state) => {
      const activities = { ...state.activities };
      const listed = new Set(list.map((entry) => entry.channel_id));
      // Anything we thought was playing in this server that the answer no
      // longer lists has ended, as of the answer's revision.
      for (const [channelId, entry] of Object.entries(activities)) {
        if (entry.guildId !== guildId || listed.has(channelId)) continue;
        const next = reduceActivity(entry, guildId, revision, null);
        if (next) activities[channelId] = next;
      }
      for (const entry of list) {
        const next = reduceActivity(activities[entry.channel_id], guildId, entry.revision, entry.activity);
        if (next) activities[entry.channel_id] = next;
      }
      return { activities };
    }),

  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),

  reset: () =>
    set({
      calls: {},
      activities: {},
      notices: [],
      player: { itemId: null, aspect: null, durationMs: null, buffering: false, error: null, needsGesture: false },
    }),
}));

registerSessionReset('together', () => useTogetherStore.getState().reset());

export function activityOf(session: TogetherSession): TogetherActivity {
  const item = currentItem(session);
  return {
    session_id: session.session_id,
    kind: session.kind,
    started_by: session.started_by,
    playing: session.playing,
    title: item?.title ?? null,
    source: item?.source ?? null,
    thumbnail: item?.thumbnail ?? null,
    content_type: item?.content_type ?? null,
    item_count: session.items.length,
  };
}

/** The live summary for one voice channel, or null. */
export function useTogetherActivity(channelId: string | null | undefined): TogetherActivity | null {
  return useTogetherStore((state) => (channelId ? state.activities[channelId]?.activity ?? null : null));
}
