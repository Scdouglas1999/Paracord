import { ed25519 } from '@noble/curves/ed25519.js';
import type { LoginResponse, User } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { withUnlockedPrivateKey } from '../accountSession';
import { signChallenge } from '../account';
import { setAccessToken, setRefreshToken } from '../authToken';
import { resolveApiBaseUrl } from '../config/apiBaseUrl';
import type { OperationContext } from '../operationContext';
import { LOCAL_SERVER_ID } from '../serverScope';
import { bytesToHex } from './util';

/** Attach only to the captured account. Key replacement is a separate recovery operation. */
export async function attachAccountIdentity(
  context: OperationContext,
  password: string,
  mfaCode?: string,
): Promise<User> {
  context.assertCurrent();
  const serverUrl = context.scope.serverId === LOCAL_SERVER_ID ? resolveApiBaseUrl()
    : useServerListStore.getState().getServer(context.scope.serverId)?.url;
  if (!serverUrl) throw new Error('The server for this account is unavailable.');
  const origin = new URL(serverUrl, window.location.href).origin;
  return withUnlockedPrivateKey(async (privateKey, lease) => {
    const publicKey = bytesToHex(ed25519.getPublicKey(privateKey));
    if (context.user.public_key) {
      if (context.user.public_key.toLowerCase() !== publicKey) {
        throw new Error('This server account already has a different identity. Restore and unlock that identity before continuing.');
      }
      return context.user;
    }
    if (!password) throw new Error('Enter your current server password to attach this identity.');
    const response = await context.request<{ nonce: string; timestamp: number; server_origin: string }>({
      method: 'POST', url: '/auth/challenge', signal: lease.signal, timeout: 30_000,
    });
    const challenge = response.data;
    if (response.status !== 200 || !challenge || typeof challenge.nonce !== 'string' || !challenge.nonce
      || !Number.isSafeInteger(challenge.timestamp) || Math.abs(Date.now() - challenge.timestamp * 1000) > 120_000) {
      throw new Error('The server returned an invalid or expired identity challenge.');
    }
    if (typeof challenge.server_origin !== 'string' || new URL(challenge.server_origin).origin !== origin) {
      throw new Error('The identity challenge belongs to a different server.');
    }
    const signature = await signChallenge(privateKey, challenge.nonce, challenge.timestamp, challenge.server_origin);
    lease.assertCurrent(); context.assertCurrent();
    const attached = await context.request<LoginResponse>({
      method: 'POST', url: '/auth/attach-public-key', signal: lease.signal, timeout: 30_000,
      // Here 401 can mean a rejected password/MFA, not an expired bearer token.
      // Let the form handle it without the shared interceptor logging out.
      validateStatus: status => (status >= 200 && status < 300) || status === 401,
      data: { public_key: publicKey, expected_public_key: null, nonce: challenge.nonce, timestamp: challenge.timestamp, signature, password,
        ...(mfaCode ? { mfa_code: mfaCode } : {}) },
    });
    lease.assertCurrent(); context.assertCurrent();
    if (attached.status === 401) {
      throw new Error('Server authentication was rejected. Check your current server password and two-factor code, or sign in again.');
    }
    const result = attached.data;
    if (attached.status !== 200 || !result || typeof result.token !== 'string' || !result.token
      || result.user?.id !== context.scope.userId || result.user.public_key?.toLowerCase() !== publicKey
      || (result.refresh_token !== undefined && typeof result.refresh_token !== 'string')) {
      throw new Error('The server did not confirm this identity for the intended account. Sign in again to check its enrollment.');
    }
    // Attaching revokes the previous login session. Install the verified reply
    // before reconnecting; retaining the old token would immediately log out.
    context.dispose();
    if (context.scope.serverId === LOCAL_SERVER_ID) {
      setAccessToken(result.token); setRefreshToken(result.refresh_token ?? null);
      useAuthStore.setState({ token: result.token, user: result.user });
    } else {
      const servers = useServerListStore.getState();
      servers.updateToken(context.scope.serverId, result.token);
      servers.updateRefreshToken(context.scope.serverId, result.refresh_token ?? null);
      servers.setAuthenticatedUser(context.scope.serverId, result.user);
    }
    return result.user;
  });
}
