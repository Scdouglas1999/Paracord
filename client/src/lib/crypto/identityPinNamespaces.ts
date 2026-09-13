/**
 * Where a peer's identity trust is stored in the account vault.
 *
 * These two names are shared by the ratchet's gate (`signalVault.ts`) and the
 * trust store the profile card writes through (`identityTrust.ts`) — one record,
 * not two — so they live in a module that imports nothing at all. Both of those
 * modules are reachable from the other's import graph, and a constant declared
 * in either of them is still in its temporal dead zone when the other's module
 * body runs.
 */
export const IDENTITY_PIN_NAMESPACE = 'signal.identity-pins';
export const CHANNEL_PIN_NAMESPACE = 'signal.channel-pins';
