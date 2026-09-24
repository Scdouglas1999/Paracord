import { ed25519 } from '@noble/curves/ed25519.js';
import type { LoginResponse, User } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { withUnlockedPrivateKey } from '../accountSession';
import { signChallenge } from '../account';
import { getAccessToken, getRefreshToken, setAccessToken, setRefreshToken } from '../authToken';
import { resolveApiBaseUrl } from '../config/apiBaseUrl';
import type { OperationContext } from '../operationContext';
import { findHomeServerEntry } from '../serverIdentity';
import { LOCAL_SERVER_ID } from '../serverScope';
import { HOME_REFRESH_SCOPE, resetRefreshCoordination, serverRefreshScope } from '../authRefreshCoordinator';
import { bytesToHex } from './util';

/**
 * Hand the replacement credential to every scope that was holding the dead one.
 *
 * Attaching a key revokes the login session it was authorized with, and the
 * server answers with a brand-new one. Installing that reply in a single scope
 * is not enough: on the desktop the *same* session is also held by the
 * server-list entry for this instance (the shell has no origin server, so it
 * always adds its own instance by address). That copy was left holding the
 * token the attach had just revoked, and within milliseconds its own requests
 * 401'd, its refresh presented the spent token, and `onAuthFailed` tore down
 * the home session the copy was made from — mid-enrollment. The visible result
 * was "Waiting for your instance account" on a setup that had in fact
 * succeeded, a settings toggle that silently 401'd forever after, and
 * "your session ended on the instance" over a live, healthy connection.
 *
 * Whoever carried the old credential carries the new one.
 */
function adoptReplacedCredential(params: {
  previousAccessToken: string | null;
  previousRefreshToken: string | null;
  excludeServerId: string;
  token: string;
  refreshToken: string | null;
  user: User;
}): void {
  const { previousAccessToken, previousRefreshToken, excludeServerId, token, refreshToken, user } = params;
  const store = useServerListStore.getState();
  // The entry that stands for the home server is the same session under
  // another name even when its stored copy has drifted (a rotation it did not
  // witness), so it is adopted on identity, not only on a matching token.
  const homeEntryId = excludeServerId === LOCAL_SERVER_ID
    ? findHomeServerEntry(store.servers, previousAccessToken)?.id
    : undefined;
  for (const server of store.servers) {
    if (server.id === excludeServerId) continue;
    const carriedDeadCredential =
      (!!previousAccessToken && server.token === previousAccessToken) ||
      (!!previousRefreshToken && server.refreshToken === previousRefreshToken) ||
      (server.id === homeEntryId && server.userId === user.id);
    if (!carriedDeadCredential) continue;
    resetRefreshCoordination(serverRefreshScope(server.id));
    store.updateToken(server.id, token);
    store.updateRefreshToken(server.id, refreshToken);
    if (server.userId === user.id) store.setAuthenticatedUser(server.id, user);
  }
}

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
    if (!password) throw new Error('Enter your current sign-in password to attach this identity.');
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
      throw new Error('The instance rejected that sign-in. Check your current password and two-factor code, or sign in again.');
    }
    const result = attached.data;
    if (attached.status !== 200 || !result || typeof result.token !== 'string' || !result.token
      || result.user?.id !== context.scope.userId || result.user.public_key?.toLowerCase() !== publicKey
      || (result.refresh_token !== undefined && typeof result.refresh_token !== 'string')) {
      throw new Error('The server did not confirm this identity for the intended account. Sign in again to check its enrollment.');
    }
    // Attaching revokes the previous login session. Install the verified reply
    // before reconnecting; retaining the old token would immediately log out.
    // Read the outgoing credential first — every copy of it has to be replaced,
    // not just the one this operation was scoped to.
    const previousAccessToken = getAccessToken();
    const previousRefreshToken = getRefreshToken();
    const previousServer = context.scope.serverId === LOCAL_SERVER_ID
      ? null
      : useServerListStore.getState().getServer(context.scope.serverId);
    context.dispose();
    if (context.scope.serverId === LOCAL_SERVER_ID) {
      resetRefreshCoordination(HOME_REFRESH_SCOPE);
      setAccessToken(result.token); setRefreshToken(result.refresh_token ?? null);
      useAuthStore.setState({ token: result.token, user: result.user });
    } else {
      resetRefreshCoordination(serverRefreshScope(context.scope.serverId));
      const servers = useServerListStore.getState();
      servers.updateToken(context.scope.serverId, result.token);
      servers.updateRefreshToken(context.scope.serverId, result.refresh_token ?? null);
      servers.setAuthenticatedUser(context.scope.serverId, result.user);
      // The home session and this entry can be the same session under two
      // names. If they were, the home copy is dead too.
      const sharedHomeCredential =
        (!!previousAccessToken && previousServer?.token === previousAccessToken) ||
        (!!previousRefreshToken && previousServer?.refreshToken === previousRefreshToken);
      if (sharedHomeCredential) {
        resetRefreshCoordination(HOME_REFRESH_SCOPE);
        setAccessToken(result.token); setRefreshToken(result.refresh_token ?? null);
        useAuthStore.setState({ token: result.token, user: result.user });
      }
    }
    adoptReplacedCredential({
      previousAccessToken,
      previousRefreshToken,
      excludeServerId: context.scope.serverId,
      token: result.token,
      refreshToken: result.refresh_token ?? null,
      user: result.user,
    });
    return result.user;
  });
}
