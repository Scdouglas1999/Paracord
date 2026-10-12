import { create } from 'zustand';

/**
 * "Ask for my password when Paracord opens" (docs/setup-spec.md §3.5) is a
 * choice about **this computer**, not about the account: turning it on at
 * work must not make the home computer start asking. It lives in this
 * device's storage, never in account settings.
 *
 * Accounts that chose it before it moved here have it as the account setting
 * `crypto_auth_enabled`. The first time a device reads the choice and has none
 * of its own, it adopts that account value once (`adoptAccountChoice`); after
 * that, only this device's switch changes it.
 *
 * Fails closed: when this device's storage cannot be read, the answer is
 * "ask", so the key is never remembered on a guess.
 */

export const ASK_FOR_PASSWORD_KEY = 'paracord:ask-for-password:v1';

/** `null`: this device has never chosen. `'unreadable'`: storage refused. */
export type DeviceChoice = boolean | null | 'unreadable';

function readStored(): DeviceChoice {
  try {
    const raw = window.localStorage.getItem(ASK_FOR_PASSWORD_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return 'unreadable';
  }
}

interface AskForPasswordState {
  choice: DeviceChoice;
}

export const useAskForPasswordStore = create<AskForPasswordState>(() => ({ choice: readStored() }));

/** This device's choice as stored (re-read, so another tab's change counts). */
export function deviceAskChoice(): DeviceChoice {
  const choice = readStored();
  if (useAskForPasswordStore.getState().choice !== choice) useAskForPasswordStore.setState({ choice });
  return choice;
}

/** Record this device's choice. Throws with a sentence when the device cannot keep it. */
export function setDeviceAskChoice(ask: boolean): void {
  try {
    window.localStorage.setItem(ASK_FOR_PASSWORD_KEY, ask ? 'true' : 'false');
  } catch (error) {
    useAskForPasswordStore.setState({ choice: readStored() });
    throw new Error(`This computer couldn't save the choice (${error instanceof Error ? error.message : String(error)}).`);
  }
  useAskForPasswordStore.setState({ choice: ask });
}

/**
 * The effective answer for this device, adopting the account's old value when
 * the device has never chosen. `accountValue` is `undefined` when the account
 * settings are not known: then an unchosen device asks and nothing is saved.
 */
export function adoptAccountChoice(accountValue: boolean | undefined): boolean {
  const choice = deviceAskChoice();
  if (choice === 'unreadable') return true;
  if (choice !== null) return choice;
  if (accountValue === undefined) return true;
  try {
    setDeviceAskChoice(accountValue);
  } catch {
    // Not saved: still answer for now; the next read adopts it again.
  }
  return accountValue;
}

/** The switch's position: this device's choice, or the account's old value until the device adopts it. */
export function useAskForPasswordOnThisDevice(accountValue: boolean): boolean {
  const choice = useAskForPasswordStore((s) => s.choice);
  if (choice === 'unreadable') return true;
  return choice ?? accountValue;
}
