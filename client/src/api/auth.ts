import { getServerApi } from './activeClient';
import { LOCAL_SERVER_ID } from '../lib/serverScope';

// authStore owns the home session. Selecting a remote server must never change
// where login, profile editing, passwords or account recovery are sent.
const getApi = () => getServerApi(LOCAL_SERVER_ID);
import { refreshSharedSession } from './client';
import { responseContract } from './responseContracts';
import {
  isCurrentUser,
  isUpdatedCurrentUser,
  isUserSettingsResponse,
} from './contractValidators';
import type { UpdateMeRequest } from './generated/UpdateMeRequest';
import type { UpdateSettingsRequest } from './generated/UpdateSettingsRequest';
import type { LoginRequest, LoginResponse, RegisterRequest } from '../types';
import type { CredentialParams } from './generated/CredentialParams';
import type { CredentialRegister } from './generated/CredentialRegister';
import type { CredentialUpgradeRequest } from './generated/CredentialUpgradeRequest';
import type { ChangeCredentialRequest } from './generated/ChangeCredentialRequest';
import type { ResetCredentialRequest } from './generated/ResetCredentialRequest';
import type { CredentialEmailResetRequest } from './generated/CredentialEmailResetRequest';
import type { CredentialEpochResponse } from './generated/CredentialEpochResponse';
import type { KeyBackup } from './generated/KeyBackup';
import type { AuthChallenge } from '../lib/credential/proofs';

/**
 * Session routes that answer 401 for a wrong credential (not an expired
 * session). Without this the shared interceptor would read a mistyped
 * password as "the session is gone" and sign the person out.
 */
const credentialStatus = { validateStatus: (status: number) => (status >= 200 && status < 300) || status === 401 };

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

/** Who can create an account on a server. */
export type RegistrationMode = 'invite_only' | 'open';

export interface AuthOptions {
  allow_username_login: boolean;
  require_email: boolean;
  /** False when the server takes no new accounts at all. Absent before 3.2. */
  registration_enabled?: boolean;
  /** Whether a new account needs an invite. Absent before 3.2 (open). */
  registration_mode?: RegistrationMode;
  /** 2 on servers with one-password sign-in (docs/setup-spec.md §3.12). Absent on older servers. */
  credential_version?: number;
  /** The one password's minimum length in UTF-8 bytes (2 and later). */
  min_password_length?: number;
}

export const authApi = {
  options: async () => getApi().get<AuthOptions>('/auth/options'),
  login: async (data: LoginRequest) => getApi().post<LoginResponse>('/auth/login', data),
  register: async (data: RegisterRequest) => getApi().post<LoginResponse>('/auth/register', data),
  /** `POST /auth/challenge`: a single-use nonce to sign (key sign-in and credential proofs). */
  challenge: async () => getApi().post<AuthChallenge>('/auth/challenge'),
  /** `POST /auth/verify`: key sign-in (signature over the challenge). May answer with an MFA ticket. */
  verifyKey: async (data: { public_key: string; nonce: string; timestamp: number; signature: string; username: string }) =>
    getApi().post<LoginResponse>('/auth/verify', data),
  // ── One password (docs/setup-spec.md §3, §9.1) ──────────────────────────
  credentialParams: async (identifier: string) =>
    getApi().post<CredentialParams>('/auth/credential/params', { identifier }),
  credentialRegister: async (data: CredentialRegister) =>
    getApi().post<LoginResponse>('/auth/credential/register', data),
  credentialLogin: async (identifier: string, authKey: string) =>
    getApi().post<LoginResponse>('/auth/credential/login', { identifier, auth_key: authKey }),
  /** The v1 → one-password move. 401 (wrong legacy password) is returned, not thrown. */
  credentialUpgrade: async (data: CredentialUpgradeRequest) =>
    getApi().post<CredentialEpochResponse>('/auth/credential/upgrade', data, credentialStatus),
  /** Change the one password. 401 (wrong current password or code) is returned, not thrown. */
  changeCredential: async (data: ChangeCredentialRequest) =>
    getApi().put<CredentialEpochResponse>('/users/@me/credential', data, credentialStatus),
  /** New password after a recovery-phrase sign-in. 401 is returned, not thrown. */
  resetCredential: async (data: ResetCredentialRequest) =>
    getApi().post<CredentialEpochResponse>('/users/@me/credential/reset', data, credentialStatus),
  keyBackup: async () => getApi().get<KeyBackup>('/users/@me/key-backup'),
  confirmRecoverySaved: async () => getApi().post('/users/@me/key-backup/recovery-confirmed'),
  /** "Start over" (§3.9): the email-reset token with a brand-new credential and identity. */
  resetPasswordStartOver: async (data: CredentialEmailResetRequest) =>
    getApi().post<{ epoch: number; message: string }>('/auth/reset-password', data),
  /**
   * Refresh the home session.
   *
   * Delegates to the shared single-flight rather than posting `/auth/refresh`
   * itself. A fourth independent lane onto a rotating, reuse-detected
   * credential is how this app used to revoke its own sessions mid-use: the
   * loser of the race presents a spent token, the server reads that as theft,
   * and every session the account has is revoked. There is exactly one lane.
   */
  refresh: async () => ({ data: { token: await refreshSharedSession() } }),
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
  uploadBanner: async (file: File) => {
    const form = new FormData();
    form.append('banner', file);
    return responseContract(
      getApi().post('/users/@me/banner', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
      isUpdatedCurrentUser,
      'UpdatedCurrentUser',
    );
  },
  deleteBanner: async () => getApi().delete('/users/@me/banner'),
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
