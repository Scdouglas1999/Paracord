import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Friend {
  publicKey: string;
  username: string;
  displayName?: string;
  addedAt: string;
}

export interface FriendRequest {
  publicKey: string;
  username: string;
  displayName?: string;
  timestamp: string;
  signature: string;
}

interface FriendState {
  friends: Friend[];
  pendingIncoming: FriendRequest[];
  pendingOutgoing: FriendRequest[];
  blocked: string[]; // public keys

  addFriend: (friend: Friend) => void;
  removeFriend: (publicKey: string) => void;
  addPendingIncoming: (request: FriendRequest) => void;
  addPendingOutgoing: (request: FriendRequest) => void;
  acceptRequest: (publicKey: string) => void;
  rejectRequest: (publicKey: string) => void;
  cancelOutgoing: (publicKey: string) => void;
  blockUser: (publicKey: string) => void;
  unblockUser: (publicKey: string) => void;
  isFriend: (publicKey: string) => boolean;
  isBlocked: (publicKey: string) => boolean;
}

export const useFriendStore = create<FriendState>()(
  persist(
    (set, get) => ({
      friends: [],
      pendingIncoming: [],
      pendingOutgoing: [],
      blocked: [],

      addFriend: (friend) =>
        set((state) => {
          if (state.friends.some((f) => f.publicKey === friend.publicKey)) return state;
          return { friends: [...state.friends, friend] };
        }),

      removeFriend: (publicKey) =>
        set((state) => ({
          friends: state.friends.filter((f) => f.publicKey !== publicKey),
        })),

      addPendingIncoming: (request) =>
        set((state) => {
          if (state.pendingIncoming.some((r) => r.publicKey === request.publicKey)) return state;
          return { pendingIncoming: [...state.pendingIncoming, request] };
        }),

      addPendingOutgoing: (request) =>
        set((state) => {
          if (state.pendingOutgoing.some((r) => r.publicKey === request.publicKey)) return state;
          return { pendingOutgoing: [...state.pendingOutgoing, request] };
        }),

      acceptRequest: (publicKey) =>
        set((state) => {
          const request = state.pendingIncoming.find((r) => r.publicKey === publicKey);
          if (!request) return state;
          const friend: Friend = {
            publicKey: request.publicKey,
            username: request.username,
            displayName: request.displayName,
            addedAt: new Date().toISOString(),
          };
          return {
            friends: [...state.friends, friend],
            pendingIncoming: state.pendingIncoming.filter((r) => r.publicKey !== publicKey),
          };
        }),

      rejectRequest: (publicKey) =>
        set((state) => ({
          pendingIncoming: state.pendingIncoming.filter((r) => r.publicKey !== publicKey),
        })),

      cancelOutgoing: (publicKey) =>
        set((state) => ({
          pendingOutgoing: state.pendingOutgoing.filter((r) => r.publicKey !== publicKey),
        })),

      blockUser: (publicKey) =>
        set((state) => {
          if (state.blocked.includes(publicKey)) return state;
          return {
            blocked: [...state.blocked, publicKey],
            friends: state.friends.filter((f) => f.publicKey !== publicKey),
            pendingIncoming: state.pendingIncoming.filter((r) => r.publicKey !== publicKey),
            pendingOutgoing: state.pendingOutgoing.filter((r) => r.publicKey !== publicKey),
          };
        }),

      unblockUser: (publicKey) =>
        set((state) => ({
          blocked: state.blocked.filter((k) => k !== publicKey),
        })),

      isFriend: (publicKey) => get().friends.some((f) => f.publicKey === publicKey),
      isBlocked: (publicKey) => get().blocked.includes(publicKey),
    }),
    {
      name: 'paracord:friends',
    }
  )
);
