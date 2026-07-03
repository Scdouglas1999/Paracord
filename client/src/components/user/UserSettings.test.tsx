import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi, type AuthSession } from '../../api/auth';
import { confirm } from '../../stores/confirmStore';
import { useAuthStore } from '../../stores/authStore';
import { UserSettings } from './UserSettings';

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
  apiClient: { get: vi.fn(), post: vi.fn() },
  extractApiError: (err: unknown) => {
    const maybeResponse = err as { response?: { data?: { message?: string; error?: string } } };
    return maybeResponse.response?.data?.message
      ?? maybeResponse.response?.data?.error
      ?? (err instanceof Error ? err.message : 'Request failed');
  },
}));

vi.mock('../../stores/confirmStore', () => ({ confirm: vi.fn() }));

vi.mock('../../hooks/useMediaDevices', () => ({
  useMediaDevices: () => ({
    audioInputDevices: [],
    audioOutputDevices: [],
    selectedAudioInput: '',
    selectedAudioOutput: '',
    selectAudioInput: vi.fn(),
    selectAudioOutput: vi.fn(),
    enumerate: vi.fn(),
  }),
}));

vi.mock('../../hooks/useMobile', () => ({ useMobile: () => false }));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ applyAudioInputDevice: vi.fn(), applyAudioOutputDevice: vi.fn() }),
}));

vi.mock('../../lib/features/notifications', () => ({
  isEnabled: vi.fn(() => false),
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve(false)),
  setEnabled: vi.fn(),
}));

vi.mock('../../lib/account', () => ({ hasAccount: vi.fn(() => false) }));

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

vi.mock('../customization/CustomCSS', () => ({ CustomCSS: () => null }));
vi.mock('../customization/ThemeSelector', () => ({ ThemeSelector: () => null }));

const makeSession = (overrides: Partial<AuthSession> = {}): AuthSession => ({
  id: 'sess-1',
  current: false,
  device_id: 'device',
  user_agent: 'Firefox on Linux',
  ip_address: '10.0.0.1',
  issued_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-02T00:00:00.000Z',
  expires_at: '2026-02-01T00:00:00.000Z',
  ...overrides,
});

const currentSession = makeSession({ id: 'sess-current', current: true, user_agent: 'This device' });
const otherSession = makeSession({ id: 'sess-other', current: false, user_agent: 'Old laptop' });

const logout = vi.fn().mockResolvedValue(undefined);

const renderSettings = (onClose = vi.fn()) =>
  render(
    <MemoryRouter>
      <UserSettings onClose={onClose} />
    </MemoryRouter>,
  );

describe('UserSettings session management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logout.mockResolvedValue(undefined);
    vi.mocked(authApi.listSessions).mockResolvedValue({ data: [currentSession, otherSession] } as never);
    vi.mocked(authApi.revokeSession).mockResolvedValue({ data: {} } as never);
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
      logout,
    });
  });

  it('does not revoke a session when the confirm dialog is cancelled', async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(false);
    renderSettings();

    // Sessions render in list order [current, other]; target the non-current row.
    await screen.findByText('Old laptop');
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[1]);

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(authApi.revokeSession).not.toHaveBeenCalled();
    // Row remains present since nothing was revoked.
    expect(screen.getByText('Old laptop')).toBeInTheDocument();
  });

  it('revokes the selected session once confirmed', async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(true);
    renderSettings();

    await screen.findByText('Old laptop');
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[1]);

    await waitFor(() => expect(authApi.revokeSession).toHaveBeenCalledWith('sess-other'));
    expect(authApi.revokeSession).toHaveBeenCalledTimes(1);
    // Revoked row is dropped from the list; success feedback is shown.
    await waitFor(() => expect(screen.queryByText('Old laptop')).not.toBeInTheDocument());
    expect(screen.getByText('Session revoked.')).toBeInTheDocument();
  });

  it('logs out and closes the panel from the Log Out control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSettings(onClose);

    await user.click(await screen.findByRole('button', { name: 'Log Out' }));

    expect(logout).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Logout is not gated behind the confirm dialog.
    expect(confirm).not.toHaveBeenCalled();
  });
});
