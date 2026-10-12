// @vitest-environment jsdom
import { getPublicKeyAsync, utils, verifyAsync } from '@noble/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialParams } from '../api/generated/CredentialParams';
import type { NewCredential, NewIdentity } from '../api/generated/CredentialRegister';

/**
 * The one-password flows against an in-memory home server that checks what the
 * real one checks (auth keys, proofs and their purposes, epochs, versions).
 * The KDF runs for real (the inline worker), so these exercise the whole
 * derivation → wrap → proof → keystore → pin path.
 */

const ORIGIN = 'https://home.test';
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
const utf8 = (text: string) => new TextEncoder().encode(text);

interface FakeUser {
  id: string;
  username: string;
  email: string;
  version: 1 | 2;
  legacyPassword?: string;
  authKey?: string;
  salt?: string;
  kdf?: NewCredential['kdf'];
  epoch: number;
  publicKey: string | null;
  backup?: { wrapped_key: string; recovery_confirmed: boolean };
  settings: Record<string, unknown>;
}

const server = vi.hoisted(() => ({
  users: [] as FakeUser[],
  session: null as string | null,
  nonces: new Set<string>(),
  requests: [] as string[],
  resetTokens: new Map<string, string>(),
  nextId: 100,
  /** Lets a test serve a swapped backup or a downgrade. */
  tamper: {} as { backupKey?: string; params?: CredentialParams },
}));

const apiError = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });

function userPayload(user: FakeUser) {
  return { id: user.id, username: user.username, email: user.email, public_key: user.publicKey, display_name: null, discriminator: 0, flags: 0 };
}

function find(identifier: string): FakeUser | undefined {
  const key = identifier.trim().toLowerCase();
  return server.users.find((user) => user.username.toLowerCase() === key || user.email.toLowerCase() === key);
}

function current(): FakeUser {
  const user = server.users.find((candidate) => candidate.id === server.session);
  if (!user) throw apiError(401);
  return user;
}

async function verifyProof(purpose: 'register' | 'reset', publicKey: string, proof: NewIdentity['proof']) {
  if (!server.nonces.delete(proof.nonce)) throw apiError(401, { message: 'nonce' });
  const message = `paracord/credential/v2/${purpose}:${proof.nonce}:${proof.timestamp}:${ORIGIN}`;
  if (!await verifyAsync(fromHex(proof.signature), utf8(message), fromHex(publicKey))) throw apiError(401, { message: 'proof' });
}

function session(user: FakeUser) {
  server.session = user.id;
  return { data: { token: `token-${user.id}-${Math.random()}`, refresh_token: 'refresh', user: userPayload(user) } };
}

const record = (name: string, body?: unknown) => { server.requests.push(`${name} ${JSON.stringify(body ?? null)}`); };

vi.mock('../api/auth', () => ({
  authApi: {
    options: async () => ({ data: { allow_username_login: true, require_email: false, credential_version: 2 } }),
    challenge: async () => {
      const nonce = `n${Math.random().toString(36).slice(2)}`;
      server.nonces.add(nonce);
      return { data: { nonce, timestamp: Math.floor(Date.now() / 1000), server_origin: ORIGIN } };
    },
    credentialParams: async (identifier: string) => {
      record('params', identifier);
      if (server.tamper.params) return { data: server.tamper.params };
      const user = find(identifier);
      if (user?.version === 1) return { data: { version: 1 } };
      if (user) return { data: { version: 2, kdf: user.kdf, salt: user.salt, epoch: user.epoch } };
      return { data: { version: 2, kdf: { alg: 'scrypt', log_n: 17, r: 8, p: 1 }, salt: 'A'.repeat(43), epoch: 1 } };
    },
    credentialRegister: async (body: { username: string; email?: string | null; credential: NewCredential; identity: NewIdentity }) => {
      record('register', body);
      await verifyProof('register', body.identity.public_key, body.identity.proof);
      const user: FakeUser = {
        id: String(server.nextId++), username: body.username, email: body.email ?? `${body.username}@example.test`, version: 2,
        authKey: body.credential.auth_key, salt: body.credential.salt, kdf: body.credential.kdf, epoch: 1,
        publicKey: body.identity.public_key, backup: { wrapped_key: body.identity.wrapped_key, recovery_confirmed: false }, settings: {},
      };
      server.users.push(user);
      return session(user);
    },
    credentialLogin: async (identifier: string, authKey: string) => {
      record('login', { identifier, authKey });
      const user = find(identifier);
      if (user?.version === 1) throw apiError(409, { code: 'credential_legacy' });
      if (!user || user.authKey !== authKey) throw apiError(401, { message: 'unauthorized' });
      return session(user);
    },
    login: async (body: { identifier: string; password: string }) => {
      record('legacy-login', body);
      const user = find(body.identifier);
      if (user?.version === 2) throw apiError(409, { code: 'credential_upgraded' });
      if (!user || user.legacyPassword !== body.password) throw apiError(401);
      return session(user);
    },
    keyBackup: async () => {
      const user = current();
      if (!user.backup || !user.publicKey) throw apiError(404);
      return { data: { public_key: server.tamper.backupKey ?? user.publicKey, wrapped_key: user.backup.wrapped_key, wrap_alg: 'aes256gcm-v2', epoch: user.epoch, recovery_confirmed: user.backup.recovery_confirmed } };
    },
    confirmRecoverySaved: async () => { current().backup!.recovery_confirmed = true; return { status: 204 }; },
    changeCredential: async (body: { current_auth_key: string; credential: NewCredential; wrapped_key: string }) => {
      record('change', body);
      const user = current();
      if (user.authKey !== body.current_auth_key) return { status: 401, data: {} };
      Object.assign(user, { authKey: body.credential.auth_key, salt: body.credential.salt, kdf: body.credential.kdf, epoch: user.epoch + 1 });
      user.backup!.wrapped_key = body.wrapped_key;
      return { status: 200, data: { epoch: user.epoch } };
    },
    credentialUpgrade: async (body: { current_password: string; credential: NewCredential; identity: NewIdentity }) => {
      record('upgrade', body);
      const user = current();
      if (user.version !== 1) throw apiError(409, { code: 'credential_upgraded' });
      if (user.legacyPassword !== body.current_password) return { status: 401, data: {} };
      if (user.publicKey && user.publicKey !== body.identity.public_key) throw apiError(409, { code: 'identity_mismatch' });
      await verifyProof('register', body.identity.public_key, body.identity.proof);
      Object.assign(user, { version: 2, legacyPassword: undefined, authKey: body.credential.auth_key, salt: body.credential.salt,
        kdf: body.credential.kdf, epoch: 1, publicKey: body.identity.public_key, backup: { wrapped_key: body.identity.wrapped_key, recovery_confirmed: false } });
      return { status: 200, data: { epoch: 1 } };
    },
    verifyKey: async (body: { public_key: string; nonce: string; timestamp: number; signature: string; username: string; existing_account_only?: boolean }) => {
      if (!server.nonces.delete(body.nonce)) throw apiError(401);
      if (!await verifyAsync(fromHex(body.signature), utf8(`${body.nonce}:${body.timestamp}:${ORIGIN}`), fromHex(body.public_key))) throw apiError(401);
      const user = server.users.find((candidate) => candidate.publicKey === body.public_key);
      if (user) return session(user);
      // As the real server: an unknown key makes a key-only account, unless the
      // caller signs in only.
      if (body.existing_account_only) throw apiError(404, { code: 'no_account_for_key', message: 'No account on this server uses that recovery phrase.' });
      record('key-signup', body);
      const created: FakeUser = { id: String(server.nextId++), username: body.username, email: `${body.public_key}@pubkey`, version: 1, epoch: 0, publicKey: body.public_key, settings: {} };
      server.users.push(created);
      return session(created);
    },
    resetCredential: async (body: { credential: NewCredential; wrapped_key: string; proof: NewIdentity['proof'] }) => {
      record('reset', body);
      const user = current();
      if (user.version !== 2) throw apiError(409, { code: 'credential_legacy' });
      await verifyProof('reset', user.publicKey!, body.proof);
      Object.assign(user, { authKey: body.credential.auth_key, salt: body.credential.salt, kdf: body.credential.kdf, epoch: user.epoch + 1 });
      user.backup!.wrapped_key = body.wrapped_key;
      return { status: 200, data: { epoch: user.epoch } };
    },
    resetPasswordStartOver: async (body: { token: string; credential: NewCredential; identity: NewIdentity }) => {
      record('start-over', body);
      const user = server.users.find((candidate) => candidate.id === server.resetTokens.get(body.token));
      if (!user) throw apiError(400);
      if (user.version !== 2) throw apiError(409, { code: 'credential_legacy' });
      await verifyProof('reset', body.identity.public_key, body.identity.proof);
      server.resetTokens.delete(body.token);
      Object.assign(user, { authKey: body.credential.auth_key, salt: body.credential.salt, kdf: body.credential.kdf, epoch: user.epoch + 1,
        publicKey: body.identity.public_key, backup: { wrapped_key: body.identity.wrapped_key, recovery_confirmed: false } });
      server.session = null;
      return { data: { epoch: user.epoch, message: 'ok' } };
    },
    resetPassword: async () => ({ data: { message: 'ok' } }),
    mfaLogin: async () => { throw apiError(401); },
    logout: async () => { server.session = null; return { status: 204 }; },
    getMe: async () => ({ data: userPayload(current()) }),
    getSettings: async () => ({ data: { crypto_auth_enabled: false, notifications: { ...current().settings } } }),
    updateSettings: async (data: { notifications?: Record<string, unknown> }) => {
      const user = current();
      if (data.notifications) user.settings = { ...data.notifications };
      return { data: { crypto_auth_enabled: false, notifications: { ...user.settings } } };
    },
  },
}));

vi.mock('./config/apiBaseUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config/apiBaseUrl')>()),
  resolveApiBaseUrl: () => `${ORIGIN}/api/v1`,
}));

const { setKdfWorkerFactory } = await import('./credential/derive');
const { InlineKdfWorker, installTestLocks } = await import('./credential/testWorker');
const { CredentialError } = await import('./credential/errors');
const { phraseFromPrivateKey, privateKeyFromPhrase } = await import('./credential/phrase');
const { readKeystoreV2, findCredentialPin } = await import('./credential/keystoreV2');
const { createAccount, getStoredKeystore } = await import('./account');
const { useAccountStore } = await import('../stores/accountStore');
const { useAuthStore } = await import('../stores/authStore');
const flows = await import('./oneCredential');

const PASSWORD = 'correct horse battery staple';
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Another device: nothing in this browser's storage, nothing unlocked. */
function newDevice() {
  localStorage.clear();
  useAccountStore.getState().lock();
  useAccountStore.setState({ publicKey: null, username: null, identityVersion: null, restoreState: 'idle' });
  useAuthStore.setState({ token: null, user: null, settings: null, hasFetchedSettings: false });
  server.session = null;
}

function snapshotDevice(): Record<string, string> {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!);
  return Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)!]));
}

function restoreDevice(snapshot: Record<string, string>) {
  newDevice();
  for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
  useAccountStore.getState().refreshIdentityVersion();
}

beforeEach(() => {
  server.users = [];
  server.session = null;
  server.nonces.clear();
  server.requests = [];
  server.resetTokens.clear();
  server.tamper = {};
  installTestLocks();
  setKdfWorkerFactory(() => new InlineKdfWorker());
  newDevice();
});
afterEach(() => setKdfWorkerFactory(null));

async function signUp(username = 'sam') {
  return flows.signUpWithPassword({ username, password: PASSWORD, email: `${username}@example.test` });
}

describe('one-password flows', { timeout: 120_000 }, () => {
  it('signs up: the server gets an auth key and a proof, never the password; the device keeps a v2 keystore and a pin', async () => {
    const { user, phrase, privacyDefaultsError } = await signUp();
    expect(privacyDefaultsError).toBeNull();
    expect(server.requests.join('\n')).not.toContain(PASSWORD);

    const keystore = await readKeystoreV2();
    expect(keystore).toMatchObject({ version: 2, homeOrigin: ORIGIN, userId: user.id, username: 'sam', epoch: 1 });
    const stored = server.users[0];
    expect(keystore!.publicKey).toBe(stored.publicKey);
    expect(findCredentialPin(ORIGIN, { identifier: 'SAM@example.test' })?.publicKey).toBe(stored.publicKey);

    // The phrase is the identity itself.
    expect(toHex(await getPublicKeyAsync(privateKeyFromPhrase(phrase)))).toBe(stored.publicKey);
    expect(useAccountStore.getState()).toMatchObject({ isUnlocked: true, identityVersion: 2, publicKey: stored.publicKey });
    // "Show what I'm playing" is recorded as off, not left absent.
    expect(stored.settings.activityDetectionEnabled).toBe(false);
  });

  it('signs in on a second device and gets the same identity from the backup', async () => {
    await signUp();
    const publicKey = server.users[0].publicKey;
    newDevice();

    const outcome = await flows.signInWithPassword('sam', PASSWORD);
    expect(outcome).toMatchObject({ kind: 'signed-in', recoveryConfirmed: false });
    expect(useAccountStore.getState()).toMatchObject({ isUnlocked: true, publicKey });
    expect((await readKeystoreV2())?.publicKey).toBe(publicKey);
    expect(flows.currentRecoveryPhrase()?.split(' ')).toHaveLength(24);

    await flows.confirmRecoverySaved();
    newDevice();
    expect(await flows.signInWithPassword('sam', PASSWORD)).toMatchObject({ kind: 'signed-in', recoveryConfirmed: true });
  });

  it('refuses a wrong password with the server’s answer and keeps nothing', async () => {
    await signUp();
    newDevice();
    await expect(flows.signInWithPassword('sam', 'not the password at all')).rejects.toMatchObject({ response: { status: 401 } });
    expect(await readKeystoreV2()).toBeNull();
    expect(useAccountStore.getState().isUnlocked).toBe(false);
  });

  it('refuses a downgrade for a pinned account before anything is derived or sent', async () => {
    await signUp();
    const device = snapshotDevice();
    restoreDevice(device);
    server.requests = [];

    server.tamper.params = { version: 1 };
    await expect(flows.signInWithPassword('sam', PASSWORD)).rejects.toMatchObject({ code: 'downgrade' });
    await expect(flows.legacySignIn('sam', PASSWORD)).rejects.toMatchObject({ code: 'downgrade' });

    server.tamper.params = { version: 2, kdf: { alg: 'scrypt', log_n: 17, r: 8, p: 1 }, salt: server.users[0].salt!, epoch: 1 };
    server.users[0].kdf = { alg: 'scrypt', log_n: 18, r: 8, p: 1 };
    // Pin the stronger parameters, then offer the weaker ones.
    const { recordCredentialPin } = await import('./credential/keystoreV2');
    await recordCredentialPin({ homeOrigin: ORIGIN, userId: server.users[0].id, identifiers: ['sam'], publicKey: server.users[0].publicKey!, kdf: { alg: 'scrypt', log_n: 18, r: 8, p: 1 } });
    await expect(flows.signInWithPassword('sam', PASSWORD)).rejects.toMatchObject({ code: 'downgrade' });

    expect(server.requests.filter((line) => line.startsWith('login') || line.startsWith('legacy-login'))).toEqual([]);
  });

  it('refuses a swapped backup and does not keep the session', async () => {
    await signUp();
    const device = snapshotDevice();
    restoreDevice(device);
    server.tamper.backupKey = 'ab'.repeat(32);
    await expect(flows.signInWithPassword('sam', PASSWORD)).rejects.toBeInstanceOf(CredentialError);
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAccountStore.getState().isUnlocked).toBe(false);
  });

  it('a password change keeps the identity, and another device unlocks with the new password from the server', async () => {
    await signUp();
    const otherDevice = snapshotDevice();
    const publicKey = server.users[0].publicKey;

    const { epoch } = await flows.changeOnePassword({ currentPassword: PASSWORD, newPassword: 'a different long passphrase' });
    expect(epoch).toBe(2);
    expect(server.users[0].publicKey).toBe(publicKey);
    expect((await readKeystoreV2())?.epoch).toBe(2);
    await expect(flows.changeOnePassword({ currentPassword: PASSWORD, newPassword: 'yet another long passphrase' }))
      .rejects.toThrow("That isn't your current password.");

    // The other device still holds the epoch-1 keystore: the new password does
    // not open it locally, the server's epoch is newer, so it signs in again.
    restoreDevice(otherDevice);
    expect((await readKeystoreV2())?.epoch).toBe(1);
    await expect(flows.unlockWithPassword(PASSWORD)).resolves.toMatchObject({ kind: 'unlocked' });
    useAccountStore.getState().lock();
    restoreDevice(otherDevice);
    const outcome = await flows.unlockWithPassword('a different long passphrase');
    expect(outcome.kind).toBe('unlocked');
    expect((await readKeystoreV2())?.epoch).toBe(2);
    expect(useAccountStore.getState().publicKey).toBe(publicKey);
  });

  it('unlocks offline and says when the password is wrong', async () => {
    await signUp();
    useAccountStore.getState().lock();
    await expect(flows.unlockWithPassword('wrong wrong wrong wrong')).rejects.toMatchObject({ code: 'unwrap_failed' });
    await expect(flows.unlockWithPassword(PASSWORD)).resolves.toMatchObject({ kind: 'unlocked' });
    expect(useAccountStore.getState().isUnlocked).toBe(true);
  });

  it('moves a v1 account with no identity to one password, refusing the old sign-in password', async () => {
    server.users.push({ id: '7', username: 'old', email: 'old@example.test', version: 1, legacyPassword: 'old sign-in password', epoch: 0, publicKey: null, settings: {} });
    expect(await flows.signInWithPassword('old', 'anything at all')).toEqual({ kind: 'legacy' });
    expect(server.requests.some((line) => line.startsWith('login'))).toBe(false);

    await flows.legacySignIn('old', 'old sign-in password');
    expect(flows.takeLegacyPassword()).toBe('old sign-in password');
    await expect(flows.moveToOnePassword({ legacyPassword: 'old sign-in password', newPassword: 'old sign-in password', source: { kind: 'new' } }))
      .rejects.toThrow(flows.SAME_AS_LEGACY_MESSAGE);

    const { phrase } = await flows.moveToOnePassword({ legacyPassword: 'old sign-in password', newPassword: PASSWORD, source: { kind: 'new' } });
    expect(server.users[0]).toMatchObject({ version: 2, epoch: 1 });
    expect(toHex(await getPublicKeyAsync(privateKeyFromPhrase(phrase!)))).toBe(server.users[0].publicKey);
    expect(flows.takeLegacyPassword()).toBeNull();

    newDevice();
    expect(await flows.signInWithPassword('old', PASSWORD)).toMatchObject({ kind: 'signed-in' });
  });

  it('moves a v1 account whose identity is on this device, keeping that identity', async () => {
    const legacy = await createAccount('dev', 'device encryption password');
    const publicKey = legacy.publicKey;
    legacy.privateKey.fill(0);
    server.users.push({ id: '8', username: 'dev', email: 'dev@example.test', version: 1, legacyPassword: 'old sign-in password', epoch: 0, publicKey, settings: {} });
    await flows.legacySignIn('dev', 'old sign-in password');
    expect(await flows.legacyDeviceIdentity()).toBe(publicKey);

    const result = await flows.moveToOnePassword({
      legacyPassword: 'old sign-in password',
      newPassword: 'device encryption password',
      source: { kind: 'device', encryptionPassword: 'device encryption password' },
    });
    expect(result.phrase).toBeNull();
    expect(server.users[0]).toMatchObject({ version: 2, publicKey });
    expect(await getStoredKeystore()).toBeNull();
    expect((await readKeystoreV2())?.publicKey).toBe(publicKey);
  });

  it('recovers with the phrase, sets a new password everywhere, and keeps the identity', async () => {
    const { phrase } = await signUp();
    const publicKey = server.users[0].publicKey;
    newDevice();

    const outcome = await flows.recoverWithPhrase(phrase, 'sam');
    expect(outcome.kind).toBe('signed-in');
    if (outcome.kind !== 'signed-in') return;
    await expect(flows.setPasswordAfterRecovery(outcome.recovered, 'the brand new passphrase')).resolves.toEqual({ mode: 'one-password' });
    expect(server.users[0]).toMatchObject({ epoch: 2, publicKey });
    expect(useAccountStore.getState().publicKey).toBe(publicKey);

    newDevice();
    expect(await flows.signInWithPassword('sam', 'the brand new passphrase')).toMatchObject({ kind: 'signed-in' });
  });

  it('refuses a phrase no account on the server uses, and creates nothing', async () => {
    await signUp();
    newDevice();
    const stranger = phraseFromPrivateKey(utils.randomSecretKey());
    await expect(flows.recoverWithPhrase(stranger, 'someone')).rejects.toMatchObject({
      code: 'no_account',
      message: 'No account on this server uses that recovery phrase.',
    });
    expect(server.users).toHaveLength(1);
    expect(server.requests.some((request) => request.startsWith('key-signup'))).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('starts over with a new identity and moves this device’s pin to exactly it', async () => {
    await signUp();
    const oldKey = server.users[0].publicKey;
    server.resetTokens.set('reset-token', server.users[0].id);
    useAccountStore.getState().lock();
    useAuthStore.setState({ token: null, user: null });

    const outcome = await flows.startOver({ token: 'reset-token', identifier: 'sam', newPassword: 'a fresh start passphrase' });
    expect(outcome).toMatchObject({ kind: 'signed-in', recoveryConfirmed: false });
    const newKey = server.users[0].publicKey;
    expect(newKey).not.toBe(oldKey);
    expect(findCredentialPin(ORIGIN, { identifier: 'sam' })?.publicKey).toBe(newKey);
    expect(useAccountStore.getState().publicKey).toBe(newKey);
  });

  it('reveals the phrase only with the password', async () => {
    const { phrase } = await signUp();
    await expect(flows.revealRecoveryPhrase('not my password at all')).rejects.toMatchObject({ code: 'unwrap_failed' });
    await expect(flows.revealRecoveryPhrase(PASSWORD)).resolves.toBe(phrase);
  });

  it('sign-out removes the keystore but keeps the pin', async () => {
    await signUp();
    await useAuthStore.getState().logout();
    expect(await readKeystoreV2()).toBeNull();
    expect(useAccountStore.getState()).toMatchObject({ isUnlocked: false, identityVersion: null });
    expect(findCredentialPin(ORIGIN, { identifier: 'sam' })).not.toBeNull();
  });
});
