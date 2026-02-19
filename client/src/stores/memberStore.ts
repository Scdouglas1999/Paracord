import { create } from 'zustand';
import type { Member } from '../types';
import { guildApi } from '../api/guilds';
import { extractApiError } from '../api/client';
import { toast } from './toastStore';

interface MemberState {
  // Members indexed by guild ID
  members: Map<string, Member[]>;
  membersLoaded: Record<string, boolean>;
  isLoading: boolean;

  fetchMembers: (guildId: string) => Promise<void>;
  getMembersForGuild: (guildId: string) => Member[];

  // Gateway event handlers
  addMember: (guildId: string, member: Member) => void;
  removeMember: (guildId: string, userId: string) => void;
  updateMember: (guildId: string, member: Partial<Member> & { user: { id: string } }) => void;
}

const _fetchInFlight = new Set<string>();

export const useMemberStore = create<MemberState>()((set, get) => ({
  members: new Map(),
  membersLoaded: {},
  isLoading: false,

  fetchMembers: async (guildId) => {
    if (_fetchInFlight.has(guildId)) return;
    _fetchInFlight.add(guildId);
    set({ isLoading: true });
    try {
      const { data } = await guildApi.getMembers(guildId);
      set((state) => {
        const members = new Map(state.members);
        members.set(guildId, data);
        const membersLoaded = { ...state.membersLoaded, [guildId]: true };
        return { members, membersLoaded, isLoading: false };
      });
    } catch (err) {
      set({ isLoading: false });
      toast.error(`Failed to load members: ${extractApiError(err)}`);
    } finally {
      _fetchInFlight.delete(guildId);
    }
  },

  getMembersForGuild: (guildId) => {
    return get().members.get(guildId) || [];
  },

  addMember: (guildId, member) =>
    set((state) => {
      const members = new Map(state.members);
      const existing = members.get(guildId) || [];
      if (existing.some((m) => m.user.id === member.user.id)) return state;
      members.set(guildId, [...existing, member]);
      return { members };
    }),

  removeMember: (guildId, userId) =>
    set((state) => {
      const members = new Map(state.members);
      const existing = members.get(guildId) || [];
      members.set(
        guildId,
        existing.filter((m) => m.user.id !== userId)
      );
      return { members };
    }),

  updateMember: (guildId, memberData) =>
    set((state) => {
      const members = new Map(state.members);
      const existing = members.get(guildId) || [];
      members.set(
        guildId,
        existing.map((m) =>
          m.user.id === memberData.user.id ? { ...m, ...memberData } : m
        )
      );
      return { members };
    }),
}));
