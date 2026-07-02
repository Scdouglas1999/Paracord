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

interface AccountState {
  // Public info (persisted)
  publicKey: string | null;
  username: string | null;
  displayName: string | null;

  // Runtime state (not persisted)
  isUnlocked: boolean;
  isLoading: boolean;
  error: string | null;

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
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set) => ({
      publicKey: null,
      username: null,
      displayName: null,
      isUnlocked: false,
      isLoading: false,
      error: null,

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
        });
      },

      clearError: () => set({ error: null }),

      hasAccount: () => hasAccount(),
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
