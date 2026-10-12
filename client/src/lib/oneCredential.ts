import { getPublicKeyAsync, utils } from '@noble/ed25519';
import { useEffect, useState } from 'react';
import { authApi } from '../api/auth';
import { isMissingRoute } from '../api/client';
import type { CredentialParams } from '../api/generated/CredentialParams';
import type { NewCredential, NewIdentity } from '../api/generated/CredentialRegister';
import { useAccountStore } from '../stores/accountStore';
import { useAuthStore } from '../stores/authStore';
import type { LoginResponse, User } from '../types';
import { deleteAccount as deleteLegacyKeystore, getStoredKeystore, signChallenge, unlockAccount } from './account';
import { withUnlockedPrivateKey } from './accountSession';
import { adoptAccountChoice, deviceAskChoice, setDeviceAskChoice } from './askForPassword';
import { resolveApiBaseUrl } from './config/apiBaseUrl';
import { createCredential, deriveCredentialKeysFromWire } from './credential/derive';
import { CredentialError, isCredentialError, NO_ACCOUNT_FOR_PHRASE_MESSAGE, UNWRAP_FAILED_MESSAGE } from './credential/errors';
import { toHex } from './credential/encoding';
import {
  checkCredentialParams,
  checkPinnedIdentity,
  findCredentialPin,
  keystoreFromBackup,
  normalizeHomeOrigin,
  readKeystoreV2,
  recordCredentialPin,
  unlockKeystoreV2,
  validateKeystoreV2,
  writeKeystoreV2,
  type AccountKeystoreV2,
  type CredentialPin,
} from './credential/keystoreV2';
import { phraseFromPrivateKey, privateKeyFromPhrase, privateKeyFromPhraseFor } from './credential/phrase';
import { PROOF_PURPOSE, signCredentialProof, type AuthChallenge, type ProofPurpose } from './credential/proofs';
import { unwrapIdentity, wrapIdentity, WRAP_ALG_V2 } from './credential/wrap';
import { assessNewPassword } from './credential/password';
import { withExplicitActivityOff } from './features/privacyDefaults';
import { canRememberUnlock, forgetIdentity, KeychainUnavailableError, rememberIdentity } from './rememberedUnlock';
import { LOCAL_SERVER_ID } from './serverScope';
import { noteMissingRoute, OlderServerError, useServerFeatureStore } from './serverFeatures';

/**
 * Account flows on the one-password scheme (docs/setup-spec.md §3.3–§3.13).
 *
 * Everything here talks to the **home** server (the API client for
 * `LOCAL_SERVER_ID`, i.e. `resolveApiBaseUrl()`), installs the session it
 * gets into `authStore` and the unlocked identity into `accountStore`. A
 * first-run screen points the app at its server first (`setStoredServerUrl`)
 * and then calls these. Every refusal is thrown with a sentence written for
 * the person; nothing degrades silently.
 *
 * Call order per flow:
 * - sign-up: {@link signUpWithPassword} (or {@link prepareNewIdentity} →
 *   claim → {@link adoptNewAccount} for the host's credential claim) → show
 *   the phrase → {@link confirmRecoverySaved}.
 * - sign-in: {@link signInWithPassword} → `mfa`: {@link completeMfaSignIn};
 *   `legacy`: the distinct two-password screen, {@link legacySignIn}, then
 *   `/setup` ({@link moveToOnePassword}); `signed-in` with
 *   `recoveryConfirmed: false`: show the phrase again.
 * - unlock: {@link unlockWithPassword}.
 * - change: {@link changeOnePassword}. Recover: {@link recoverWithPhrase} →
 *   {@link setPasswordAfterRecovery}. Start over: {@link startOver}.
 */

/** The home server's origin (the account's `homeOrigin` in keystores, pins and the keychain). */
export function homeOrigin(): string {
  return normalizeHomeOrigin(new URL(resolveApiBaseUrl(), window.location.href).toString());
}

// ── Version detection (§3.12) ──────────────────────────────────────────────

export type CredentialMode = 'one-password' | 'legacy';

/**
 * Which sign-in the home server runs, from what it says about itself
 * (`/auth/options` gains `credential_version: 2`). An older server is recorded
 * as lacking `oneCredential`; its accounts use the legacy pages unchanged.
 */
export async function detectCredentialMode(): Promise<CredentialMode> {
  const { data } = await authApi.options();
  if (data?.credential_version === 2) {
    useServerFeatureStore.getState().forget(LOCAL_SERVER_ID);
    return 'one-password';
  }
  useServerFeatureStore.getState().markMissing(LOCAL_SERVER_ID, 'oneCredential');
  return 'legacy';
}

/** The hook form: `null` while asking, `'unreachable'` when the server did not answer. */
export function useCredentialMode(enabled = true): CredentialMode | 'unreachable' | null {
  const [mode, setMode] = useState<CredentialMode | 'unreachable' | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    detectCredentialMode()
      .then((next) => { if (!canceled) setMode(next); })
      .catch(() => { if (!canceled) setMode('unreachable'); });
    return () => { canceled = true; };
  }, [enabled]);
  return mode;
}

/** The pin for the signed-in account, i.e. "this account uses one password" on this device. */
export function pinForSignedInAccount(): CredentialPin | null {
  return pinForAccount(useAuthStore.getState().user?.id);
}

/** The pin for a home-server account by id, or `null` (also when it cannot be read). */
export function pinForAccount(userId: string | null | undefined): CredentialPin | null {
  if (!userId) return null;
  try {
    return findCredentialPin(homeOrigin(), { userId });
  } catch {
    return null;
  }
}

async function fetchParams(identifier: string, pin: CredentialPin | null): Promise<CredentialParams> {
  let params: CredentialParams;
  try {
    params = (await authApi.credentialParams(identifier)).data;
  } catch (error) {
    if (noteMissingRoute(LOCAL_SERVER_ID, 'oneCredential', error)) throw new OlderServerError('oneCredential');
    throw error;
  }
  return checkCredentialParams(params, pin);
}

async function freshChallenge(): Promise<AuthChallenge> {
  const { data } = await authApi.challenge();
  if (!data || typeof data.nonce !== 'string' || !data.nonce || !Number.isSafeInteger(data.timestamp)
    || Math.abs(Date.now() - data.timestamp * 1000) > 120_000) {
    throw new CredentialError('invalid', 'The server returned an invalid or expired challenge.');
  }
  return data;
}

const responseStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;
const responseCode = (error: unknown): string | undefined =>
  (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code as string | undefined;

/** The MFA ticket branch of a login response (`user: { mfa_required, mfa_ticket }`). */
function mfaTicketOf(data: LoginResponse): string | null {
  const user = data?.user as unknown as { mfa_required?: unknown; mfa_ticket?: unknown } | undefined;
  return user?.mfa_required === true && typeof user.mfa_ticket === 'string' ? user.mfa_ticket : null;
}

const identifiersOf = (typed: string | null, user: User): string[] =>
  [typed ?? '', user.username ?? '', user.email ?? ''].filter((value) => value && !value.endsWith('@pubkey'));

// ── Remembered unlock policy (§3.5) ────────────────────────────────────────

/**
 * Desktop: keep the identity in the keychain unless "Ask for my password when
 * Paracord opens" is on for this computer (`lib/askForPassword.ts`). A device
 * that never chose adopts the account's old setting once; when that cannot be
 * read, the key is not remembered (the next launch asks).
 */
export async function applyRememberPolicy(keystore: AccountKeystoreV2): Promise<void> {
  if (!canRememberUnlock()) return;
  const account = useAccountStore.getState();
  let accountValue: boolean | undefined;
  if (deviceAskChoice() === null) {
    const auth = useAuthStore.getState();
    if (!auth.hasFetchedSettings) await auth.fetchSettings();
    const after = useAuthStore.getState();
    accountValue = after.hasFetchedSettings ? after.settings?.crypto_auth_enabled === true : undefined;
  }
  if (adoptAccountChoice(accountValue)) {
    await forgetIdentity(keystore.homeOrigin, keystore.userId);
    return;
  }
  try {
    await withUnlockedPrivateKey((privateKey) => rememberIdentity(keystore.homeOrigin, keystore.userId, privateKey));
    account.setRememberProblem(null);
  } catch (error) {
    account.setRememberProblem(error instanceof KeychainUnavailableError ? error.message : String(error));
  }
}

/**
 * "Ask for my password when Paracord opens" was switched on this computer:
 * record it here (never on the account) and apply it now.
 */
export async function applyAskForPassword(ask: boolean): Promise<void> {
  if (!canRememberUnlock()) return;
  setDeviceAskChoice(ask);
  const keystore = await readKeystoreV2().catch(() => null);
  if (!keystore) return;
  if (ask) {
    await forgetIdentity(keystore.homeOrigin, keystore.userId);
    return;
  }
  if (useAccountStore.getState().isUnlocked) await applyRememberPolicy(keystore);
}

/**
 * Account settings arrived. A device that never chose adopts the account's old
 * `crypto_auth_enabled` once, and drops the remembered key when that says ask.
 * A device that has chosen ignores the account value: another computer's
 * choice does not reach this one.
 */
export async function adoptAccountAskForPassword(accountValue: boolean): Promise<void> {
  if (!canRememberUnlock()) return;
  const choice = deviceAskChoice();
  if (choice === true || choice === false) return;
  if (!adoptAccountChoice(accountValue)) return;
  const keystore = await readKeystoreV2().catch(() => null);
  if (keystore) await forgetIdentity(keystore.homeOrigin, keystore.userId);
}

// ── Installing an identity ─────────────────────────────────────────────────

async function installIdentity(
  keystore: AccountKeystoreV2,
  privateKey: Uint8Array,
  identifiers: string[],
  options: { replaceIdentity?: boolean; displayName?: string | null } = {},
): Promise<void> {
  validateKeystoreV2(keystore);
  await writeKeystoreV2(keystore, { replace: true });
  await recordCredentialPin(
    { homeOrigin: keystore.homeOrigin, userId: keystore.userId, identifiers, publicKey: keystore.publicKey, kdf: keystore.kdf },
    { replaceIdentity: options.replaceIdentity },
  );
  useAccountStore.getState().adoptIdentity(keystore, privateKey, options.displayName);
  await applyRememberPolicy(keystore);
}

/** Undo a half-made sign-in: the session must not outlive an identity Paracord refused. */
async function abandonSession(): Promise<void> {
  await useAuthStore.getState().logout().catch(() => undefined);
}

// ── Sign-up and the credential claim (§3.3) ────────────────────────────────

export interface PreparedIdentity {
  credential: NewCredential;
  identity: NewIdentity;
  publicKey: string;
  /** Held only until {@link adoptNewAccount}; zeroed there. */
  privateKey: Uint8Array;
  homeOrigin: string;
}

/**
 * A brand-new identity and credential for `password`, with a proof signed for
 * a fresh challenge from the home server. `purpose` is `register` for sign-up,
 * the claim and the v1 move, and `reset` for "Start over" (signed by the new
 * key, as the server expects).
 */
export async function prepareNewIdentity(
  password: string,
  options: { purpose?: ProofPurpose; privateKey?: Uint8Array } = {},
): Promise<PreparedIdentity> {
  const origin = homeOrigin();
  const privateKey = options.privateKey ? options.privateKey.slice() : utils.randomSecretKey();
  try {
    const publicKey = toHex(await getPublicKeyAsync(privateKey));
    const { credential, wrapKey } = await createCredential(password);
    const wrapped = await wrapIdentity(wrapKey, privateKey, publicKey);
    const proof = await signCredentialProof(privateKey, options.purpose ?? PROOF_PURPOSE.register, await freshChallenge(), origin);
    return {
      credential,
      identity: { public_key: publicKey, wrapped_key: wrapped, wrap_alg: WRAP_ALG_V2, proof },
      publicKey,
      privateKey,
      homeOrigin: origin,
    };
  } catch (error) {
    privateKey.fill(0);
    throw error;
  }
}

/**
 * Finish an account the server just created from `prepared` (sign-up or the
 * credential claim): install the session, save the keystore at epoch 1, pin
 * it, unlock, and return the recovery phrase for the phrase screen. The phrase
 * is only ever held in memory.
 */
export async function adoptNewAccount(
  prepared: PreparedIdentity,
  session: LoginResponse,
  typedIdentifiers: string[] = [],
): Promise<{ user: User; phrase: string }> {
  useAuthStore.getState().adoptSession(session);
  const user = session.user;
  const phrase = phraseFromPrivateKey(prepared.privateKey);
  const keystore: AccountKeystoreV2 = {
    version: 2,
    homeOrigin: prepared.homeOrigin,
    userId: user.id,
    username: user.username,
    publicKey: prepared.publicKey,
    wrappedKey: prepared.identity.wrapped_key,
    kdf: prepared.credential.kdf,
    salt: prepared.credential.salt,
    epoch: 1,
  };
  try {
    await installIdentity(keystore, prepared.privateKey, [...typedIdentifiers, ...identifiersOf(null, user)], {
      displayName: user.display_name,
    });
  } finally {
    prepared.privateKey.fill(0);
  }
  return { user, phrase };
}

/** Record "Show what I'm playing" as off (setup spec §8.4): a choice, not an absence. */
async function recordPrivacyDefaults(): Promise<void> {
  const auth = useAuthStore.getState();
  await auth.fetchSettings();
  const settings = useAuthStore.getState().settings;
  if (!settings) throw new Error("Your account was created, but Paracord couldn't save its privacy defaults. Check Settings › Privacy.");
  await auth.updateSettings({ notifications: withExplicitActivityOff(settings.notifications) });
}

export interface SignUpInput {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
  inviteCode?: string;
}

/**
 * Create a one-password account on the home server (§3.3 sign-up). Returns the
 * recovery phrase to show; call {@link confirmRecoverySaved} once the person
 * ticks the box. Joining an invite's server stays with the caller
 * (`POST /invites/{code}`), as it always has.
 */
export async function signUpWithPassword(input: SignUpInput): Promise<{ user: User; phrase: string; privacyDefaultsError: string | null }> {
  const prepared = await prepareNewIdentity(input.password);
  let session: LoginResponse;
  try {
    ({ data: session } = await authApi.credentialRegister({
      username: input.username,
      display_name: input.displayName || null,
      email: input.email || null,
      invite_code: input.inviteCode || null,
      credential: prepared.credential,
      identity: prepared.identity,
    }));
  } catch (error) {
    prepared.privateKey.fill(0);
    if (noteMissingRoute(LOCAL_SERVER_ID, 'oneCredential', error)) throw new OlderServerError('oneCredential');
    throw error;
  }
  const result = await adoptNewAccount(prepared, session, [input.username, input.email ?? '']);
  let privacyDefaultsError: string | null = null;
  try {
    await recordPrivacyDefaults();
  } catch (error) {
    privacyDefaultsError = error instanceof Error ? error.message : String(error);
  }
  return { ...result, privacyDefaultsError };
}

/** The phrase screen's checkbox (§1.8): any device stops re-showing the phrase. */
export async function confirmRecoverySaved(): Promise<void> {
  await authApi.confirmRecoverySaved();
}

// ── Sign-in (§3.3, §3.13) ──────────────────────────────────────────────────

export type SignInOutcome =
  | { kind: 'signed-in'; user: User; recoveryConfirmed: boolean }
  | { kind: 'mfa'; pending: PendingMfaSignIn }
  /** A v1 account (§3.11): show the distinct two-password screen. Nothing was sent. */
  | { kind: 'legacy' };

export interface PendingMfaSignIn {
  ticket: string;
  identifier: string;
  params: Extract<CredentialParams, { version: 2 }>;
  wrapKey: CryptoKey;
  pin: CredentialPin | null;
  options: FinishOptions;
}

interface FinishOptions {
  /** "Start over" made this identity: the pin may move to it, but only to exactly this key. */
  replaceIdentityWith?: string;
}

/**
 * Sign in with the one password. The typed password only ever goes into the
 * KDF; the server gets the derived auth key. A pinned account offered
 * `version: 1` or weaker parameters is refused before anything is sent.
 */
export async function signInWithPassword(identifier: string, password: string, options: FinishOptions = {}): Promise<SignInOutcome> {
  const typed = identifier.trim();
  const origin = homeOrigin();
  const pin = findCredentialPin(origin, { identifier: typed });
  const params = await fetchParams(typed, pin);
  if (params.version === 1) return { kind: 'legacy' };
  const { authKey, wrapKey } = await deriveCredentialKeysFromWire(password, params.salt, params.kdf);
  const { data } = await authApi.credentialLogin(typed, authKey);
  const ticket = mfaTicketOf(data);
  if (ticket) return { kind: 'mfa', pending: { ticket, identifier: typed, params, wrapKey, pin, options } };
  return finishSignIn(typed, params, wrapKey, pin, data, options);
}

/** The MFA code for a pending one-password sign-in. */
export async function completeMfaSignIn(pending: PendingMfaSignIn, code: string): Promise<SignInOutcome> {
  const { data } = await authApi.mfaLogin(pending.ticket, code.trim());
  return finishSignIn(pending.identifier, pending.params, pending.wrapKey, pending.pin, data, pending.options);
}

async function finishSignIn(
  identifier: string,
  params: Extract<CredentialParams, { version: 2 }>,
  wrapKey: CryptoKey,
  typedPin: CredentialPin | null,
  session: LoginResponse,
  options: FinishOptions,
): Promise<SignInOutcome> {
  useAuthStore.getState().adoptSession(session);
  const user = session.user;
  const origin = homeOrigin();
  try {
    const { data: backup } = await authApi.keyBackup();
    const pin = findCredentialPin(origin, { userId: user.id }) ?? typedPin;
    if (options.replaceIdentityWith) {
      if (backup.public_key !== options.replaceIdentityWith) {
        throw new CredentialError('identity_mismatch', "The keys this server returned don't belong to your account. Paracord won't use them.");
      }
    } else {
      checkPinnedIdentity(backup.public_key, pin);
    }
    const keystore = keystoreFromBackup({ homeOrigin: origin, userId: user.id, username: user.username }, params, backup);
    const privateKey = await unwrapIdentity(wrapKey, keystore.wrappedKey, keystore.publicKey);
    try {
      await installIdentity(keystore, privateKey, identifiersOf(identifier, user), {
        replaceIdentity: Boolean(options.replaceIdentityWith),
        displayName: user.display_name,
      });
    } finally {
      privateKey.fill(0);
    }
    return { kind: 'signed-in', user, recoveryConfirmed: backup.recovery_confirmed };
  } catch (error) {
    await abandonSession();
    throw error;
  }
}

// ── The v1 account path (§3.11) ────────────────────────────────────────────

/**
 * The legacy sign-in password, held in memory between the distinct
 * two-password screen and the move screen (`/setup`), so the person is not
 * asked twice. Never written anywhere; cleared by the move or a sign-out.
 */
let pendingLegacyPassword: string | null = null;
export const takeLegacyPassword = (): string | null => pendingLegacyPassword;
export const clearLegacyPassword = (): void => { pendingLegacyPassword = null; };

export type LegacySignInOutcome = { kind: 'signed-in'; user: User } | { kind: 'mfa'; ticket: string };

/**
 * Sign in a v1 account with its old sign-in password (`/auth/login`). Only the
 * distinct §3.11 screen calls this. A pinned one-password account is refused:
 * a server that suddenly says "two passwords" for it is a downgrade.
 */
export async function legacySignIn(identifier: string, legacyPassword: string): Promise<LegacySignInOutcome> {
  const typed = identifier.trim();
  if (findCredentialPin(homeOrigin(), { identifier: typed })) {
    throw new CredentialError('downgrade',
      "This server is asking for an older, weaker sign-in for an account that already uses one password. Paracord won't send it.");
  }
  const { data } = await authApi.login({ identifier: typed, password: legacyPassword });
  pendingLegacyPassword = legacyPassword;
  const ticket = mfaTicketOf(data);
  if (ticket) return { kind: 'mfa', ticket };
  useAuthStore.getState().adoptSession(data);
  return { kind: 'signed-in', user: data.user };
}

export async function completeLegacyMfa(ticket: string, code: string): Promise<User> {
  const { data } = await authApi.mfaLogin(ticket, code.trim());
  useAuthStore.getState().adoptSession(data);
  return data.user;
}

/** Whether the signed-in account still uses two passwords (asks the server; key-only accounts answer no). */
export async function signedInAccountIsLegacy(): Promise<boolean> {
  const user = useAuthStore.getState().user;
  if (!user?.username || pinForSignedInAccount()) return false;
  const params = await fetchParams(user.username, null);
  return params.version === 1;
}

export const SAME_AS_LEGACY_MESSAGE =
  "Pick a password you haven't used to sign in to this server before. The server has seen that one.";

export type MoveIdentitySource =
  /** The legacy keystore on this device; `encryptionPassword` unlocks it when it is locked. */
  | { kind: 'device'; encryptionPassword?: string }
  /** The recovery phrase of the account's existing identity. */
  | { kind: 'phrase'; phrase: string }
  /** The account has no identity anywhere: make one. */
  | { kind: 'new' };

/**
 * Move the signed-in v1 account to one password (§3.11):
 * `POST /auth/credential/upgrade` with the legacy password, a new credential
 * and the identity's proof. Until it commits nothing changes. Returns the
 * phrase when a new identity was made (the phrase screen follows).
 */
export async function moveToOnePassword(input: {
  legacyPassword: string;
  newPassword: string;
  source: MoveIdentitySource;
}): Promise<{ phrase: string | null; user: User }> {
  const auth = useAuthStore.getState();
  const user = auth.user;
  if (!user?.id) throw new Error('Sign in first.');
  if (input.newPassword === input.legacyPassword) throw new CredentialError('invalid', SAME_AS_LEGACY_MESSAGE);
  const accountKey = user.public_key?.toLowerCase() ?? null;

  let privateKey: Uint8Array;
  if (input.source.kind === 'device') {
    if (useAccountStore.getState().isUnlocked && useAccountStore.getState().identityVersion === 1) {
      privateKey = await withUnlockedPrivateKey(async (key) => key.slice());
    } else {
      if (!input.source.encryptionPassword) throw new CredentialError('invalid', 'Enter the encryption password that unlocks this device.');
      privateKey = (await unlockAccount(input.source.encryptionPassword)).privateKey;
    }
  } else if (input.source.kind === 'phrase') {
    if (!accountKey) throw new CredentialError('invalid', 'This account has no identity to restore yet.');
    privateKey = await privateKeyFromPhraseFor(input.source.phrase, accountKey);
  } else {
    if (accountKey) {
      throw new CredentialError('identity_mismatch',
        'This account already has an identity. Enter its recovery phrase, or finish on the device that has your keys.');
    }
    privateKey = utils.randomSecretKey();
  }

  try {
    const prepared = await prepareNewIdentity(input.newPassword, { privateKey });
    if (accountKey && prepared.publicKey !== accountKey) {
      prepared.privateKey.fill(0);
      throw new CredentialError('identity_mismatch',
        "The identity on this device isn't this account's. Use your recovery phrase, or finish on the device that has your keys.");
    }
    const response = await authApi.credentialUpgrade({
      current_password: input.legacyPassword,
      credential: prepared.credential,
      identity: prepared.identity,
    });
    if (response.status === 401) {
      prepared.privateKey.fill(0);
      throw new CredentialError('invalid', "That isn't your current sign-in password.");
    }
    const phrase = input.source.kind === 'new' ? phraseFromPrivateKey(prepared.privateKey) : null;
    const keystore: AccountKeystoreV2 = {
      version: 2,
      homeOrigin: prepared.homeOrigin,
      userId: user.id,
      username: user.username,
      publicKey: prepared.publicKey,
      wrappedKey: prepared.identity.wrapped_key,
      kdf: prepared.credential.kdf,
      salt: prepared.credential.salt,
      epoch: response.data.epoch,
    };
    try {
      await installIdentity(keystore, prepared.privateKey, identifiersOf(null, user), { displayName: user.display_name });
    } finally {
      prepared.privateKey.fill(0);
    }
    // The legacy keystore was the only copy of this identity; the v2 keystore
    // and the server backup now are. One keystore per device.
    if (input.source.kind === 'device') await deleteLegacyKeystore();
    useAccountStore.getState().refreshIdentityVersion();
    clearLegacyPassword();
    await useAuthStore.getState().fetchUser();
    return { phrase, user: useAuthStore.getState().user ?? user };
  } finally {
    privateKey.fill(0);
  }
}

/** The legacy keystore's public key on this device, if there is one. */
export async function legacyDeviceIdentity(): Promise<string | null> {
  try {
    return (await getStoredKeystore())?.publicKey.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// ── Unlock (§3.5) ──────────────────────────────────────────────────────────

export type UnlockOutcome =
  | { kind: 'unlocked'; recoveryConfirmed: boolean | null }
  | { kind: 'mfa'; pending: PendingMfaSignIn };

/**
 * Unlock with the one password. Offline first: derive and unwrap the local
 * keystore. When that fails, the server's parameters decide: a newer epoch
 * means the password changed on another device, so this signs in with the
 * typed password and replaces the keystore from the backup. A device with no
 * keystore yet (signed in, identity never fetched) unwraps the backup.
 */
export async function unlockWithPassword(password: string): Promise<UnlockOutcome> {
  const keystore = await readKeystoreV2();
  if (keystore) {
    try {
      const privateKey = await unlockKeystoreV2(keystore, password);
      try {
        useAccountStore.getState().adoptIdentity(keystore, privateKey, useAccountStore.getState().displayName);
      } finally {
        privateKey.fill(0);
      }
      await applyRememberPolicy(keystore);
      return { kind: 'unlocked', recoveryConfirmed: await recoveryConfirmed() };
    } catch (error) {
      if (!isCredentialError(error, 'unwrap_failed')) throw error;
      const pin = findCredentialPin(keystore.homeOrigin, { userId: keystore.userId });
      let params: CredentialParams;
      try {
        params = await fetchParams(keystore.username, pin);
      } catch (paramsError) {
        // Offline (no answer at all), the local answer stands: wrong password.
        if (responseStatus(paramsError) === undefined && !isCredentialError(paramsError) && !(paramsError instanceof OlderServerError)) throw error;
        throw paramsError;
      }
      if (params.version !== 2 || params.epoch <= keystore.epoch) throw error;
      const outcome = await signInWithPassword(keystore.username, password);
      if (outcome.kind === 'mfa') return outcome;
      if (outcome.kind === 'legacy') throw error;
      return { kind: 'unlocked', recoveryConfirmed: outcome.recoveryConfirmed };
    }
  }

  const user = useAuthStore.getState().user;
  if (!user?.id || !useAuthStore.getState().token) throw new CredentialError('invalid', 'Sign in to unlock your account on this device.');
  const origin = homeOrigin();
  const pin = findCredentialPin(origin, { userId: user.id });
  const params = await fetchParams(user.username, pin);
  if (params.version !== 2) throw new CredentialError('invalid', 'This account still uses two passwords.');
  const { wrapKey } = await deriveCredentialKeysFromWire(password, params.salt, params.kdf);
  let backup;
  try {
    ({ data: backup } = await authApi.keyBackup());
  } catch (error) {
    if (responseStatus(error) === 404) throw new CredentialError('invalid', "This account has no keys saved on the server.");
    throw error;
  }
  checkPinnedIdentity(backup.public_key, pin);
  const next = keystoreFromBackup({ homeOrigin: origin, userId: user.id, username: user.username }, params, backup);
  const privateKey = await unwrapIdentity(wrapKey, next.wrappedKey, next.publicKey);
  try {
    await installIdentity(next, privateKey, identifiersOf(null, user), { displayName: user.display_name });
  } finally {
    privateKey.fill(0);
  }
  return { kind: 'unlocked', recoveryConfirmed: backup.recovery_confirmed };
}

/** Whether the account's phrase was confirmed, or `null` when the server could not be asked. */
async function recoveryConfirmed(): Promise<boolean | null> {
  if (!useAuthStore.getState().token) return null;
  try {
    return (await authApi.keyBackup()).data.recovery_confirmed;
  } catch {
    return null;
  }
}

/** Settings › Identity › "Show recovery phrase": the password again, then the words (memory only). */
export async function revealRecoveryPhrase(password: string): Promise<string> {
  const keystore = await readKeystoreV2();
  if (!keystore) throw new CredentialError('invalid', 'This device has no keys for this account yet. Unlock first.');
  const privateKey = await unlockKeystoreV2(keystore, password);
  try {
    return phraseFromPrivateKey(privateKey);
  } finally {
    privateKey.fill(0);
  }
}

/** The phrase of the identity that is unlocked right now (right after sign-in or sign-up). */
export const currentRecoveryPhrase = (): string | null => useAccountStore.getState().getRecoveryPhrase();

// ── Changing the password (§3.7) ───────────────────────────────────────────

/**
 * Change the one password. Keeps the identity: the same key is re-wrapped
 * under the new password, the server bumps the epoch and signs out the other
 * sessions; their next unlock takes the online path in {@link unlockWithPassword}.
 */
export async function changeOnePassword(input: { currentPassword: string; newPassword: string; mfaCode?: string }): Promise<{ epoch: number }> {
  const user = useAuthStore.getState().user;
  if (!user?.id) throw new Error('Sign in first.');
  if (!useAccountStore.getState().isUnlocked) throw new CredentialError('invalid', 'Unlock your account on this device first.');
  const origin = homeOrigin();
  const pin = findCredentialPin(origin, { userId: user.id });
  const params = await fetchParams(user.username, pin);
  if (params.version !== 2) throw new CredentialError('invalid', 'This account still uses two passwords.');
  const current = await deriveCredentialKeysFromWire(input.currentPassword, params.salt, params.kdf);
  const publicKey = useAccountStore.getState().publicKey;
  if (!publicKey) throw new CredentialError('invalid', 'Unlock your account on this device first.');
  const { credential, wrapKey } = await createCredential(input.newPassword);
  const wrapped = await withUnlockedPrivateKey((privateKey) => wrapIdentity(wrapKey, privateKey, publicKey));
  const response = await authApi.changeCredential({
    current_auth_key: current.authKey,
    credential,
    wrapped_key: wrapped,
    ...(input.mfaCode?.trim() ? { mfa_code: input.mfaCode.trim() } : {}),
  });
  if (response.status === 401) {
    throw new CredentialError('invalid', input.mfaCode?.trim()
      ? "That isn't your current password, or the code is wrong."
      : "That isn't your current password.");
  }
  const keystore: AccountKeystoreV2 = {
    version: 2,
    homeOrigin: origin,
    userId: user.id,
    username: user.username,
    publicKey,
    wrappedKey: wrapped,
    kdf: credential.kdf,
    salt: credential.salt,
    epoch: response.data.epoch,
  };
  await writeKeystoreV2(keystore, { replace: true });
  await recordCredentialPin({ homeOrigin: origin, userId: user.id, identifiers: identifiersOf(null, user), publicKey, kdf: credential.kdf });
  return { epoch: response.data.epoch };
}

// ── Recovery phrase (§3.8) ─────────────────────────────────────────────────

export interface RecoveredSession {
  user: User;
  privateKey: Uint8Array;
  publicKey: string;
}

export type RecoverOutcome =
  | { kind: 'signed-in'; recovered: RecoveredSession }
  | { kind: 'mfa'; ticket: string; privateKey: Uint8Array; publicKey: string };

/**
 * Sign in to the home server with the identity the phrase holds
 * (`/auth/challenge` + `/auth/verify`). The account must already have this
 * key (an unknown key is refused, never registered); the MFA gate applies.
 */
export async function recoverWithPhrase(phrase: string, username: string): Promise<RecoverOutcome> {
  const privateKey = privateKeyFromPhrase(phrase);
  try {
    const publicKey = toHex(await getPublicKeyAsync(privateKey));
    const origin = homeOrigin();
    const pin = findCredentialPin(origin, { identifier: username });
    if (pin && pin.publicKey !== publicKey) {
      throw new CredentialError('identity_mismatch', 'That recovery phrase belongs to a different account.');
    }
    const challenge = await freshChallenge();
    if (new URL(challenge.server_origin).origin !== origin) {
      throw new CredentialError('origin_mismatch', "The server signed this request for a different address. Paracord won't send it.");
    }
    const signature = await signChallenge(privateKey, challenge.nonce, challenge.timestamp, challenge.server_origin);
    // Sign in only: a phrase that belongs to no account here must not create one.
    let data: LoginResponse;
    try {
      ({ data } = await authApi.verifyKey({
        public_key: publicKey, nonce: challenge.nonce, timestamp: challenge.timestamp, signature,
        username: username.trim(), existing_account_only: true,
      }));
    } catch (error) {
      if (responseCode(error) === 'no_account_for_key') throw new CredentialError('no_account', NO_ACCOUNT_FOR_PHRASE_MESSAGE);
      throw error;
    }
    const ticket = mfaTicketOf(data);
    if (ticket) return { kind: 'mfa', ticket, privateKey, publicKey };
    return { kind: 'signed-in', recovered: adoptRecoveredSession(data, privateKey, publicKey) };
  } catch (error) {
    privateKey.fill(0);
    throw error;
  }
}

export async function completeRecoverMfa(pending: Extract<RecoverOutcome, { kind: 'mfa' }>, code: string): Promise<RecoveredSession> {
  const { data } = await authApi.mfaLogin(pending.ticket, code.trim());
  return adoptRecoveredSession(data, pending.privateKey, pending.publicKey);
}

function adoptRecoveredSession(session: LoginResponse, privateKey: Uint8Array, publicKey: string): RecoveredSession {
  if (session.user?.public_key?.toLowerCase() !== publicKey) {
    throw new CredentialError('identity_mismatch', "The server signed you in to an account that doesn't hold this recovery phrase's key.");
  }
  useAuthStore.getState().adoptSession(session);
  return { user: session.user, privateKey, publicKey };
}

/**
 * Choose a new password after a phrase sign-in:
 * `POST /users/@me/credential/reset` with a proof signed for purpose `reset`.
 * An account that still uses two passwords keeps the legacy device keystore
 * (the server answers `credential_legacy`); the new password then protects
 * the key on this device, as recovering did before one password.
 */
export async function setPasswordAfterRecovery(
  recovered: RecoveredSession,
  newPassword: string,
  mfaCode?: string,
): Promise<{ mode: 'one-password' | 'legacy' }> {
  const { user, privateKey, publicKey } = recovered;
  try {
    const origin = homeOrigin();
    const { credential, wrapKey } = await createCredential(newPassword);
    const wrapped = await wrapIdentity(wrapKey, privateKey, publicKey);
    const proof = await signCredentialProof(privateKey, PROOF_PURPOSE.reset, await freshChallenge(), origin);
    let response;
    try {
      response = await authApi.resetCredential({ credential, wrapped_key: wrapped, proof, ...(mfaCode?.trim() ? { mfa_code: mfaCode.trim() } : {}) });
    } catch (error) {
      const code = responseCode(error);
      if (code === 'credential_legacy' || code === 'credential_key_only') {
        await useAccountStore.getState().recover(phraseFromPrivateKey(privateKey), user.username, newPassword, user.display_name ?? undefined);
        return { mode: 'legacy' };
      }
      throw error;
    }
    if (response.status === 401) throw new CredentialError('invalid', 'The server refused the recovery sign-in. Check your two-factor code and try again.');
    const keystore: AccountKeystoreV2 = {
      version: 2,
      homeOrigin: origin,
      userId: user.id,
      username: user.username,
      publicKey,
      wrappedKey: wrapped,
      kdf: credential.kdf,
      salt: credential.salt,
      epoch: response.data.epoch,
    };
    await installIdentity(keystore, privateKey, identifiersOf(null, user), { displayName: user.display_name });
    return { mode: 'one-password' };
  } finally {
    privateKey.fill(0);
  }
}

// ── "Start over" (§3.9) ────────────────────────────────────────────────────

export const START_OVER_WARNING =
  "Your old private messages can't be opened with a new password. Use your recovery phrase instead if you have it.";

/**
 * The email-reset token with a brand-new identity and credential. The old
 * private messages stay unreadable; the person is told before (see
 * {@link START_OVER_WARNING}). Then signs in with the new password, moving
 * this device's pin to exactly the identity just made.
 * Returns `legacy` when the token's account still uses two passwords.
 */
export async function startOver(input: { token: string; identifier: string; newPassword: string }): Promise<SignInOutcome | { kind: 'legacy-reset' }> {
  const prepared = await prepareNewIdentity(input.newPassword, { purpose: PROOF_PURPOSE.reset });
  const publicKey = prepared.publicKey;
  try {
    await authApi.resetPasswordStartOver({ token: input.token.trim(), credential: prepared.credential, identity: prepared.identity });
  } catch (error) {
    if (responseCode(error) === 'credential_legacy') {
      await authApi.resetPassword(input.token.trim(), input.newPassword);
      return { kind: 'legacy-reset' };
    }
    throw error;
  } finally {
    prepared.privateKey.fill(0);
  }
  return signInWithPassword(input.identifier, input.newPassword, { replaceIdentityWith: publicKey });
}

/** A failure's sentence for the person (credential refusals carry their own). */
export function credentialErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CredentialError || error instanceof OlderServerError) return error.message;
  if (isMissingRoute(error)) return new OlderServerError('oneCredential').message;
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (typeof message === 'string' && message && message !== 'unauthorized') return message;
  if (responseStatus(error) === 401) return fallback;
  if (error && typeof error === 'object' && 'response' in error && !(error as { response?: unknown }).response) {
    return "Paracord couldn't reach the server. It may be restarting, or this computer can't see it.";
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export { UNWRAP_FAILED_MESSAGE };

/**
 * What is wrong with a new one password (§1.6 rules: 10 UTF-8 bytes, at most
 * 128, not common, not the username or display name), or `null`.
 */
export async function newPasswordProblem(password: string, names: { username?: string; displayName?: string } = {}): Promise<string | null> {
  const assessment = await assessNewPassword(password, names);
  if (assessment.acceptable) return null;
  if (assessment.tooLong) return 'That password is longer than Paracord accepts (128 bytes).';
  return assessment.help;
}

/** "Not now" on the move screen (§3.11): asked again next session, not on every navigation. */
export const MOVE_LATER_KEY = 'paracord:one-password-move-later';

export function moveDeferred(): boolean {
  try {
    return sessionStorage.getItem(MOVE_LATER_KEY) === '1';
  } catch {
    return false;
  }
}

export function deferMove(): void {
  try {
    sessionStorage.setItem(MOVE_LATER_KEY, '1');
  } catch {
    // No session storage: the guard asks again, which is the safe direction.
  }
}
