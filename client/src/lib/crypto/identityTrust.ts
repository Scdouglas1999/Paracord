import { useServerListStore } from '../../stores/serverListStore';
import { secureGet } from '../secureStorage';
import { getServerAccountScope } from '../serverIdentity';
import { accountScopeKey, LOCAL_SERVER_ID, type AccountScope } from '../serverScope';
import type { AccountVault, VaultTransaction } from './accountVault';
import { CHANNEL_PIN_NAMESPACE, IDENTITY_PIN_NAMESPACE } from './identityPinNamespaces';

/**
 * Where a peer's identity trust lives.
 *
 * These two namespaces are the records the DM ratchet already enforces on
 * (`signalVault.ts`): a send or receive refuses outright when the key the
 * server presents is not the one pinned here. The verification decision a user
 * makes on a profile card is a property of that same record — not a second,
 * parallel bookkeeping copy — so marking someone verified moves the pin the
 * ratchet checks, and a pin the ratchet refuses has a UI that can resolve it.
 *
 * They live in the account vault, which is unlocked by the account passphrase
 * and encrypted under a key derived from the identity private key. In the
 * browser build that is the only durable store the app has that is not
 * plaintext: the generic web secure store deliberately keeps nothing past the
 * page, which is why a "Verified" mark used to evaporate on reload.
 *
 * A locked vault therefore means *unknown*, never *not verified*.
 */
export { IDENTITY_PIN_NAMESPACE, CHANNEL_PIN_NAMESPACE } from './identityPinNamespaces';

/** The pinned key for one peer account. `identity` is the key we trust. */
export interface IdentityPinRecord {
  /** 64 lowercase hex characters — the pinned ed25519 identity key. */
  identity: string;
  firstSeenAt: string;
  lastSeenAt?: string;
  /** Set only by an explicit user decision on the profile card. */
  verifiedAt?: string;
  previousIdentity?: string;
  rotatedAt?: string;
  /**
   * A different key the server has presented that has NOT been accepted. Kept
   * apart from `identity` so a hostile server cannot roll the pin forward by
   * serving its own key twice.
   */
  pendingIdentity?: string;
  pendingSeenAt?: string;
}

/** The peer key pinned for one DM channel, for paths that only know a channel. */
export interface ChannelPinRecord {
  userId: string;
  identity: string;
  pinnedAt?: string;
  pendingIdentity?: string;
  pendingSeenAt?: string;
}

export class IdentityTrustLockedError extends Error {
  constructor(message = 'Unlock this account’s encryption identity to read or change verification.') {
    super(message);
    this.name = 'IdentityTrustLockedError';
  }
}

/** Strip presentation so a formatted fingerprint and a raw key compare equal. */
export function normalizeIdentity(value: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

interface TrustHost { vault: AccountVault; ready: Promise<void>; }
const vaults = new Map<string, TrustHost>();

/**
 * Trust marks made by builds that kept this store in OS secure storage. On the
 * desktop those persisted; in the browser they never did, which is the defect
 * this vault backing fixes. Imported once per open vault, and only where the
 * vault has nothing of its own for that peer, so a fresher decision is never
 * overwritten by an older one. The original source is left intact.
 */
const LEGACY_USER_STORE_KEY = 'paracord:key-verification-store';
const LEGACY_CHANNEL_STORE_KEY = 'paracord:dm-peer-identity-pins';

async function readLegacy<T>(key: string): Promise<Record<string, T>> {
  try {
    const raw = await secureGet(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function importLegacyTrust(vault: AccountVault): Promise<void> {
  const [users, channels] = await Promise.all([
    readLegacy<{ fingerprint?: string; first_seen_at?: string; last_seen_at?: string; verified_at?: string; previous_fingerprint?: string; rotated_at?: string }>(LEGACY_USER_STORE_KEY),
    readLegacy<{ fingerprint?: string; user_id?: string; pinned_at?: string }>(LEGACY_CHANNEL_STORE_KEY),
  ]);
  if (!Object.keys(users).length && !Object.keys(channels).length) return;
  await vault.transact(async transaction => {
    for (const [userId, legacy] of Object.entries(users)) {
      const identity = normalizeIdentity(legacy?.fingerprint ?? '');
      if (identity.length !== 64) continue;
      if (await readIdentityPin(transaction, userId)) continue;
      const previous = normalizeIdentity(legacy.previous_fingerprint ?? '');
      writeIdentityPin(transaction, userId, {
        identity,
        firstSeenAt: legacy.first_seen_at ?? new Date().toISOString(),
        ...(legacy.last_seen_at ? { lastSeenAt: legacy.last_seen_at } : {}),
        ...(legacy.verified_at ? { verifiedAt: legacy.verified_at } : {}),
        ...(previous.length === 64 ? { previousIdentity: previous } : {}),
        ...(legacy.rotated_at ? { rotatedAt: legacy.rotated_at } : {}),
      });
    }
    for (const [channelId, legacy] of Object.entries(channels)) {
      const identity = normalizeIdentity(legacy?.fingerprint ?? '');
      if (identity.length !== 64 || !legacy.user_id) continue;
      if (await readChannelPin(transaction, channelId)) continue;
      writeChannelPin(transaction, channelId, {
        userId: legacy.user_id,
        identity,
        ...(legacy.pinned_at ? { pinnedAt: legacy.pinned_at } : {}),
      });
    }
  });
}

/**
 * Publish an account's open vault as the trust store for that account. The
 * messaging runtime calls this when its identity session opens, and releases
 * the exact same vault when the session closes, so a stale vault from a
 * replaced session can never keep answering.
 */
export function registerIdentityTrustVault(scope: AccountScope, vault: AccountVault): void {
  vaults.set(accountScopeKey(scope), { vault, ready: importLegacyTrust(vault).catch(() => {}) });
}

export function releaseIdentityTrustVault(scope: AccountScope, vault: AccountVault): void {
  const key = accountScopeKey(scope);
  if (vaults.get(key)?.vault === vault) vaults.delete(key);
}

export function resetIdentityTrustVaults(): void {
  vaults.clear();
}

function activeScope(): AccountScope | null {
  return getServerAccountScope(useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID);
}

function resolveVault(scope?: AccountScope | null): TrustHost | null {
  const target = scope ?? activeScope();
  return target ? vaults.get(accountScopeKey(target)) ?? null : null;
}

/** Whether trust can be read at all right now, i.e. whether the vault is open. */
export function identityTrustUnlocked(scope?: AccountScope | null): boolean {
  return resolveVault(scope) !== null;
}

/**
 * Run `operation` inside one atomic vault transaction. Throws
 * {@link IdentityTrustLockedError} when no vault is open: callers must report
 * "unknown", never fall back to an unverified answer or to a store that does
 * not survive the page.
 */
export async function transactIdentityTrust<T>(
  operation: (transaction: VaultTransaction) => Promise<T>,
  scope?: AccountScope | null,
): Promise<T> {
  const host = resolveVault(scope);
  if (!host) throw new IdentityTrustLockedError();
  await host.ready;
  return host.vault.transact(operation);
}

export async function readIdentityPin(
  transaction: VaultTransaction,
  userId: string,
): Promise<IdentityPinRecord | null> {
  return transaction.get<IdentityPinRecord>(IDENTITY_PIN_NAMESPACE, userId);
}

export function writeIdentityPin(
  transaction: VaultTransaction,
  userId: string,
  record: IdentityPinRecord,
): void {
  transaction.put(IDENTITY_PIN_NAMESPACE, userId, record);
}

export async function readChannelPin(
  transaction: VaultTransaction,
  channelId: string,
): Promise<ChannelPinRecord | null> {
  return transaction.get<ChannelPinRecord>(CHANNEL_PIN_NAMESPACE, channelId);
}

export function writeChannelPin(
  transaction: VaultTransaction,
  channelId: string,
  record: ChannelPinRecord,
): void {
  transaction.put(CHANNEL_PIN_NAMESPACE, channelId, record);
}
