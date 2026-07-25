import { create } from 'zustand';
import type { User, UserSettings } from '../types';
import { authApi } from '../api/auth';
import { extractApiError, refreshSharedSession } from '../api/client';
import {
  clearLegacyPersistedAuth,
  getAccessToken,
  hydrateRefreshTokenStorage,
  setAccessToken,
  setRefreshToken,
} from '../lib/authToken';
import { clearDownloadTicketCache, startDownloadTicketLifecycle } from '../lib/downloadTicket';
import { toast } from './toastStore';
import { useTypingStore } from './typingStore';
import { useReadStateStore } from './readStateStore';
import { useSavedMessageStore } from './savedMessageStore';

function isUnauthorizedError(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 401;
}

interface AuthState {
  token: string | null;
  user: User | null;
  settings: UserSettings | null;
  hasFetchedSettings: boolean;
  sessionBootstrapComplete: boolean;
  isLoading: boolean;
  error: string | null;

  login: (identifier: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string, displayName?: string) => Promise<void>;
  initializeSession: () => Promise<void>;
  setToken: (token: string | null) => void;
  logout: () => Promise<void>;
  fetchUser: () => Promise<void>;
  updateUser: (data: Partial<User>) => Promise<void>;
  fetchSettings: () => Promise<void>;
  updateSettings: (data: Partial<UserSettings>) => Promise<void>;
  clearError: () => void;
}

function clearAuthState(set: (partial: Partial<AuthState>) => void): void {
  setAccessToken(null);
  setRefreshToken(null);
  clearLegacyPersistedAuth();
  clearDownloadTicketCache();
  // Clear per-session transient state so stale typing indicators and their
  // pending expiry timers don't leak into the next session.
  useTypingStore.getState().reset();
  useReadStateStore.getState().reset();
  useSavedMessageStore.getState().reset();
  set({
    token: null,
    user: null,
    settings: null,
    hasFetchedSettings: false,
  });
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: null,
  user: null,
  settings: null,
  hasFetchedSettings: false,
  sessionBootstrapComplete: false,
  isLoading: false,
  error: null,

  login: async (identifier, password) => {
    set({ isLoading: true, error: null });
    try {
      const trimmedIdentifier = identifier.trim();
      const { data } = await authApi.login({
        identifier: trimmedIdentifier,
        password,
      });
      setAccessToken(data.token);
      if (data.refresh_token) setRefreshToken(data.refresh_token);
      set({ token: data.token, user: data.user, isLoading: false });
      startDownloadTicketLifecycle();
    } catch (err: unknown) {
      set({ error: extractApiError(err), isLoading: false });
      throw err;
    }
  },

  register: async (email, username, password, displayName) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await authApi.register({
        email,
        username,
        password,
        display_name: displayName || undefined,
      });
      setAccessToken(data.token);
      if (data.refresh_token) setRefreshToken(data.refresh_token);
      set({ token: data.token, user: data.user, isLoading: false });
      startDownloadTicketLifecycle();
    } catch (err: unknown) {
      set({ error: extractApiError(err), isLoading: false });
      throw err;
    }
  },

  initializeSession: async () => {
    clearLegacyPersistedAuth();
    await hydrateRefreshTokenStorage();
    try {
      // Go through the shared single-flight refresh: the app fires other
      // requests while bootstrapping, and their 401 retry path refreshes the
      // same rotating token. Two independent refreshes meant one of them
      // always lost and logged the user out at random on reload.
      const token = await refreshSharedSession();
      set({ token, sessionBootstrapComplete: true });
      startDownloadTicketLifecycle();
    } catch (err) {
      // Never tear down a session another caller just established: the shared
      // refresh may have succeeded on a concurrent path even though this
      // await rejected.
      const live = getAccessToken();
      if (live) {
        set({ token: live, sessionBootstrapComplete: true });
        startDownloadTicketLifecycle();
        return;
      }
      setAccessToken(null);
      if (isUnauthorizedError(err)) {
        setRefreshToken(null);
      }
      set({ token: null, sessionBootstrapComplete: true });
    }
  },

  setToken: (token) => {
    setAccessToken(token);
    set({ token });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // Best effort: local session should always clear.
    }
    clearAuthState(set);
  },

  fetchUser: async () => {
    try {
      const { data } = await authApi.getMe();
      set({ user: data });
    } catch (err) {
      toast.error(`Failed to load user profile: ${extractApiError(err)}`);
    }
  },

  updateUser: async (userData) => {
    const { data } = await authApi.updateMe(userData);
    set({ user: data });
  },

  fetchSettings: async () => {
    try {
      const { data } = await authApi.getSettings();
      set({ settings: data, hasFetchedSettings: true });
    } catch (err) {
      // Mark as fetched even on failure so consumers don't spin in a refetch
      // loop; surface the failure to the user via a toast.
      set({ hasFetchedSettings: true });
      toast.error(`Failed to load settings: ${extractApiError(err)}`);
    }
  },

  updateSettings: async (settingsData) => {
    const { data } = await authApi.updateSettings(settingsData);
    set({ settings: data, hasFetchedSettings: true });
  },

  clearError: () => set({ error: null }),
}));
