import { apiClient } from './client';
import type { LoginRequest, LoginResponse, RegisterRequest, ReadState, User, UserSettings } from '../types';

export const authApi = {
  login: (data: LoginRequest) => apiClient.post<LoginResponse>('/auth/login', data),
  register: (data: RegisterRequest) => apiClient.post<LoginResponse>('/auth/register', data),
  refresh: () => apiClient.post<{ token: string }>('/auth/refresh'),
  attachPublicKey: (publicKey: string) =>
    apiClient.post<LoginResponse>('/auth/attach-public-key', { public_key: publicKey }),
  getMe: () => apiClient.get<User>('/users/@me'),
  updateMe: (data: Partial<User>) => apiClient.patch<User>('/users/@me', data),
  getSettings: () => apiClient.get<UserSettings>('/users/@me/settings'),
  updateSettings: (data: Partial<UserSettings>) => apiClient.patch<UserSettings>('/users/@me/settings', data),
  getReadStates: () => apiClient.get<ReadState[]>('/users/@me/read-states'),
};
