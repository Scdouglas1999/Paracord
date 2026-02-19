import { create } from 'zustand';
import type { Channel } from '../types';
import { guildApi } from '../api/guilds';
import { channelApi } from '../api/channels';
import { extractApiError } from '../api/client';
import { toast } from './toastStore';

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

interface ChannelState {
  // Channels indexed by guild ID. Key '' is used for DMs.
  channelsByGuild: Record<string, Channel[]>;
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
const MAX_FETCH_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;

export const useChannelStore = create<ChannelState>()((set, get) => ({
  channelsByGuild: {},
  channels: [],
  guildChannelsLoaded: {},
  selectedChannelId: null,
  selectedGuildId: null,
  isLoading: false,

  fetchChannels: async (guildId) => {
    if (_fetchInFlight.has(guildId)) return;
    _fetchInFlight.add(guildId);
    set({ isLoading: true });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
        }
        const { data } = await guildApi.getChannels(guildId);
        const sorted = data.map(normalizeChannel).sort((a, b) => a.position - b.position);
        set((state) => {
          const channelsByGuild = { ...state.channelsByGuild, [guildId]: sorted };
          const channels = state.selectedGuildId === guildId ? sorted : state.channels;
          const guildChannelsLoaded = { ...state.guildChannelsLoaded, [guildId]: true };
          return { channelsByGuild, channels, isLoading: false, guildChannelsLoaded };
        });
        _fetchInFlight.delete(guildId);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    set({ isLoading: false });
    toast.error(`Failed to load channels: ${extractApiError(lastErr)}`);
    _fetchInFlight.delete(guildId);
  },

  selectChannel: (channelId) => set({ selectedChannelId: channelId }),

  selectGuild: (guildId) =>
    set((state) => ({
      selectedGuildId: guildId,
      channels: guildId ? state.channelsByGuild[guildId] || [] : [],
    })),

  setChannels: (channels) => set({ channels }),
  setDmChannels: (channels) =>
    set((state) => ({
      channelsByGuild: { ...state.channelsByGuild, '': channels.map(normalizeChannel) },
      channels: state.selectedGuildId ? state.channels : channels.map(normalizeChannel),
    })),

  createChannel: async (guildId, channelData) => {
    const { data } = await guildApi.createChannel(guildId, channelData);
    set((state) => {
      const existing = state.channelsByGuild[guildId] || [];
      const updated = [...existing, normalizeChannel(data)].sort((a, b) => a.position - b.position);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channels };
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
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: list };
      const channels = state.selectedGuildId === guildId ? list : state.channels;
      return { channelsByGuild, channels };
    });
  },

  deleteChannel: async (channelId) => {
    await channelApi.delete(channelId);
    set((state) => {
      const newByGuild: Record<string, Channel[]> = {};
      for (const [gid, chs] of Object.entries(state.channelsByGuild)) {
        newByGuild[gid] = chs.filter((c) => c.id !== channelId);
      }
      const channels = state.channels.filter((c) => c.id !== channelId);
      return { channelsByGuild: newByGuild, channels };
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
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channels };
    });

    try {
      await channelApi.updatePositions(guildId, positions);
    } catch (err) {
      // Rollback on failure
      set((state) => {
        const channelsByGuild = { ...state.channelsByGuild, [guildId]: prev };
        const channels = state.selectedGuildId === guildId ? prev : state.channels;
        return { channelsByGuild, channels };
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
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channels };
    }),

  updateChannel: (channel) =>
    set((state) => {
      const normalized = normalizeChannel(channel);
      const guildId = normalized.guild_id || '';
      const existing = state.channelsByGuild[guildId] || [];
      const updated = existing
        .map((c) => (c.id === normalized.id ? normalized : c))
        .sort((a, b) => a.position - b.position);
      const channelsByGuild = { ...state.channelsByGuild, [guildId]: updated };
      const channels = state.selectedGuildId === guildId ? updated : state.channels;
      return { channelsByGuild, channels };
    }),

  removeChannel: (guildId, channelId) =>
    set((state) => {
      const gid = guildId || '';
      const existing = state.channelsByGuild[gid] || [];
      const updated = existing.filter((c) => c.id !== channelId);
      const channelsByGuild = { ...state.channelsByGuild, [gid]: updated };
      const channels = state.selectedGuildId === gid ? updated : state.channels;
      return { channelsByGuild, channels };
    }),

  updateLastMessageId: (channelId, messageId) =>
    set((state) => {
      const newByGuild: Record<string, Channel[]> = {};
      let found = false;
      for (const [gid, chs] of Object.entries(state.channelsByGuild)) {
        newByGuild[gid] = chs.map((c) => {
          if (c.id === channelId) {
            found = true;
            return { ...c, last_message_id: messageId };
          }
          return c;
        });
      }
      if (!found) return state;
      const channels = state.selectedGuildId
        ? newByGuild[state.selectedGuildId] || state.channels
        : state.channels;
      return { channelsByGuild: newByGuild, channels };
    }),
}));
