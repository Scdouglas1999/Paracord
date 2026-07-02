import { apiClient } from './client';
import type { LoginRequest, LoginResponse, RegisterRequest, ReadState, User, UserSettings } from '../types';

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
  options: () => apiClient.get<AuthOptions>('/auth/options'),
  login: (data: LoginRequest) => apiClient.post<LoginResponse>('/auth/login', data),
  register: (data: RegisterRequest) => apiClient.post<LoginResponse>('/auth/register', data),
  refresh: (refreshToken?: string) =>
    apiClient.post<{ token: string; refresh_token?: string }>(
      '/auth/refresh',
      refreshToken ? { refresh_token: refreshToken } : undefined,
    ),
  logout: () => apiClient.post('/auth/logout'),
  listSessions: () => apiClient.get<AuthSession[]>('/auth/sessions'),
  revokeSession: (sessionId: string) => apiClient.delete(`/auth/sessions/${sessionId}`),
  attachPublicKey: (publicKey: string) =>
    apiClient.post<LoginResponse>('/auth/attach-public-key', { public_key: publicKey }),
  getMe: () => apiClient.get<User>('/users/@me'),
  updateMe: (data: Partial<User>) => apiClient.patch<User>('/users/@me', data),
  getSettings: () => apiClient.get<UserSettings>('/users/@me/settings'),
  updateSettings: (data: Partial<UserSettings>) => apiClient.patch<UserSettings>('/users/@me/settings', data),
  getReadStates: () => apiClient.get<ReadState[]>('/users/@me/read-states'),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.put('/users/@me/password', {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  changeEmail: (currentPassword: string, newEmail: string) =>
    apiClient.put('/users/@me/email', {
      current_password: currentPassword,
      new_email: newEmail,
    }),
  exportMyData: () => apiClient.get<Record<string, unknown>>('/users/@me/data-export'),
  forgotPassword: (identifier: string) =>
    apiClient.post<{ message: string }>('/auth/forgot-password', { identifier }),
  resetPassword: (token: string, newPassword: string) =>
    apiClient.post<{ message: string }>('/auth/reset-password', { token, new_password: newPassword }),
  verifyEmail: (token: string) =>
    apiClient.post<{ message: string }>('/auth/verify-email', { token }),
  mfaStatus: () =>
    apiClient.get<{ mfa_enabled: boolean; backup_codes_remaining: number }>('/auth/mfa/status'),
  mfaSetup: () =>
    apiClient.post<{ secret: string; otpauth_url: string; qr_code: string }>('/auth/mfa/setup'),
  mfaVerify: (code: string) =>
    apiClient.post<{ mfa_enabled: boolean; backup_codes: string[]; message: string }>('/auth/mfa/verify', { code }),
  mfaDisable: (code: string) =>
    apiClient.post<{ mfa_enabled: boolean; message: string }>('/auth/mfa/disable', { code }),
  mfaLogin: (ticket: string, code: string) =>
    apiClient.post<LoginResponse>('/auth/mfa/login', { ticket, code }),
};
