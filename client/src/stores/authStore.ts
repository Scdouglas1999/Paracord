import { create } from 'zustand';
import type { User, UserSettings } from '../types';
import { authApi } from '../api/auth';
import { extractApiError } from '../api/client';
import { clearLegacyPersistedAuth, getRefreshToken, setAccessToken, setRefreshToken } from '../lib/authToken';
import { toast } from './toastStore';

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
        email: trimmedIdentifier,
        password,
      });
      setAccessToken(data.token);
      if (data.refresh_token) setRefreshToken(data.refresh_token);
      set({ token: data.token, user: data.user, isLoading: false });
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ||
        'Login failed';
      set({ error: message, isLoading: false });
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
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ||
        'Registration failed';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  initializeSession: async () => {
    clearLegacyPersistedAuth();
    try {
      const refreshToken = getRefreshToken();
      const { data } = await authApi.refresh(refreshToken || undefined);
      setAccessToken(data.token);
      if (data.refresh_token) setRefreshToken(data.refresh_token);
      set({ token: data.token, sessionBootstrapComplete: true });
    } catch {
      setAccessToken(null);
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
    } catch {
      set({ hasFetchedSettings: true });
    }
  },

  updateSettings: async (settingsData) => {
    const { data } = await authApi.updateSettings(settingsData);
    set({ settings: data, hasFetchedSettings: true });
  },

  clearError: () => set({ error: null }),
}));
