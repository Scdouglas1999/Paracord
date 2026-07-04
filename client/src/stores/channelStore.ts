import axios from 'axios';
import { create } from 'zustand';
import type { Channel } from '../types';
import { guildApi } from '../api/guilds';
import { channelApi } from '../api/channels';
import { extractApiError } from '../api/client';
import { toast } from './toastStore';
import { useServerListStore } from './serverListStore';
import { connectionManager } from '../lib/connectionManager';

function normalizeChannel(channel: Channel): Channel {
  return {
    ...channel,
    type: (channel.type ?? channel.channel_type ?? 0) as Channel['type'],
    channel_type: channel.channel_type ?? channel.type ?? 0,
    required_role_ids: channel.required_role_ids ?? [],
    thread_metadata: channel.thread_metadata ?? null,
    owner_id: channel.owner_id ?? null,
    message_count: channel.message_count ?? null,
    created_at: channel.created_at ?? new Date().toISOString(),
  };
}

// channelsByGuild is the single source of truth; channelsById is a derived index
// maintained incrementally. reindexGuild patches the index for one guild only:
// it drops the guild's previous channel ids and inserts the new list, leaving
// every other guild's entries untouched (and identity-stable).
function reindexGuild(
  prevById: Record<string, Channel>,
  oldChannels: Channel[],
  newChannels: Channel[],
): Record<string, Channel> {
  const byId = { ...prevById };
  for (const c of oldChannels) delete byId[c.id];
  for (const c of newChannels) byId[c.id] = c;
  return byId;
}

interface ChannelState {
  // Channels indexed by guild ID. Key '' is used for DMs.
  channelsByGuild: Record<string, Channel[]>;
  // DM channels indexed by serverId — the cross-server DM source for the
  // unified sidebar. channelsByGuild[''] mirrors the active server for
  // back-compat readers (UserProfile).
  dmChannelsByServer: Record<string, Channel[]>;
  // Fast channel lookup by channel ID.
  channelsById: Record<string, Channel>;
  // Flat accessor for the currently viewed guild (kept for backward compat)
  channels: Channel[];
  guildChannelsLoaded: Record<string, boolean>;
  selectedChannelId: string | null;
  selectedGuildId: string | null;
  isLoading: boolean;

  fetchChannels: (guildId: string) => Promise<void>;
  selectChannel: (channelId: string | null) => void;
  selectGuild: (guildId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setDmChannels: (channels: Channel[]) => void;
  setDmChannelsForServer: (serverId: string, channels: Channel[]) => void;
  loadAllDmChannels: () => Promise<void>;
  createChannel: (guildId: string, data: Parameters<typeof guildApi.createChannel>[1]) => Promise<Channel>;
  updateChannelData: (channelId: string, data: Partial<Channel>) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  reorderChannels: (guildId: string, positions: { id: string; position: number; parent_id?: string | null }[]) => Promise<void>;

  // Gateway event handlers
  addChannel: (channel: Channel) => void;
  updateChannel: (channel: Channel) => void;
  removeChannel: (guildId: string, channelId: string) => void;
  updateLastMessageId: (channelId: string, messageId: string) => void;
}

const _fetchInFlight = new Set<string>();
const _channelFetchControllers = new Map<string, AbortController>();
const MAX_FETCH_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

export const useChannelStore = create<ChannelState>()((set, get) => ({
  channelsByGuild: {},
  dmChannelsByServer: {},
  channelsById: {},
  channels: [],
  guildChannelsLoaded: {},
  selectedChannelId: null,
  selectedGuildId: null,
  isLoading: false,

  fetchChannels: async (guildId) => {
    // Abort any in-flight fetch for a different guild
    for (const [key, ctrl] of _channelFetchControllers) {
      if (key !== guildId) {
        ctrl.abort();
        _channelFetchControllers.delete(key);
        _fetchInFlight.delete(key);
      }
    }

    if (_fetchInFlight.has(guildId)) return;
    _fetchInFlight.add(guildId);
    set({ isLoading: true });

    const controller = new AbortController();
    _channelFetchControllers.set(guildId, controller);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
      if (controller.signal.aborted) {
        _fetchInFlight.delete(guildId);
        _channelFetchControllers.delete(guildId);
        return;
      }
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
        }
        if (controller.signal.aborted) {
          _fetchInFlight.delete(guildId);
          _channelFetchControllers.delete(guildId);
          return;
        }
        const { data } = await guildApi.getChannels(guildId, {
          timeout: 5_000,
          signal: controller.signal,
        });
        const sorted = data.map(normalizeChannel).sort((a, b) => a.position - b.position);
        set((state) => {
          const channelsById = reindexGuild(
            state.channelsById,
            state.channelsByGuild[guildId] || [],
            sorted,
          );
          const channelsByGuild = { ...state.channelsByGuild, [guildId]: sorted };
          const channels = state.selectedGuildId === guildId ? sorted : state.channels;
          const guildChannelsLoaded = { ...state.guildChannelsLoaded, [guildId]: true };
          return { channelsByGuild, channelsById, channels, isLoading: false, guildChannelsLoaded };
        });
        _fetchInFlight.delete(guildId);
        _channelFetchControllers.delete(guildId);
        return;
      } catch (err) {
        if (axios.isCancel(err) || controller.signal.aborted) {
          _fetchInFlight.delete(guildId);
          _channelFetchControllers.delete(guildId);
          return;
        }
        lastErr = err;
      }
    }
    set({ isLoading: false });
    toast.error(`Failed to load channels: ${extractApiError(lastErr)}`);
    _fetchInFlight.delete(guildId);
    _channelFetchControllers.delete(guildId);
  },

  selectChannel: (channelId) => set({ selectedChannelId: channelId }),

  selectGuild: (guildId) =>
    set((state) => ({
      selectedGuildId: guildId,
      channels: guildId ? state.channelsByGuild[guildId] || [] : [],
    })),

  setChannels: (channels) =>
    set((state) => {
      const normalized = channels.map(normalizeChannel);
      // Group by guild so channelsByGuild stays the source of truth, then patch
      // the derived index for each touched guild.
      const groups: Record<string, Channel[]> = {};
      for (const c of normalized) {
        const gid = c.guild_id || '';
        (groups[gid] ??= []).push(c);
      }
      const channelsByGuild = { ...state.channelsByGuild };
      let channelsById = state.channelsById;
      for (const [gid, list] of Object.entries(groups)) {
        const sorted = [...list].sort((a, b) => a.position - b.position);
        channelsById = reindexGuild(channelsById, channelsByGuild[gid] || [], sorted);
        channelsByGuild[gid] = sorted;
      }
      return { channelsByGuild, channelsById, channels: normalized };
    }),
  setDmChannels: (channels) =>
    set((state) => {
      const normalized = channels.map(normalizeChannel);
      const channelsById = reindexGuild(state.channelsById, state.channelsByGuild[''] || [], normalized);
      return {
        channelsByGuild: { ...state.channelsByGuild, '': normalized },
        channelsById,
        channels: state.selectedGuildId ? state.channels : normalized,
      };
    }),

  setDmChannelsForServer: (serverId, channels) =>
    set((state) => {
      const normalized = channels.map(normalizeChannel);
      const dmChannelsByServer = { ...state.dmChannelsByServer, [serverId]: normalized };
      // Only the active server's DMs mirror into channelsByGuild[''] + the
      // derived index, so back-compat readers (UserProfile) keep seeing
      // the active server. Background servers land only in dmChannelsByServer.
      const activeServerId = useServerListStore.getState().activeServerId;
      if (serverId !== activeServerId) {
        return { dmChannelsByServer };
      }
      const channelsById = reindexGuild(state.channelsById, state.channelsByGuild[''] || [], normalized);
      return {
        dmChannelsByServer,
        channelsByGuild: { ...state.channelsByGuild, '': normalized },
        channelsById,
        channels: state.selectedGuildId ? state.channels : normalized,
      };
    }),

  loadAllDmChannels: async () => {
    const { servers } = useServerListStore.getState();
    const connected = servers.filter((s) => s.connected);
    await Promise.all(
      connected.map(async (server) => {
        const client = connectionManager.getApiClient(server.id);
        if (!client) return;
        try {
          // Mirror dmApi.list()'s request path against the per-server client.
          const { data } = await client.get<Channel[]>('/users/@me/dms');
          get().setDmChannelsForServer(server.id, data);
        } catch {
          // Swallow per-server errors so an unreachable background server
          // degrades gracefully (§9 flag 2) — other servers still load.
        }
      }),
    );
  },

  createChannel: async (guildId, channelData) => {
    const { data } = await guildApi.createChannel(guildId, channelData);
    set((state) => {
      const existing = state.channelsByGuild[guildId] || [];
      const updated = [...existing, normalizeChannel(data)].sort((a, b) => a.position - b.position);
      const channelsById = reindexGuild(state.channelsById, existing, updated);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channelsById, channels };
    });
    return data;
  },

  updateChannelData: async (channelId, data) => {
    const { data: updated } = await channelApi.update(channelId, data);
    set((state) => {
      const normalized = normalizeChannel(updated);
      const guildId = normalized.guild_id || '';
      const existing = state.channelsByGuild[guildId] || [];
      const list = existing.map((c) => (c.id === channelId ? normalized : c));
      const channelsById = reindexGuild(state.channelsById, existing, list);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: list };
      const channels = state.selectedGuildId === guildId ? list : state.channels;
      return { channelsByGuild, channelsById, channels };
    });
  },

  deleteChannel: async (channelId) => {
    await channelApi.delete(channelId);
    set((state) => {
      const existing = state.channelsById[channelId];
      if (!existing) return state;
      const gid = existing.guild_id || '';
      const guildChannels = state.channelsByGuild[gid] || [];
      const updated = guildChannels.filter((c) => c.id !== channelId);
      const channelsById = reindexGuild(state.channelsById, guildChannels, updated);
      const channelsByGuild = { ...state.channelsByGuild, [gid]: updated };
      const channels = state.channels.some((c) => c.id === channelId)
        ? state.channels.filter((c) => c.id !== channelId)
        : state.channels;
      return { channelsByGuild, channelsById, channels };
    });
  },

  reorderChannels: async (guildId, positions) => {
    // Snapshot for rollback
    const prev = get().channelsByGuild[guildId] || [];

    // Optimistic update
    set((state) => {
      const existing = state.channelsByGuild[guildId] || [];
      const posMap = new Map(positions.map((p) => [p.id, p]));
      const updated = existing
        .map((ch) => {
          const patch = posMap.get(ch.id);
          if (!patch) return ch;
          return {
            ...ch,
            position: patch.position,
            parent_id: patch.parent_id !== undefined ? patch.parent_id : ch.parent_id,
          };
        })
        .sort((a, b) => a.position - b.position);
      const channelsById = reindexGuild(state.channelsById, existing, updated);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channelsById, channels };
    });

    try {
      await channelApi.updatePositions(guildId, positions);
    } catch (err) {
      // Rollback on failure
      set((state) => {
        const channelsById = reindexGuild(state.channelsById, state.channelsByGuild[guildId] || [], prev);
        const channelsByGuild = { ...state.channelsByGuild, [guildId]: prev };
        const channels = state.selectedGuildId === guildId ? prev : state.channels;
        return { channelsByGuild, channelsById, channels };
      });
      toast.error(`Failed to reorder channels: ${extractApiError(err)}`);
    }
  },

  addChannel: (channel) =>
    set((state) => {
      const normalized = normalizeChannel(channel);
      const guildId = normalized.guild_id || '';
      const existing = state.channelsByGuild[guildId] || [];
      if (existing.some((c) => c.id === normalized.id)) return state;
      const updated = [...existing, normalized].sort((a, b) => a.position - b.position);
      const channelsById = reindexGuild(state.channelsById, existing, updated);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channelsById, channels };
    }),

  updateChannel: (channel) =>
    set((state) => {
      const normalized = normalizeChannel(channel);
      const guildId = normalized.guild_id || '';
      const existing = state.channelsByGuild[guildId] || [];
      const updated = existing
        .map((c) => (c.id === normalized.id ? normalized : c))
        .sort((a, b) => a.position - b.position);
      const channelsById = reindexGuild(state.channelsById, existing, updated);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channelsById, channels };
    }),

  removeChannel: (guildId, channelId) =>
    set((state) => {
      const gid = guildId || '';
      const existing = state.channelsByGuild[gid] || [];
      const updated = existing.filter((c) => c.id !== channelId);
      const channelsById = reindexGuild(state.channelsById, existing, updated);
      const channelsByGuild = { ...state.channelsByGuild, [gid]: updated };
      const channels = state.selectedGuildId === gid ? updated : state.channels;
      return { channelsByGuild, channelsById, channels };
    }),

  updateLastMessageId: (channelId, messageId) =>
    set((state) => {
      // O(1): resolve the channel via the index, then patch only its guild
      // bucket, its index entry, and (if visible) its flat-array slot. Every
      // other guild's array and channel objects keep their identity.
      const existing = state.channelsById[channelId];
      if (!existing) return state;
      const gid = existing.guild_id || '';
      const patched = { ...existing, last_message_id: messageId };
      const guildChannels = state.channelsByGuild[gid] || [];
      const newGuildChannels = guildChannels.map((c) => (c.id === channelId ? patched : c));
      const channelsByGuild = { ...state.channelsByGuild, [gid]: newGuildChannels };
      const channelsById = { ...state.channelsById, [channelId]: patched };
      const channels = state.channels.some((c) => c.id === channelId)
        ? state.channels.map((c) => (c.id === channelId ? patched : c))
        : state.channels;
      return { channelsByGuild, channelsById, channels };
    }),
}));
