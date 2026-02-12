import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createAccount,
  unlockAccount,
  hasAccount,
  updateKeystoreProfile,
  deleteAccount,
  generateRecoveryPhrase,
  recoverFromPhrase,
} from '../lib/account';

interface AccountState {
  // Public info (persisted)
  publicKey: string | null;
  username: string | null;
  displayName: string | null;

  // Runtime state (not persisted)
  isUnlocked: boolean;
  privateKey: Uint8Array | null; // in-memory only, never persisted
  isLoading: boolean;
  error: string | null;

  // Actions
  create: (username: string, password: string, displayName?: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  updateProfile: (username: string, displayName?: string) => void;
  getRecoveryPhrase: () => string | null;
  recover: (phrase: string, username: string, password: string, displayName?: string) => Promise<void>;
  deleteAccount: () => void;
  clearError: () => void;
  hasAccount: () => boolean;
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set, get) => ({
      publicKey: null,
      username: null,
      displayName: null,
      isUnlocked: false,
      privateKey: null,
      isLoading: false,
      error: null,

      create: async (username, password, displayName) => {
        set({ isLoading: true, error: null });
        try {
          const account = await createAccount(username, password, displayName);
          set({
            publicKey: account.publicKey,
            username: account.username,
            displayName: account.displayName || null,
            isUnlocked: true,
            privateKey: account.privateKey,
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
          set({
            publicKey: account.publicKey,
            username: account.username,
            displayName: account.displayName || null,
            isUnlocked: true,
            privateKey: account.privateKey,
            isLoading: false,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to unlock account';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      lock: () => {
        set({
          isUnlocked: false,
          privateKey: null,
        });
      },

      updateProfile: (username, displayName) => {
        updateKeystoreProfile(username, displayName);
        set({ username, displayName: displayName || null });
      },

      getRecoveryPhrase: () => {
        const { privateKey } = get();
        if (!privateKey) return null;
        return generateRecoveryPhrase(privateKey);
      },

      recover: async (phrase, username, password, displayName) => {
        set({ isLoading: true, error: null });
        try {
          const account = await recoverFromPhrase(phrase, username, password, displayName);
          set({
            publicKey: account.publicKey,
            username: account.username,
            displayName: account.displayName || null,
            isUnlocked: true,
            privateKey: account.privateKey,
            isLoading: false,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to recover account';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      deleteAccount: () => {
        deleteAccount();
        set({
          publicKey: null,
          username: null,
          displayName: null,
          isUnlocked: false,
          privateKey: null,
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
