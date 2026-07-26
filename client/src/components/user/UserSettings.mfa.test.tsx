import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../../api/auth';
import { useAuthStore } from '../../stores/authStore';
import { UserSettings } from './UserSettings';

const mockAuthState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  settings: null as Record<string, unknown> | null,
  fetchSettings: vi.fn(),
  fetchUser: vi.fn(),
  updateSettings: vi.fn(),
  updateUser: vi.fn(),
  logout: vi.fn(),
}));

const mockUiState = vi.hoisted(() => ({
  userSettingsInitialSection: null,
  setTheme: vi.fn(),
  lowBandwidthMode: false,
  setLowBandwidthMode: vi.fn(),
  customCss: '',
  setCustomCss: vi.fn(),
}));

const mockMediaDevices = vi.hoisted(() => ({
  audioInputDevices: [],
  audioOutputDevices: [],
  videoInputDevices: [],
  selectedAudioInput: '',
  selectedAudioOutput: '',
  selectedVideoInput: '',
  selectAudioInput: vi.fn(),
  selectAudioOutput: vi.fn(),
  selectVideoInput: vi.fn(),
  enumerate: vi.fn(),
}));

const mockVoiceState = vi.hoisted(() => ({
  applyAudioInputDevice: vi.fn(),
  applyAudioOutputDevice: vi.fn(),
}));

vi.mock('../../stores/authStore', () => {
  const useAuthStore = (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState);
  useAuthStore.setState = (partial: Partial<typeof mockAuthState>) => Object.assign(mockAuthState, partial);
  return { useAuthStore };
});

vi.mock('../../api/auth', () => ({
  authApi: {
    exportMyData: vi.fn(),
    getReadStates: vi.fn(),
    listSessions: vi.fn(),
    mfaDisable: vi.fn(),
    mfaSetup: vi.fn(),
    mfaStatus: vi.fn(),
    mfaVerify: vi.fn(),
    revokeSession: vi.fn(),
  },
}));

vi.mock('../../api/admin', () => ({
  adminApi: {
    getSettings: vi.fn(),
    reloadSettings: vi.fn(),
    restartServer: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
  extractApiError: (err: unknown) => {
    const maybeResponse = err as { response?: { data?: { message?: string; error?: string } } };
    return maybeResponse.response?.data?.message
      ?? maybeResponse.response?.data?.error
      ?? (err instanceof Error ? err.message : 'Request failed');
  },
}));

vi.mock('../../stores/accountStore', () => ({
  useAccountStore: (selector: (state: { publicKey: string | null; isUnlocked: boolean }) => unknown) =>
    selector({ publicKey: null, isUnlocked: false }),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockUiState),
}));

vi.mock('../../hooks/useMediaDevices', () => ({
  useMediaDevices: () => mockMediaDevices,
}));

vi.mock('../../hooks/useMobile', () => ({
  useMobile: () => false,
}));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockVoiceState),
}));

vi.mock('../../lib/features/notifications', () => ({
  isEnabled: vi.fn(() => false),
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve(false)),
  setEnabled: vi.fn(),
}));

vi.mock('../../lib/account', () => ({
  hasAccount: vi.fn(() => false),
}));

vi.mock('../../api/activeClient', () => ({
  getApi: () => ({ delete: vi.fn(), post: vi.fn() }),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../lib/security', () => ({
  isAllowedImageMimeType: vi.fn(() => true),
  safeExternalUrl: vi.fn((value: string) => value),
}));

vi.mock('../../lib/userAvatar', () => ({ resolveUserAvatarUrl: vi.fn(() => null) }));
vi.mock('../../lib/displayName', () => ({ displayName: vi.fn((user: { username?: string } | null) => user?.username ?? '') }));
vi.mock('../../lib/keyboardShortcuts', () => ({ formatShortcut: vi.fn((value: string) => value) }));

vi.mock('../../lib/activityPresence', () => ({
  getKnownActivityAppsFromStorage: vi.fn(() => []),
  normalizeDetectedAppId: (value: string) => value,
  readStringArray: vi.fn(() => []),
  readableAppName: (value: string) => value,
  saveKnownActivityAppsToStorage: vi.fn(),
}));

vi.mock('../../lib/keyVerification', () => ({
  formatIdentityFingerprint: vi.fn(() => 'ABCD EFGH'),
}));

vi.mock('../customization/CustomCSS', () => ({
  CustomCSS: () => null,
}));

vi.mock('../customization/ThemeSelector', () => ({
  ThemeSelector: () => null,
}));

const apiError = (message: string) => ({
  response: {
    data: { message },
  },
});

describe('UserSettings MFA controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.listSessions).mockResolvedValue({ data: [] } as never);
    vi.mocked(authApi.mfaStatus).mockResolvedValue({
      data: { mfa_enabled: false, backup_codes_remaining: 0 },
    } as never);
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'Ada',
        discriminator: 1,
        email: 'ada@example.com',
        flags: 0,
        bot: false,
        system: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      settings: {
        user_id: 'user-1',
        theme: 'dark',
        locale: 'en-US',
        message_display_compact: false,
        status: 'online',
        notifications: {},
        keybinds: {},
        crypto_auth_enabled: false,
      },
      fetchSettings: vi.fn().mockResolvedValue(undefined),
      fetchUser: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      updateUser: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('enables MFA and shows one-time backup codes', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.mfaSetup).mockResolvedValue({
      data: {
        secret: 'totp-secret',
        otpauth_url: 'otpauth://totp/Paracord:Ada',
        qr_code: 'data:image/png;base64,abc',
      },
    } as never);
    vi.mocked(authApi.mfaVerify).mockResolvedValue({
      data: {
        mfa_enabled: true,
        backup_codes: ['backup-1', 'backup-2'],
        message: 'MFA enabled.',
      },
    } as never);

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Enable 2FA' }));
    expect(await screen.findByText('totp-secret')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Authenticator code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm & Enable' }));

    await waitFor(() => expect(authApi.mfaVerify).toHaveBeenCalledWith('123456'));
    expect(await screen.findByText('Two-factor authentication enabled.')).toBeInTheDocument();
    expect(screen.getByText('backup-1')).toBeInTheDocument();
    expect(screen.getByText('backup-2')).toBeInTheDocument();
  });

  it('shows API detail when MFA setup cannot start', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.mfaSetup).mockRejectedValue(apiError('TOTP setup is temporarily unavailable.'));

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Enable 2FA' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to start MFA setup: TOTP setup is temporarily unavailable.',
    );
  });

  it('shows API detail when MFA verification fails', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.mfaSetup).mockResolvedValue({
      data: {
        secret: 'totp-secret',
        otpauth_url: 'otpauth://totp/Paracord:Ada',
        qr_code: 'data:image/png;base64,abc',
      },
    } as never);
    vi.mocked(authApi.mfaVerify).mockRejectedValue(apiError('Authenticator code expired.'));

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Enable 2FA' }));
    await user.type(await screen.findByRole('textbox', { name: 'Authenticator code' }), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm & Enable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to verify MFA setup: Authenticator code expired.',
    );
  });

  it('disables MFA with a TOTP or backup code', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.mfaStatus).mockResolvedValue({
      data: { mfa_enabled: true, backup_codes_remaining: 3 },
    } as never);
    vi.mocked(authApi.mfaDisable).mockResolvedValue({
      data: { mfa_enabled: false, message: 'MFA disabled.' },
    } as never);

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/Enabled\. 3 backup codes remaining\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Disable 2FA' }));
    await user.type(screen.getByRole('textbox', { name: 'Current TOTP or backup code' }), 'backup-1');
    await user.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => expect(authApi.mfaDisable).toHaveBeenCalledWith('backup-1'));
    expect(await screen.findByText('Two-factor authentication disabled.')).toBeInTheDocument();
  });

  it('shows API detail when disabling MFA fails', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.mfaStatus).mockResolvedValue({
      data: { mfa_enabled: true, backup_codes_remaining: 3 },
    } as never);
    vi.mocked(authApi.mfaDisable).mockRejectedValue(apiError('Backup code has already been used.'));

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/Enabled\. 3 backup codes remaining\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Disable 2FA' }));
    await user.type(screen.getByRole('textbox', { name: 'Current TOTP or backup code' }), 'backup-1');
    await user.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to disable MFA: Backup code has already been used.',
    );
  });

  it('shows API detail when loading MFA status fails', async () => {
    vi.mocked(authApi.mfaStatus).mockRejectedValue(apiError('MFA service is unavailable.'));

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load MFA status: MFA service is unavailable.',
    );
  });

  it('shows API detail when saving profile fails', async () => {
    const user = userEvent.setup();
    const updateUser = vi.fn().mockRejectedValue(apiError('Display name contains blocked text.'));
    useAuthStore.setState({ updateUser });

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Save Profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to update profile: Display name contains blocked text.',
    );
  });

  it('shows API detail when saving settings fails', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn().mockRejectedValue(apiError('Locale is not supported.'));
    useAuthStore.setState({ updateSettings });

    render(
      <MemoryRouter>
        <UserSettings onClose={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(await screen.findByRole('button', { name: 'Save Appearance' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to save settings: Locale is not supported.',
    );
  });
});
