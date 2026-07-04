import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockAuthApi = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  getMe: vi.fn(),
  updateMe: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../lib/authToken', () => ({
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  getRefreshToken: vi.fn(() => null),
  hydrateRefreshTokenStorage: vi.fn(async () => undefined),
  setRefreshToken: vi.fn(),
  clearLegacyPersistedAuth: vi.fn(),
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('./toastStore', () => ({ toast: mockToast }));

vi.mock('../api/auth', () => ({ authApi: mockAuthApi }));

vi.mock('../api/client', () => ({
  extractApiError: vi.fn(
    (err: { response?: { data?: { message?: string; error?: string } }; message?: string } | unknown) => {
      const e = err as { response?: { data?: { message?: string; error?: string } }; message?: string };
      return (
        e?.response?.data?.message ||
        e?.response?.data?.error ||
        e?.message ||
        'An unexpected error occurred'
      );
    },
  ),
}));

import { useAuthStore } from './authStore';

const fakeUser = {
  id: 'u1',
  username: 'testuser',
  discriminator: '0001',
  bot: false,
  system: false,
  flags: 0,
  created_at: '2025-01-01T00:00:00Z',
};

const fakeSettings = {
  user_id: 'u1',
  theme: 'dark' as const,
  locale: 'en',
  message_display_compact: false,
  status: 'online' as const,
  crypto_auth_enabled: false,
};

describe('authStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      token: null,
      user: null,
      settings: null,
      hasFetchedSettings: false,
      sessionBootstrapComplete: false,
      isLoading: false,
      error: null,
    });
  });

  it('has correct initial state', () => {
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.settings).toBeNull();
    expect(state.hasFetchedSettings).toBe(false);
    expect(state.sessionBootstrapComplete).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  describe('login', () => {
    it('sets token and user on successful login', async () => {
      mockAuthApi.login.mockResolvedValue({
        data: { token: 'tok123', user: fakeUser },
      });

      await useAuthStore.getState().login('test@example.com', 'pass123');
      expect(mockAuthApi.login).toHaveBeenCalledWith({
        identifier: 'test@example.com',
        email: 'test@example.com',
        password: 'pass123',
      });
      const state = useAuthStore.getState();
      expect(state.token).toBe('tok123');
      expect(state.user).toEqual(fakeUser);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets isLoading during login', async () => {
      let resolveLogin: (v: unknown) => void;
      mockAuthApi.login.mockImplementation(
        () => new Promise((resolve) => { resolveLogin = resolve; }),
      );

      const promise = useAuthStore.getState().login('a@b.com', 'pass');
      expect(useAuthStore.getState().isLoading).toBe(true);

      resolveLogin!({ data: { token: 'tok', user: fakeUser } });
      await promise;
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('sets error on failed login', async () => {
      mockAuthApi.login.mockRejectedValue({
        response: { data: { message: 'Invalid credentials' } },
      });

      await expect(
        useAuthStore.getState().login('test@example.com', 'wrong'),
      ).rejects.toBeDefined();

      const state = useAuthStore.getState();
      expect(state.error).toBe('Invalid credentials');
      expect(state.isLoading).toBe(false);
      expect(state.token).toBeNull();
    });

    it('surfaces the underlying error message when the response has no structured message', async () => {
      mockAuthApi.login.mockRejectedValue(new Error('Network error'));

      await expect(
        useAuthStore.getState().login('test@example.com', 'pass'),
      ).rejects.toBeDefined();

      expect(useAuthStore.getState().error).toBe('Network error');
    });
  });

  describe('register', () => {
    it('sets token and user on successful registration', async () => {
      mockAuthApi.register.mockResolvedValue({
        data: { token: 'reg-tok', user: fakeUser },
      });

      await useAuthStore.getState().register('test@example.com', 'testuser', 'pass123', 'Test User');
      const state = useAuthStore.getState();
      expect(state.token).toBe('reg-tok');
      expect(state.user).toEqual(fakeUser);
      expect(state.isLoading).toBe(false);
    });

    it('sets error on failed registration', async () => {
      mockAuthApi.register.mockRejectedValue({
        response: { data: { message: 'Email already exists' } },
      });

      await expect(
        useAuthStore.getState().register('dup@example.com', 'user', 'pass'),
      ).rejects.toBeDefined();

      expect(useAuthStore.getState().error).toBe('Email already exists');
    });

    it('surfaces the underlying error message when the response has no structured message', async () => {
      mockAuthApi.register.mockRejectedValue(new Error('timeout'));

      await expect(
        useAuthStore.getState().register('a@b.com', 'u', 'p'),
      ).rejects.toBeDefined();

      expect(useAuthStore.getState().error).toBe('timeout');
    });
  });

  describe('logout', () => {
    it('clears auth state after logout', async () => {
      useAuthStore.setState({ token: 'tok', user: fakeUser, settings: fakeSettings });
      mockAuthApi.logout.mockResolvedValue({});

      await useAuthStore.getState().logout();
      const state = useAuthStore.getState();
      expect(state.token).toBeNull();
      expect(state.user).toBeNull();
      expect(state.settings).toBeNull();
      expect(state.hasFetchedSettings).toBe(false);
    });

    it('clears auth state even if logout API fails', async () => {
      useAuthStore.setState({ token: 'tok', user: fakeUser });
      mockAuthApi.logout.mockRejectedValue(new Error('Network error'));

      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().token).toBeNull();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('fetchUser', () => {
    it('sets user on successful fetch', async () => {
      mockAuthApi.getMe.mockResolvedValue({ data: fakeUser });

      await useAuthStore.getState().fetchUser();
      expect(useAuthStore.getState().user).toEqual(fakeUser);
    });

    it('shows toast on fetch failure', async () => {
      mockAuthApi.getMe.mockRejectedValue(new Error('fail'));

      await useAuthStore.getState().fetchUser();
      expect(mockToast.error).toHaveBeenCalled();
    });
  });

  describe('updateUser', () => {
    it('updates user data', async () => {
      const updatedUser = { ...fakeUser, display_name: 'New Name' };
      mockAuthApi.updateMe.mockResolvedValue({ data: updatedUser });

      await useAuthStore.getState().updateUser({ display_name: 'New Name' });
      expect(useAuthStore.getState().user).toEqual(updatedUser);
    });
  });

  describe('fetchSettings', () => {
    it('sets settings on success', async () => {
      mockAuthApi.getSettings.mockResolvedValue({ data: fakeSettings });

      await useAuthStore.getState().fetchSettings();
      const state = useAuthStore.getState();
      expect(state.settings).toEqual(fakeSettings);
      expect(state.hasFetchedSettings).toBe(true);
    });

    it('marks hasFetchedSettings true even on failure', async () => {
      mockAuthApi.getSettings.mockRejectedValue(new Error('fail'));

      await useAuthStore.getState().fetchSettings();
      expect(useAuthStore.getState().hasFetchedSettings).toBe(true);
      expect(useAuthStore.getState().settings).toBeNull();
    });
  });

  describe('updateSettings', () => {
    it('updates settings', async () => {
      const updatedSettings = { ...fakeSettings, theme: 'light' as const };
      mockAuthApi.updateSettings.mockResolvedValue({ data: updatedSettings });

      await useAuthStore.getState().updateSettings({ theme: 'light' });
      const state = useAuthStore.getState();
      expect(state.settings).toEqual(updatedSettings);
      expect(state.hasFetchedSettings).toBe(true);
    });
  });

  describe('initializeSession', () => {
    it('sets token from refresh on success', async () => {
      mockAuthApi.refresh.mockResolvedValue({ data: { token: 'refreshed-tok' } });

      await useAuthStore.getState().initializeSession();
      const state = useAuthStore.getState();
      expect(state.token).toBe('refreshed-tok');
      expect(state.sessionBootstrapComplete).toBe(true);
    });

    it('clears token and marks complete on refresh failure', async () => {
      mockAuthApi.refresh.mockRejectedValue(new Error('no cookie'));

      await useAuthStore.getState().initializeSession();
      const state = useAuthStore.getState();
      expect(state.token).toBeNull();
      expect(state.sessionBootstrapComplete).toBe(true);
    });
  });

  describe('setToken', () => {
    it('sets the token', () => {
      useAuthStore.getState().setToken('new-token');
      expect(useAuthStore.getState().token).toBe('new-token');
    });

    it('clears the token with null', () => {
      useAuthStore.setState({ token: 'old' });
      useAuthStore.getState().setToken(null);
      expect(useAuthStore.getState().token).toBeNull();
    });
  });

  describe('clearError', () => {
    it('clears the error', () => {
      useAuthStore.setState({ error: 'some error' });
      useAuthStore.getState().clearError();
      expect(useAuthStore.getState().error).toBeNull();
    });
  });
});
