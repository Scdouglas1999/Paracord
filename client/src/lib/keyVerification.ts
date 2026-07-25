import { secureGet, secureSet } from './secureStorage';

interface IdentityVerificationRecord {
  /**
   * The *pinned* fingerprint — the trust anchor. It is only ever replaced by an
   * explicit user decision (`markIdentityVerified`), never by observing a new
   * key from the server.
   */
  fingerprint: string;
  first_seen_at: string;
  last_seen_at: string;
  rotated_at?: string;
  previous_fingerprint?: string;
  verified_at?: string;
  /**
   * A different fingerprint the server has presented for this user that has NOT
   * been accepted. Kept separate from `fingerprint` so a hostile server cannot
   * roll the pin forward simply by serving its own key twice.
   */
  pending_fingerprint?: string;
  pending_seen_at?: string;
}

type IdentityVerificationStore = Record<string, IdentityVerificationRecord>;

/**
 * Per-DM-channel binding of the peer's identity key.
 *
 * The user-scoped store above is the primary anchor, but the DM ratchet path
 * only ever receives a channel id plus a server-supplied peer key (the decrypt
 * entry point is handed a key, not a user id), so it needs an anchor it can
 * reach. Both stores are reconciled through `markIdentityVerified`, which is
 * the single user-driven recovery action.
 */
interface DmPeerIdentityPin {
  fingerprint: string;
  pinned_at: string;
  /** Peer user id, recorded whenever the calling path knows it. */
  user_id?: string;
  pending_fingerprint?: string;
  pending_seen_at?: string;
}

type DmPeerIdentityPinStore = Record<string, DmPeerIdentityPin>;

const SECURE_KEY = 'paracord:key-verification-store';
const LEGACY_STORAGE_KEY = 'paracord:identity-verification:v1';
const DM_PIN_SECURE_KEY = 'paracord:dm-peer-identity-pins';

async function readStore(): Promise<IdentityVerificationStore> {
  try {
    const raw = await secureGet(SECURE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as IdentityVerificationStore;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // fall through to migration
  }
  // Migrate from legacy localStorage
  if (typeof localStorage !== 'undefined') {
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const parsed = JSON.parse(legacy) as IdentityVerificationStore;
        if (parsed && typeof parsed === 'object') {
          await secureSet(SECURE_KEY, legacy);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          return parsed;
        }
      }
    } catch {
      // ignore migration failures
    }
  }
  return {};
}

async function writeStore(store: IdentityVerificationStore): Promise<void> {
  try {
    await secureSet(SECURE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage failures
  }
}

async function readDmPinStore(): Promise<DmPeerIdentityPinStore> {
  try {
    const raw = await secureGet(DM_PIN_SECURE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DmPeerIdentityPinStore;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // fall through to an empty store
  }
  return {};
}

async function writeDmPinStore(store: DmPeerIdentityPinStore): Promise<void> {
  try {
    await secureSet(DM_PIN_SECURE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage failures
  }
}

export function formatIdentityFingerprint(identityKeyHex: string): string {
  const normalized = identityKeyHex.toLowerCase().replace(/[^a-f0-9]/g, '');
  return normalized.match(/.{1,4}/g)?.join(' ') ?? normalized;
}

/**
 * Record a sighting of `fingerprint` for `userId`.
 *
 * A first sighting pins the key (TOFU). A *different* key is recorded as a
 * pending rotation and reported to the caller, but the pin itself is left
 * untouched: only `markIdentityVerified` — an explicit user decision — may move
 * a pin. Anything weaker would let a hostile server retire the pinned key just
 * by serving its own.
 */
export async function observeIdentityFingerprint(
  userId: string,
  fingerprint: string,
): Promise<{ rotated: boolean; previousFingerprint?: string; record: IdentityVerificationRecord }> {
  const store = await readStore();
  const now = new Date().toISOString();
  const existing = store[userId];
  if (!existing) {
    const record: IdentityVerificationRecord = {
      fingerprint,
      first_seen_at: now,
      last_seen_at: now,
    };
    store[userId] = record;
    await writeStore(store);
    return { rotated: false, record };
  }

  if (existing.fingerprint !== fingerprint) {
    const record: IdentityVerificationRecord = {
      ...existing,
      previous_fingerprint: existing.fingerprint,
      rotated_at: now,
      last_seen_at: now,
      pending_fingerprint: fingerprint,
      pending_seen_at: now,
    };
    store[userId] = record;
    await writeStore(store);
    return { rotated: true, previousFingerprint: existing.fingerprint, record };
  }

  const record: IdentityVerificationRecord = {
    ...existing,
    last_seen_at: now,
    pending_fingerprint: undefined,
    pending_seen_at: undefined,
  };
  store[userId] = record;
  await writeStore(store);
  return { rotated: false, record };
}

export async function getIdentityVerification(userId: string): Promise<IdentityVerificationRecord | null> {
  const store = await readStore();
  return store[userId] ?? null;
}

/**
 * Accept `fingerprint` as this user's identity key.
 *
 * This is the ONLY way a pin moves, and therefore the single recovery path out
 * of a fail-closed rotation: the user compares fingerprints out of band (QR /
 * safety numbers on the profile card), confirms, and both the user-scoped pin
 * and any DM-channel pin waiting on that same key are promoted together.
 */
export async function markIdentityVerified(userId: string, fingerprint: string): Promise<void> {
  const store = await readStore();
  const now = new Date().toISOString();
  const existing = store[userId];
  if (!existing) {
    store[userId] = {
      fingerprint,
      first_seen_at: now,
      last_seen_at: now,
      verified_at: now,
    };
  } else {
    store[userId] = {
      ...existing,
      previous_fingerprint:
        existing.fingerprint !== fingerprint ? existing.fingerprint : existing.previous_fingerprint,
      fingerprint,
      verified_at: now,
      last_seen_at: now,
      pending_fingerprint: undefined,
      pending_seen_at: undefined,
    };
  }
  await writeStore(store);
  await promoteDmPinsForFingerprint(userId, fingerprint);
}

/** Promote every DM-channel pin that was blocked waiting on exactly this key. */
async function promoteDmPinsForFingerprint(userId: string, fingerprint: string): Promise<void> {
  const pins = await readDmPinStore();
  let changed = false;
  const now = new Date().toISOString();
  for (const [channelId, pin] of Object.entries(pins)) {
    if (pin.pending_fingerprint !== fingerprint) continue;
    // Only promote pins that belong to this user, or that were established
    // before the peer's user id was known.
    if (pin.user_id && pin.user_id !== userId) continue;
    pins[channelId] = {
      ...pin,
      fingerprint,
      user_id: pin.user_id ?? userId,
      pinned_at: now,
      pending_fingerprint: undefined,
      pending_seen_at: undefined,
    };
    changed = true;
  }
  if (changed) {
    await writeDmPinStore(pins);
  }
}

export async function isIdentityVerified(userId: string, fingerprint: string): Promise<boolean> {
  const record = await getIdentityVerification(userId);
  return Boolean(record && record.fingerprint === fingerprint && record.verified_at);
}

export function buildIdentityVerificationPayload(
  userId: string,
  username: string,
  fingerprint: string,
): string {
  return JSON.stringify({
    v: 1,
    user_id: userId,
    username,
    fingerprint,
    issued_at: new Date().toISOString(),
  });
}

export function parseIdentityVerificationPayload(
  raw: string,
): { userId: string; username: string; fingerprint: string } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const userId = typeof parsed.user_id === 'string' ? parsed.user_id : null;
    const username = typeof parsed.username === 'string' ? parsed.username : null;
    const fingerprint = typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null;
    if (!userId || !username || !fingerprint) return null;
    return { userId, username, fingerprint };
  } catch {
    return null;
  }
}

// ── Pin enforcement (fail closed) ────────────────────────────────
//
// Everything above is bookkeeping the UI can render. The functions below are
// the gate: every path that turns a *server-supplied* identity key into key
// material must call one of them first. On first sight the key is pinned; if it
// ever changes, encryption/decryption is refused until the user re-verifies.

export type IdentityPinErrorCode = 'IDENTITY_KEY_ROTATED' | 'IDENTITY_KEY_MISSING';

export class IdentityPinError extends Error {
  public readonly code: IdentityPinErrorCode;
  public readonly userId?: string;
  public readonly channelId?: string;
  /** The key we trust (empty when the presented key was unusable). */
  public readonly pinnedFingerprint: string;
  /** The key the server just presented. */
  public readonly presentedFingerprint: string;

  constructor(
    code: IdentityPinErrorCode,
    message: string,
    details: {
      userId?: string;
      channelId?: string;
      pinnedFingerprint?: string;
      presentedFingerprint?: string;
    } = {},
  ) {
    super(message);
    this.name = 'IdentityPinError';
    this.code = code;
    this.userId = details.userId;
    this.channelId = details.channelId;
    this.pinnedFingerprint = details.pinnedFingerprint ?? '';
    this.presentedFingerprint = details.presentedFingerprint ?? '';
  }
}

function rotationMessage(subject: string, pinned: string, presented: string): string {
  return (
    `${subject} identity key changed and has not been verified. ` +
    `Pinned fingerprint: ${pinned}; new fingerprint: ${presented}. ` +
    'Verify the new fingerprint from the profile card to continue.'
  );
}

/**
 * Assert that `identityKeyHex` is the key pinned for `userId`, pinning it on
 * first sight. Throws {@link IdentityPinError} when the key rotated and the
 * user has not accepted the new one.
 */
export async function assertPinnedIdentityKey(
  userId: string,
  identityKeyHex: string,
): Promise<string> {
  const [fingerprint] = await assertPinnedIdentityKeys([{ userId, identityKeyHex }]);
  return fingerprint;
}

/**
 * Batch form of {@link assertPinnedIdentityKey}: reads and writes the store
 * once for the whole set. Group DM fan-out wraps a sender key to every
 * recipient, so the per-recipient form would otherwise cost one secure-storage
 * round trip per member per message.
 */
export async function assertPinnedIdentityKeys(
  entries: Array<{ userId: string; identityKeyHex: string }>,
): Promise<string[]> {
  if (entries.length === 0) return [];

  const fingerprints = entries.map((entry) => {
    const fingerprint = formatIdentityFingerprint(entry.identityKeyHex ?? '');
    if (!fingerprint) {
      throw new IdentityPinError(
        'IDENTITY_KEY_MISSING',
        `No usable identity key for user ${entry.userId}`,
        { userId: entry.userId },
      );
    }
    return fingerprint;
  });

  const store = await readStore();
  const now = new Date().toISOString();
  let changed = false;

  for (let i = 0; i < entries.length; i++) {
    const { userId } = entries[i];
    const fingerprint = fingerprints[i];
    const existing = store[userId];

    if (!existing) {
      store[userId] = { fingerprint, first_seen_at: now, last_seen_at: now };
      changed = true;
      continue;
    }

    if (existing.fingerprint === fingerprint) {
      // Deliberately does not touch `last_seen_at`: this runs on every message
      // send, and a write per message would be a secure-storage round trip for
      // pure bookkeeping. The profile card's `observeIdentityFingerprint` keeps
      // that field fresh.
      if (existing.pending_fingerprint) {
        store[userId] = {
          ...existing,
          pending_fingerprint: undefined,
          pending_seen_at: undefined,
        };
        changed = true;
      }
      continue;
    }

    // Rotation: remember what was presented so the UI can offer verification,
    // but keep the pin and refuse to use the new key.
    store[userId] = {
      ...existing,
      previous_fingerprint: existing.fingerprint,
      rotated_at: now,
      last_seen_at: now,
      pending_fingerprint: fingerprint,
      pending_seen_at: now,
    };
    await writeStore(store);
    throw new IdentityPinError(
      'IDENTITY_KEY_ROTATED',
      rotationMessage(`User ${userId}'s`, existing.fingerprint, fingerprint),
      {
        userId,
        pinnedFingerprint: existing.fingerprint,
        presentedFingerprint: fingerprint,
      },
    );
  }

  if (changed) {
    await writeStore(store);
  }
  return fingerprints;
}

/**
 * Assert the identity key used for a 1:1 DM channel.
 *
 * The ratchet path always knows the channel; it only sometimes knows the peer's
 * user id. When the id is available the user-scoped pin is authoritative; the
 * channel-scoped pin covers the rest, so a hostile server can never swap the
 * peer key of a conversation that is already under way.
 */
export async function assertPinnedDmPeerIdentity(
  channelId: string,
  identityKeyHex: string,
  peerUserId?: string | null,
): Promise<void> {
  const fingerprint = formatIdentityFingerprint(identityKeyHex ?? '');
  if (!fingerprint) {
    throw new IdentityPinError('IDENTITY_KEY_MISSING', 'No usable peer identity key for this DM', {
      channelId,
      userId: peerUserId ?? undefined,
    });
  }

  if (peerUserId) {
    await assertPinnedIdentityKey(peerUserId, identityKeyHex);
  }

  const pins = await readDmPinStore();
  const now = new Date().toISOString();
  const existing = pins[channelId];

  if (!existing) {
    pins[channelId] = {
      fingerprint,
      pinned_at: now,
      user_id: peerUserId ?? undefined,
    };
    await writeDmPinStore(pins);
    return;
  }

  if (existing.fingerprint === fingerprint) {
    if (existing.pending_fingerprint || (peerUserId && existing.user_id !== peerUserId)) {
      pins[channelId] = {
        ...existing,
        user_id: peerUserId ?? existing.user_id,
        pending_fingerprint: undefined,
        pending_seen_at: undefined,
      };
      await writeDmPinStore(pins);
    }
    return;
  }

  // The channel pin disagrees. Accept only if the user explicitly verified this
  // exact key for the peer (the same action that promotes the pin below).
  const ownerId = peerUserId ?? existing.user_id;
  if (ownerId && (await isIdentityVerified(ownerId, fingerprint))) {
    pins[channelId] = {
      fingerprint,
      pinned_at: now,
      user_id: ownerId,
    };
    await writeDmPinStore(pins);
    return;
  }

  pins[channelId] = {
    ...existing,
    user_id: ownerId,
    pending_fingerprint: fingerprint,
    pending_seen_at: now,
  };
  await writeDmPinStore(pins);
  throw new IdentityPinError(
    'IDENTITY_KEY_ROTATED',
    rotationMessage("This conversation peer's", existing.fingerprint, fingerprint),
    {
      channelId,
      userId: ownerId,
      pinnedFingerprint: existing.fingerprint,
      presentedFingerprint: fingerprint,
    },
  );
}

/** Pending (unaccepted) identity rotation for a user, for the verification UI. */
export async function getPendingIdentityRotation(
  userId: string,
): Promise<{ pinnedFingerprint: string; pendingFingerprint: string } | null> {
  const record = await getIdentityVerification(userId);
  if (!record?.pending_fingerprint) return null;
  return {
    pinnedFingerprint: record.fingerprint,
    pendingFingerprint: record.pending_fingerprint,
  };
}

/** Identity pin recorded for a DM channel, for the verification UI. */
export async function getDmPeerIdentityPin(channelId: string): Promise<DmPeerIdentityPin | null> {
  const pins = await readDmPinStore();
  return pins[channelId] ?? null;
}

/**
 * Accept a rotated identity key. Alias of {@link markIdentityVerified}, exposed
 * under the name the recovery flow reads better with.
 */
export async function acceptIdentityRotation(userId: string, fingerprint: string): Promise<void> {
  await markIdentityVerified(userId, fingerprint);
}
