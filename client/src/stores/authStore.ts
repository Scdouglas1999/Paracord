import { create } from 'zustand';
import type { User, UserSettings } from '../types';
import { authApi } from '../api/auth';
import { canAttemptRefresh, extractApiError, refreshSharedSession } from '../api/client';
import {
  clearLegacyPersistedAuth,
  clearSessionHint,
  getAccessToken,
  getRefreshToken,
  hasSessionHint,
  hydrateRefreshTokenStorage,
  setAccessToken,
  setRefreshToken,
} from '../lib/authToken';
import { resetRefreshCoordination } from '../lib/authRefreshCoordinator';
import { clearSessionEndedNotice } from '../lib/sessionEnded';
import { clearDownloadTicketCache, startDownloadTicketLifecycle } from '../lib/downloadTicket';
import { clearAuthenticatedImageCache } from '../lib/authenticatedImage';
import { clearPermissionDataCache } from '../lib/permissionDataCache';
import { invalidateGuildPermissionCache } from '../hooks/usePermissions';
import { toast } from './toastStore';
import { useTypingStore } from './typingStore';
import { useReadStateStore } from './readStateStore';
import { useSavedMessageStore } from './savedMessageStore';
import { clearUnlockedPrivateKey } from '../lib/accountSession';
import { resetSessionStores } from './sessionReset';

function isUnauthorizedError(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 401;
}

interface AuthState {
  token: string | null;
  user: User | null;
  settings: UserSettings | null;
  hasFetchedSettings: boolean;
  /**
   * The last settings read failed and we still have no answer.
   *
   * Kept apart from `hasFetchedSettings` on purpose: `crypto_auth_enabled`
   * lives in these settings, and a request that failed is not the answer
   * "false". Consumers that gate on a security setting must be able to tell
   * "off" from "we do not know" — see `ProtectedRoute`.
   */
  settingsUnavailable: boolean;
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

/**
 * Tear down the local session. Returns the store-reset promise so `logout` can
 * await it — voice teardown is async, and a caller that navigates immediately
 * must not race a half-disconnected room.
 */
function clearAuthState(set: (partial: Partial<AuthState>) => void): Promise<void> {
  setAccessToken(null);
  setRefreshToken(null);
  // Before anything else, and synchronously: the device key is a credential in
  // its own right. The registered `account-identity` reset flips the store flag,
  // but the resets run concurrently and the gateway reacts to the *first* of
  // them, so the key itself goes here — otherwise the sign-out race is won by a
  // challenge-response that signs the account straight back in.
  clearUnlockedPrivateKey();
  // Forget the ended session's in-flight and recently-settled refreshes, so
  // the next sign-in is never answered out of the previous one's window.
  resetRefreshCoordination();
  clearSessionHint();
  clearLegacyPersistedAuth();
  clearDownloadTicketCache();
  // The resolved avatars, emoji and stickers of the account that just left —
  // real image bytes, held as object URLs — must not survive into the next
  // sign-in on this device.
  clearAuthenticatedImageCache();
  // Clear per-session transient state so stale typing indicators and their
  // pending expiry timers don't leak into the next session.
  useTypingStore.getState().reset();
  useReadStateStore.getState().reset();
  useSavedMessageStore.getState().reset();
  // Every store that caches another user's data must be cleared here too.
  // Only the three above were, so logging out and back in as someone else left
  // the previous account's guilds, channels, messages, members and presences
  // on screen — there is no reload to save us.
  //
  // Dispatched through the reset registry rather than importing each store:
  // `messageStore` imports `authStore` (a cycle), and `authStore` is in the
  // eager startup chain, so importing `voiceStore` here would pull
  // `livekit-client` into the login-screen bundle. See `sessionReset`.
  //
  // Voice teardown is async (room disconnect, mic release); every synchronous
  // reset has already run by the time this returns, and `logout` awaits the
  // rest. `resetSessionStores` swallows individual failures so one store
  // cannot leave the user half-signed-out.
  const pending = resetSessionStores();
  clearPermissionDataCache();
  invalidateGuildPermissionCache();
  set({
    token: null,
    user: null,
    settings: null,
    hasFetchedSettings: false,
    settingsUnavailable: false,
  });
  return pending;
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: null,
  user: null,
  settings: null,
  hasFetchedSettings: false,
  settingsUnavailable: false,
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
      resetRefreshCoordination();
      setAccessToken(data.token);
      setRefreshToken(data.refresh_token ?? null);
      clearSessionEndedNotice();
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
      resetRefreshCoordination();
      setAccessToken(data.token);
      setRefreshToken(data.refresh_token ?? null);
      clearSessionEndedNotice();
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
    // A browser that has never held a session here has nothing to refresh. It
    // used to ask anyway on every cold load, which is a console error for the
    // visitor and a WARN in the operator's log for every anonymous page view.
    // Nothing to ask with. On the desktop the only credential that survives a
    // quit is the stored refresh token — the page is `tauri://localhost`, so
    // the instance's HttpOnly refresh cookie is never sent — and a refresh with
    // an empty body is a 400, not an expired session. In a browser the cookie
    // may still carry it, so there the hint alone is reason enough to ask.
    if (!canAttemptRefresh(getRefreshToken()) || (!hasSessionHint() && !getRefreshToken())) {
      set({ token: null, sessionBootstrapComplete: true });
      return;
    }
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
        // The server has spoken: there is no session behind this origin's
        // cookies. Stop asking on every load until one is established again.
        clearSessionHint();
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
    await clearAuthState(set);
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
      set({ settings: data, hasFetchedSettings: true, settingsUnavailable: false });
    } catch (err) {
      // A request that failed is not an answer. This used to set
      // `hasFetchedSettings: true` anyway, so `crypto_auth_enabled` read as
      // `false` and the device-key gate in `ProtectedRoute` was skipped
      // entirely — a security control that was ON server-side was bypassed
      // because one GET returned 401. Record the failure as a failure and let
      // the consumer decide; the gate now fails closed on an unknown.
      // Say it once. `ProtectedRoute` retries this on a timer while the answer
      // is missing, and a toast per attempt is a stack of identical red cards
      // over an app that is already telling the user it cannot get in.
      const alreadyReported = useAuthStore.getState().settingsUnavailable;
      set({ settingsUnavailable: true });
      if (!alreadyReported) toast.error(`Failed to load settings: ${extractApiError(err)}`);
    }
  },

  updateSettings: async (settingsData) => {
    const { data } = await authApi.updateSettings(settingsData);
    set({ settings: data, hasFetchedSettings: true, settingsUnavailable: false });
  },

  clearError: () => set({ error: null }),
}));
