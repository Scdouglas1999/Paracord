import axios, { type AxiosInstance } from 'axios';

import { extractApiError, isMissingRoute } from '../api/client';
import type { CredentialParams } from '../api/generated/CredentialParams';
import { deriveCredentialKeysFromWire } from './credential/derive';
import { CredentialError, DOWNGRADE_MESSAGE } from './credential/errors';
import { checkCredentialParams, findCredentialPin } from './credential/keystoreV2';
import { connectionManager } from './connectionManager';
import { getTauriAdapter } from './tauriAxiosAdapter';
import { useServerListStore } from '../stores/serverListStore';

/**
 * Sign in again to one saved server, from inside the app.
 *
 * The sign-in screen speaks for the home server only, and the route guards
 * keep it closed while any server still has a session. A saved server whose
 * session the server refused is signed in to here instead, with the account's
 * password (and its second factor when it has one); the session lands on that
 * server's entry and the server connects, without a restart.
 */

interface LoginBody {
  token?: string;
  refresh_token?: string | null;
  user?: { mfa_required?: boolean; mfa_ticket?: string } | null;
}

export type ServerSignInStep = { kind: 'signed-in' } | { kind: 'second-factor'; ticket: string };

function clientFor(serverId: string): AxiosInstance {
  const server = useServerListStore.getState().getServer(serverId);
  if (!server) throw new Error('This server is no longer in your list.');
  return axios.create({
    baseURL: `${server.url.replace(/\/+$/, '')}/api/v1`,
    headers: { 'Content-Type': 'application/json' },
    // The password is the credential and the session comes back in the body; a
    // cookie left by the refused session must not ride along (with no bearer
    // token the server would hold it to the cookie's CSRF check and refuse).
    withCredentials: false,
    timeout: 15_000,
    adapter: getTauriAdapter(),
  });
}

async function finish(serverId: string, body: LoginBody): Promise<ServerSignInStep> {
  if (body.user?.mfa_required && body.user.mfa_ticket) {
    return { kind: 'second-factor', ticket: body.user.mfa_ticket };
  }
  if (!body.token) throw new Error('The server answered without a session.');
  await connectionManager.adoptServerSession(serverId, body.token, body.refresh_token ?? null);
  return { kind: 'signed-in' };
}

/** Why a sign-in did not work, in words for the person. */
export function serverSignInError(error: unknown, serverName: string): string {
  if (axios.isAxiosError(error) && !error.response) {
    return `Could not reach ${serverName}. It may be restarting, or this computer cannot see it.`;
  }
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const message = extractApiError(error);
  if ((status === 400 || status === 401) && (!message || message === 'unauthorized' || /unauthorized/i.test(message))) {
    return 'That email or username and password did not match.';
  }
  return message;
}

export async function signInToServer(serverId: string, identifier: string, password: string): Promise<ServerSignInStep> {
  const client = clientFor(serverId);
  const typed = identifier.trim();
  // One password (docs/setup-spec.md §3.3, §3.13): on a server that has it the
  // typed password only goes into the KDF and the server gets the auth key.
  // An older server (no params route) keeps the password sign-in; a server
  // that says "two passwords" for an account this device pinned as one
  // password gets nothing.
  let params: CredentialParams | null = null;
  try {
    params = (await client.post<CredentialParams>('/auth/credential/params', { identifier: typed })).data;
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
  }
  const server = useServerListStore.getState().getServer(serverId);
  const pin = server ? findCredentialPin(server.url, { identifier: typed }) : null;
  if (params) checkCredentialParams(params, pin);
  else if (pin) throw new CredentialError('downgrade', DOWNGRADE_MESSAGE);
  if (params?.version === 2) {
    const { authKey } = await deriveCredentialKeysFromWire(password, params.salt, params.kdf);
    const { data } = await client.post<LoginBody>('/auth/credential/login', { identifier: typed, auth_key: authKey });
    return finish(serverId, data);
  }
  const { data } = await client.post<LoginBody>('/auth/login', { identifier: typed, password });
  return finish(serverId, data);
}

export async function completeServerSecondFactor(serverId: string, ticket: string, code: string): Promise<ServerSignInStep> {
  const { data } = await clientFor(serverId).post<LoginBody>('/auth/mfa/login', { ticket, code: code.trim() });
  return finish(serverId, data);
}
