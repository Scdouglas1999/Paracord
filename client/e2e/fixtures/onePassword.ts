import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

import {
  deriveKeys,
  identity,
  newCredential,
  phraseOf,
  proof,
  wrapIdentity,
  type Challenge,
} from '../../scripts/lib/credential-node.mjs';

/**
 * One-password accounts for the real-server specs (docs/setup-spec.md §3.3).
 *
 * A release server refuses the legacy `POST /auth/register` (410
 * `client_update_required`), so every account a spec makes goes the way the
 * client makes one: the credential and the wrapped identity are derived here
 * (scripts/lib/credential-node.mjs, checked against the shared vectors) and
 * only the auth key reaches the server. The calls go through the spec's own
 * request context, so the session cookies land where the old register put them.
 */

export interface NewAccount {
  email: string;
  username: string;
  password: string;
  display_name?: string | null;
  invite_code?: string | null;
}

/** The `/auth/credential/register` body for `account`, signed over `challenge`. */
export function registrationBody(account: NewAccount, challenge: Challenge) {
  const id = identity();
  const { credential, wrapKey } = newCredential(account.password);
  return {
    body: {
      username: account.username,
      email: account.email,
      display_name: account.display_name ?? null,
      invite_code: account.invite_code ?? null,
      credential,
      identity: {
        public_key: id.publicKey,
        wrapped_key: wrapIdentity(wrapKey, id),
        wrap_alg: 'aes256gcm-v2',
        proof: proof(id, 'register', challenge),
      },
    },
    publicKey: id.publicKey,
    phrase: phraseOf(id),
  };
}

/** The double-submit header the CSRF middleware wants once a context holds session cookies. */
async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const csrf = (await request.storageState()).cookies.find((c) => c.name === 'paracord_csrf')?.value;
  return csrf ? { 'x-paracord-csrf': csrf } : {};
}

/**
 * Register through `/auth/challenge` + `/auth/credential/register` on `request`.
 * Answers with the register response (201, `{ token, user, refresh_token }`)
 * exactly as the old route did. Unless `confirmPhrase` is false, the account's
 * phrase is then marked saved, so a later sign-in in the UI goes straight to
 * the app instead of the "Save your recovery phrase" screen.
 */
export async function registerAccount(
  request: APIRequestContext,
  base: string,
  account: NewAccount,
  { confirmPhrase = true }: { confirmPhrase?: boolean } = {},
): Promise<APIResponse> {
  const challengeResponse = await request.post(`${base}/api/v1/auth/challenge`, { headers: await csrfHeaders(request) });
  if (!challengeResponse.ok()) {
    throw new Error(`auth/challenge failed: ${challengeResponse.status()} ${await challengeResponse.text()}`);
  }
  const { body } = registrationBody(account, (await challengeResponse.json()) as Challenge);
  const response = await request.post(`${base}/api/v1/auth/credential/register`, {
    headers: await csrfHeaders(request),
    data: body,
  });
  if (response.ok() && confirmPhrase) {
    const { token } = (await response.json()) as { token: string };
    const confirmed = await request.post(`${base}/api/v1/users/@me/key-backup/recovery-confirmed`, {
      headers: { Authorization: `Bearer ${token}`, ...(await csrfHeaders(request)) },
    });
    if (!confirmed.ok()) {
      throw new Error(`recovery-confirmed failed: ${confirmed.status()} ${await confirmed.text()}`);
    }
  }
  return response;
}

/** Sign in through `/auth/credential/params` + `/auth/credential/login`; answers with the login response. */
export async function signInAccount(
  request: APIRequestContext,
  base: string,
  identifier: string,
  password: string,
): Promise<APIResponse> {
  const paramsResponse = await request.post(`${base}/api/v1/auth/credential/params`, {
    headers: await csrfHeaders(request),
    data: { identifier },
  });
  if (!paramsResponse.ok()) {
    throw new Error(`credential/params failed: ${paramsResponse.status()} ${await paramsResponse.text()}`);
  }
  const params = (await paramsResponse.json()) as { version: number; salt: string; kdf: Parameters<typeof deriveKeys>[2] };
  if (params.version !== 2) throw new Error(`${identifier}: the server answered credential version ${params.version}`);
  const { authKey } = deriveKeys(password, Buffer.from(params.salt, 'base64url'), params.kdf);
  return request.post(`${base}/api/v1/auth/credential/login`, {
    headers: await csrfHeaders(request),
    data: { identifier, auth_key: authKey },
  });
}

/**
 * A full page load in a browser locks a one-password account's identity (the
 * browser never keeps the key, docs/setup-spec.md §3.5): the app sends it to
 * the unlock screen, which asks for the password and comes back to where it
 * was. Go to `url` and answer that screen when it is asked.
 */
export async function gotoUnlocked(page: Page, url: string, password: string): Promise<void> {
  await page.goto(url);
  await answerUnlock(page, password);
}

/** Answer the unlock screen if the app asks for it (after a reload or a full navigation). */
export async function answerUnlock(page: Page, password: string): Promise<void> {
  const unlock = page.getByRole('button', { name: 'Unlock', exact: true });
  const asked = await unlock
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  await page.locator('input[type="password"]').first().fill(password);
  await unlock.click();
  await expect(unlock).toBeHidden({ timeout: 20_000 });
}

/** Sign in through the real login page (params, derive, login, identity unwrapped from the backup). */
export async function signInThroughUi(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(identifier);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}
