/**
 * Logout reset registry.
 *
 * Every store that caches account-scoped data must be cleared on logout —
 * there is no page reload, so anything left behind is rendered to the *next*
 * account. The obvious implementation (authStore imports every store and calls
 * `reset()`) is wrong here for two reasons:
 *
 *  1. It creates an import cycle: `messageStore` already imports `authStore`.
 *  2. `authStore` sits in the eager startup chain (`api/client` imports it), so
 *     importing `voiceStore` and `messageStore` from it would drag
 *     `livekit-client` and the DM crypto modules into the login-screen bundle.
 *
 * Instead each store registers its own reset at module scope, and `authStore`
 * calls whatever has registered. A store that was never imported has no cached
 * state to clear, so "not registered" is exactly the right behaviour.
 */

type SessionReset = () => void | Promise<void>;

const registry = new Map<string, SessionReset>();

/** Register a store's logout reset. Later calls for the same name replace it. */
export function registerSessionReset(name: string, reset: SessionReset): void {
  registry.set(name, reset);
}

/**
 * Run every registered reset. Failures are logged and swallowed: one store
 * failing to tear down must never prevent the rest of the logout, or the user
 * is left half-signed-in with another account's data on screen.
 */
export async function resetSessionStores(): Promise<void> {
  await Promise.all(
    Array.from(registry.entries()).map(async ([name, reset]) => {
      try {
        await reset();
      } catch (err) {
        console.warn(`[session] reset for "${name}" failed:`, err);
      }
    }),
  );
}

/** Test seam: drop all registrations. */
export function clearSessionResetRegistry(): void {
  registry.clear();
}
