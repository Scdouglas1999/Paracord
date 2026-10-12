import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createAccount,
  unlockAccount,
  hasAccount,
  updateKeystoreProfile,
  deleteAccount,
  recoverFromPhrase,
} from '../lib/account';
import {
  clearUnlockedPrivateKey,
  getRecoveryPhraseFromUnlockedKey,
  setUnlockedPrivateKey,
} from '../lib/accountSession';
import { registerSessionReset } from './sessionReset';
import {
  deleteKeystoreV2,
  IDENTITY_KEYSTORE_V2_STORAGE_KEY,
  readKeystoreV2,
  type AccountKeystoreV2,
} from '../lib/credential/keystoreV2';
import { forgetIdentity, recallIdentity } from '../lib/rememberedUnlock';

/** Which keystore this device holds: the one-password keystore (2), the legacy one (1), or none. */
export type IdentityVersion = 1 | 2 | null;

/** A cheap presence check (no lock, no parse): the store's routing needs it synchronously. */
export function deviceIdentityVersion(): IdentityVersion {
  try {
    if (localStorage.getItem(IDENTITY_KEYSTORE_V2_STORAGE_KEY) !== null) return 2;
  } catch {
    return null;
  }
  return hasAccount() ? 1 : null;
}

interface AccountState {
  // Public info (persisted)
  publicKey: string | null;
  username: string | null;
  displayName: string | null;

  // Runtime state (not persisted)
  isUnlocked: boolean;
  isLoading: boolean;
  error: string | null;
  /** The keystore this device holds (re-read after every identity change). */
  identityVersion: IdentityVersion;
  /** Desktop: the launch-time keychain restore (§3.5) has not run, is running, or is over. */
  restoreState: 'idle' | 'pending' | 'done';
  /** Why the identity could not be remembered in the keychain, shown in Settings › Privacy. */
  rememberProblem: string | null;
  /** Where to go once `/unlock` succeeds when a guard sent the person there. */
  unlockReturnTo: string | null;
  /**
   * A sign-in or sign-up page is mid-flow (the session exists, the phrase
   * screen may follow): the signed-in redirect off `/login` and `/register`
   * waits until the page finishes.
   */
  accountFlowActive: boolean;

  // Actions
  create: (username: string, password: string, displayName?: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  updateProfile: (username: string, displayName?: string) => Promise<void>;
  getRecoveryPhrase: () => string | null;
  recover: (phrase: string, username: string, password: string, displayName?: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  clearError: () => void;
  hasAccount: () => boolean;
  /** Install a one-password identity that was just unwrapped (sign-in, sign-up, unlock, move). */
  adoptIdentity: (keystore: AccountKeystoreV2, privateKey: Uint8Array, displayName?: string | null) => void;
  /** Desktop launch: unlock from the keychain when the identity was remembered. */
  restoreRemembered: () => Promise<void>;
  /** Sign-out: remove the one-password keystore and its keychain entry from this device. */
  forgetDeviceIdentity: () => Promise<void>;
  refreshIdentityVersion: () => void;
  setRememberProblem: (problem: string | null) => void;
  setUnlockReturnTo: (path: string | null) => void;
  setAccountFlowActive: (active: boolean) => void;
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set, get) => ({
      publicKey: null,
      username: null,
      displayName: null,
      isUnlocked: false,
      isLoading: false,
      error: null,
      identityVersion: deviceIdentityVersion(),
      restoreState: 'idle',
      rememberProblem: null,
      unlockReturnTo: null,
      accountFlowActive: false,

      create: async (username, password, displayName) => {
        set({ isLoading: true, error: null });
        try {
          const account = await createAccount(username, password, displayName);
          setUnlockedPrivateKey(account.privateKey);
          set({
            publicKey: account.publicKey,
            username: account.username,
            displayName: account.displayName || null,
            isUnlocked: true,
            isLoading: false,
            identityVersion: deviceIdentityVersion(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to create account';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      unlock: async (password) => {
        set({ isLoading: true, error: null });
        try {
          const account = await unlockAccount(password);
          setUnlockedPrivateKey(account.privateKey);
          set({
            publicKey: account.publicKey,
            username: account.username,
            displayName: account.displayName || null,
            isUnlocked: true,
            isLoading: false,
            identityVersion: deviceIdentityVersion(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to unlock account';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      lock: () => {
        clearUnlockedPrivateKey();
        set({
          isUnlocked: false,
        });
      },

      updateProfile: async (username, displayName) => {
        await updateKeystoreProfile(username, displayName);
        set({ username, displayName: displayName || null });
      },

      getRecoveryPhrase: () => {
        return getRecoveryPhraseFromUnlockedKey();
      },

      recover: async (phrase, username, password, displayName) => {
        set({ isLoading: true, error: null });
        try {
          const account = await recoverFromPhrase(phrase, username, password, displayName);
          setUnlockedPrivateKey(account.privateKey);
          set({
            publicKey: account.publicKey,
            username: account.username,
            displayName: account.displayName || null,
            isUnlocked: true,
            isLoading: false,
            identityVersion: deviceIdentityVersion(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to recover account';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      deleteAccount: async () => {
        await deleteAccount();
        clearUnlockedPrivateKey();
        set({
          publicKey: null,
          username: null,
          displayName: null,
          isUnlocked: false,
          identityVersion: deviceIdentityVersion(),
        });
      },

      clearError: () => set({ error: null }),

      hasAccount: () => hasAccount(),

      adoptIdentity: (keystore, privateKey, displayName) => {
        setUnlockedPrivateKey(privateKey);
        set({
          publicKey: keystore.publicKey,
          username: keystore.username,
          displayName: displayName || null,
          isUnlocked: true,
          isLoading: false,
          error: null,
          identityVersion: 2,
          restoreState: 'done',
        });
      },

      restoreRemembered: async () => {
        if (get().restoreState !== 'idle') return;
        set({ restoreState: 'pending' });
        try {
          const keystore = await readKeystoreV2();
          if (!keystore || get().isUnlocked) return;
          const privateKey = await recallIdentity(keystore.homeOrigin, keystore.userId, keystore.publicKey);
          if (!privateKey || get().isUnlocked) {
            privateKey?.fill(0);
            return;
          }
          get().adoptIdentity(keystore, privateKey, get().displayName);
        } catch {
          // A keystore that cannot be read is reported by /unlock, which reads it again.
        } finally {
          set({ restoreState: 'done' });
        }
      },

      forgetDeviceIdentity: async () => {
        const keystore = await readKeystoreV2().catch(() => null);
        if (keystore) await forgetIdentity(keystore.homeOrigin, keystore.userId);
        await deleteKeystoreV2();
        clearUnlockedPrivateKey();
        set({ isUnlocked: false, identityVersion: deviceIdentityVersion() });
      },

      refreshIdentityVersion: () => set({ identityVersion: deviceIdentityVersion() }),
      setRememberProblem: (problem) => set({ rememberProblem: problem }),
      setUnlockReturnTo: (path) => set({ unlockReturnTo: path }),
      setAccountFlowActive: (active) => set({ accountFlowActive: active }),
    }),
    {
      name: 'paracord:account-store',
      partialize: (state) => ({
        publicKey: state.publicKey,
        username: state.username,
        displayName: state.displayName,
      }),
    }
  )
);

/**
 * Signing out locks the device identity.
 *
 * Nothing called `lock()` anywhere in the app, so the unlocked private key
 * outlived the session it was unlocked for. With device-key sign-in working,
 * that is not a stale flag: the gateway's challenge-response saw an unlocked
 * key and signed straight back in — `POST /auth/logout` 204 followed four
 * milliseconds later by `/auth/challenge` and `/auth/verify`, and the user who
 * asked to sign out was still signed in. A session that ends takes the key
 * that could reopen it with it.
 */
registerSessionReset('account-identity', () => useAccountStore.getState().lock());
