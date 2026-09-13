import { getServerApi } from './activeClient';
import { LOCAL_SERVER_ID } from '../lib/serverScope';

// authStore owns the home session. Selecting a remote server must never change
// where login, profile editing, passwords or account recovery are sent.
const getApi = () => getServerApi(LOCAL_SERVER_ID);
import { responseContract } from './responseContracts';
import {
  isCurrentUser,
  isUpdatedCurrentUser,
  isUserSettingsResponse,
} from './generated/validators';
import type { UpdateMeRequest } from './generated/UpdateMeRequest';
import type { UpdateSettingsRequest } from './generated/UpdateSettingsRequest';
import type { LoginRequest, LoginResponse, RegisterRequest } from '../types';

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
  options: async () => getApi().get<AuthOptions>('/auth/options'),
  login: async (data: LoginRequest) => getApi().post<LoginResponse>('/auth/login', data),
  register: async (data: RegisterRequest) => getApi().post<LoginResponse>('/auth/register', data),
  refresh: async (refreshToken?: string) =>
    getApi().post<{ token: string; refresh_token?: string }>(
      '/auth/refresh',
      refreshToken ? { refresh_token: refreshToken } : undefined,
    ),
  logout: async () => getApi().post('/auth/logout'),
  listSessions: async () => getApi().get<AuthSession[]>('/auth/sessions'),
  revokeSession: async (sessionId: string) => getApi().delete(`/auth/sessions/${sessionId}`),
  /** Remove the attached key, revoking every session in the process. */
  detachPublicKey: async (password: string, mfaCode?: string) =>
    getApi().post('/auth/attach-public-key', {
      detach: true,
      password,
      ...(mfaCode ? { mfa_code: mfaCode } : {}),
    }),
  getMe: async () =>
    responseContract(getApi().get('/users/@me'), isCurrentUser, 'CurrentUser'),
  updateMe: async (data: UpdateMeRequest) =>
    responseContract(getApi().patch('/users/@me', data), isUpdatedCurrentUser, 'UpdatedCurrentUser'),
  uploadAvatar: async (file: File) => {
    const form = new FormData();
    form.append('avatar', file);
    return responseContract(
      getApi().post('/users/@me/avatar', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
      isUpdatedCurrentUser,
      'UpdatedCurrentUser',
    );
  },
  getSettings: async () =>
    responseContract(getApi().get('/users/@me/settings'), isUserSettingsResponse, 'UserSettingsResponse'),
  updateSettings: async (data: UpdateSettingsRequest) =>
    responseContract(
      getApi().patch('/users/@me/settings', data),
      isUserSettingsResponse,
      'UserSettingsResponse',
    ),
  changePassword: async (currentPassword: string, newPassword: string) =>
    getApi().put('/users/@me/password', {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  changeEmail: async (currentPassword: string, newEmail: string) =>
    getApi().put('/users/@me/email', {
      current_password: currentPassword,
      new_email: newEmail,
    }),
  exportMyData: async () => getApi().get<Record<string, unknown>>('/users/@me/data-export'),
  forgotPassword: async (identifier: string) =>
    getApi().post<{ message: string }>('/auth/forgot-password', { identifier }),
  resetPassword: async (token: string, newPassword: string) =>
    getApi().post<{ message: string }>('/auth/reset-password', { token, new_password: newPassword }),
  verifyEmail: async (token: string) =>
    getApi().post<{ message: string }>('/auth/verify-email', { token }),
  mfaStatus: async () =>
    getApi().get<{ mfa_enabled: boolean; backup_codes_remaining: number }>('/auth/mfa/status'),
  mfaSetup: async () =>
    getApi().post<{ secret: string; otpauth_url: string; qr_code: string }>('/auth/mfa/setup'),
  mfaVerify: async (code: string) =>
    getApi().post<{ mfa_enabled: boolean; backup_codes: string[]; message: string }>('/auth/mfa/verify', { code }),
  mfaDisable: async (code: string) =>
    getApi().post<{ mfa_enabled: boolean; message: string }>('/auth/mfa/disable', { code }),
  mfaLogin: async (ticket: string, code: string) =>
    getApi().post<LoginResponse>('/auth/mfa/login', { ticket, code }),
};
