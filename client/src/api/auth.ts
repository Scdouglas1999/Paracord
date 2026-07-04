import { getApi } from './activeClient';
import { signServerChallengeWithUnlockedKey } from '../lib/accountSession';
import { getCurrentOriginServerUrl, getStoredServerUrl } from '../lib/config/apiBaseUrl';
import type { LoginRequest, LoginResponse, RegisterRequest, ReadState, User, UserSettings } from '../types';

interface AuthChallenge {
  nonce: string;
  timestamp: number;
  server_origin: string;
}

async function requestAuthChallenge(): Promise<AuthChallenge> {
  const { data: challenge } = await getApi().post<AuthChallenge>('/auth/challenge');

  const nowMs = Date.now();
  const challengeMs = challenge.timestamp * 1000;
  if (!Number.isFinite(challengeMs) || Math.abs(nowMs - challengeMs) > 120_000) {
    throw new Error('Server challenge timestamp is invalid or stale');
  }

  const serverUrl = getCurrentOriginServerUrl() ?? getStoredServerUrl();
  if (serverUrl) {
    try {
      const expectedOrigin = new URL(serverUrl).origin;
      if (new URL(challenge.server_origin).origin !== expectedOrigin) {
        throw new Error('Server challenge origin mismatch');
      }
    } catch {
      throw new Error('Server challenge origin mismatch');
    }
  }

  return challenge;
}

export interface AuthSession {
  id: string;
  current: boolean;
  device_id?: string | null;
  user_agent?: string | null;
  ip_address?: string | null;
  issued_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface AuthOptions {
  allow_username_login: boolean;
  require_email: boolean;
}

export const authApi = {
  options: () => getApi().get<AuthOptions>('/auth/options'),
  login: (data: LoginRequest) => getApi().post<LoginResponse>('/auth/login', data),
  register: (data: RegisterRequest) => getApi().post<LoginResponse>('/auth/register', data),
  refresh: (refreshToken?: string) =>
    getApi().post<{ token: string; refresh_token?: string }>(
      '/auth/refresh',
      refreshToken ? { refresh_token: refreshToken } : undefined,
    ),
  logout: () => getApi().post('/auth/logout'),
  listSessions: () => getApi().get<AuthSession[]>('/auth/sessions'),
  revokeSession: (sessionId: string) => getApi().delete(`/auth/sessions/${sessionId}`),
  attachPublicKey: async (publicKey: string) => {
    const challenge = await requestAuthChallenge();
    const signature = await signServerChallengeWithUnlockedKey(
      challenge.nonce,
      challenge.timestamp,
      challenge.server_origin,
    );
    return getApi().post<LoginResponse>('/auth/attach-public-key', {
      public_key: publicKey,
      nonce: challenge.nonce,
      timestamp: challenge.timestamp,
      signature,
    });
  },
  getMe: () => getApi().get<User>('/users/@me'),
  updateMe: (data: Partial<User>) => getApi().patch<User>('/users/@me', data),
  getSettings: () => getApi().get<UserSettings>('/users/@me/settings'),
  updateSettings: (data: Partial<UserSettings>) => getApi().patch<UserSettings>('/users/@me/settings', data),
  getReadStates: () => getApi().get<ReadState[]>('/users/@me/read-states'),
  changePassword: (currentPassword: string, newPassword: string) =>
    getApi().put('/users/@me/password', {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  changeEmail: (currentPassword: string, newEmail: string) =>
    getApi().put('/users/@me/email', {
      current_password: currentPassword,
      new_email: newEmail,
    }),
  exportMyData: () => getApi().get<Record<string, unknown>>('/users/@me/data-export'),
  forgotPassword: (identifier: string) =>
    getApi().post<{ message: string }>('/auth/forgot-password', { identifier }),
  resetPassword: (token: string, newPassword: string) =>
    getApi().post<{ message: string }>('/auth/reset-password', { token, new_password: newPassword }),
  verifyEmail: (token: string) =>
    getApi().post<{ message: string }>('/auth/verify-email', { token }),
  mfaStatus: () =>
    getApi().get<{ mfa_enabled: boolean; backup_codes_remaining: number }>('/auth/mfa/status'),
  mfaSetup: () =>
    getApi().post<{ secret: string; otpauth_url: string; qr_code: string }>('/auth/mfa/setup'),
  mfaVerify: (code: string) =>
    getApi().post<{ mfa_enabled: boolean; backup_codes: string[]; message: string }>('/auth/mfa/verify', { code }),
  mfaDisable: (code: string) =>
    getApi().post<{ mfa_enabled: boolean; message: string }>('/auth/mfa/disable', { code }),
  mfaLogin: (ticket: string, code: string) =>
    getApi().post<LoginResponse>('/auth/mfa/login', { ticket, code }),
};
