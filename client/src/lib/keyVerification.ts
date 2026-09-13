import type { AccountScope } from './serverScope';
import {
  CHANNEL_PIN_NAMESPACE,
  IdentityTrustLockedError,
  normalizeIdentity,
  readChannelPin,
  readIdentityPin,
  transactIdentityTrust,
  writeChannelPin,
  writeIdentityPin,
  type ChannelPinRecord,
  type IdentityPinRecord,
} from './crypto/identityTrust';

export { IdentityTrustLockedError, identityTrustUnlocked } from './crypto/identityTrust';

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

/**
 * Per-DM-channel binding of the peer's identity key.
 *
 * The user-scoped record above is the primary anchor, but the DM ratchet path
 * only ever receives a channel id plus a server-supplied peer key (the decrypt
 * entry point is handed a key, not a user id), so it needs an anchor it can
 * reach. Both are reconciled through `markIdentityVerified`, which is the
 * single user-driven recovery action.
 */
interface DmPeerIdentityPin {
  fingerprint: string;
  pinned_at: string;
  /** Peer user id, recorded whenever the calling path knows it. */
  user_id?: string;
  pending_fingerprint?: string;
  pending_seen_at?: string;
}

export function formatIdentityFingerprint(identityKeyHex: string): string {
  const normalized = normalizeIdentity(identityKeyHex ?? '');
  return normalized.match(/.{1,4}/g)?.join(' ') ?? normalized;
}

function toVerificationRecord(pin: IdentityPinRecord): IdentityVerificationRecord {
  return {
    fingerprint: formatIdentityFingerprint(pin.identity),
    first_seen_at: pin.firstSeenAt,
    last_seen_at: pin.lastSeenAt ?? pin.firstSeenAt,
    ...(pin.rotatedAt ? { rotated_at: pin.rotatedAt } : {}),
    ...(pin.previousIdentity ? { previous_fingerprint: formatIdentityFingerprint(pin.previousIdentity) } : {}),
    ...(pin.verifiedAt ? { verified_at: pin.verifiedAt } : {}),
    ...(pin.pendingIdentity ? { pending_fingerprint: formatIdentityFingerprint(pin.pendingIdentity) } : {}),
    ...(pin.pendingSeenAt ? { pending_seen_at: pin.pendingSeenAt } : {}),
  };
}

function toDmPin(channel: ChannelPinRecord): DmPeerIdentityPin {
  return {
    fingerprint: formatIdentityFingerprint(channel.identity),
    pinned_at: channel.pinnedAt ?? '',
    ...(channel.userId ? { user_id: channel.userId } : {}),
    ...(channel.pendingIdentity ? { pending_fingerprint: formatIdentityFingerprint(channel.pendingIdentity) } : {}),
    ...(channel.pendingSeenAt ? { pending_seen_at: channel.pendingSeenAt } : {}),
  };
}

/**
 * Record a sighting of `fingerprint` for `userId`.
 *
 * A first sighting pins the key (TOFU). A *different* key is recorded as a
 * pending rotation and reported to the caller, but the pin itself is left
 * untouched: only `markIdentityVerified` — an explicit user decision — may move
 * a pin. Anything weaker would let a hostile server retire the pinned key just
 * by serving its own.
 *
 * Throws {@link IdentityTrustLockedError} when this account's vault is locked:
 * the answer then is "unknown", not "unverified".
 */
export async function observeIdentityFingerprint(
  userId: string,
  fingerprint: string,
): Promise<{ rotated: boolean; previousFingerprint?: string; record: IdentityVerificationRecord }> {
  const identity = normalizeIdentity(fingerprint);
  return transactIdentityTrust(async transaction => {
    const now = new Date().toISOString();
    const existing = await readIdentityPin(transaction, userId);
    if (!existing) {
      const record: IdentityPinRecord = { identity, firstSeenAt: now, lastSeenAt: now };
      writeIdentityPin(transaction, userId, record);
      return { rotated: false, record: toVerificationRecord(record) };
    }
    if (existing.identity !== identity) {
      const record: IdentityPinRecord = {
        ...existing,
        previousIdentity: existing.identity,
        rotatedAt: now,
        lastSeenAt: now,
        pendingIdentity: identity,
        pendingSeenAt: now,
      };
      writeIdentityPin(transaction, userId, record);
      return {
        rotated: true,
        previousFingerprint: formatIdentityFingerprint(existing.identity),
        record: toVerificationRecord(record),
      };
    }
    const record: IdentityPinRecord = { ...existing, lastSeenAt: now };
    delete record.pendingIdentity;
    delete record.pendingSeenAt;
    writeIdentityPin(transaction, userId, record);
    return { rotated: false, record: toVerificationRecord(record) };
  });
}

export async function getIdentityVerification(userId: string): Promise<IdentityVerificationRecord | null> {
  const pin = await transactIdentityTrust(transaction => readIdentityPin(transaction, userId));
  return pin ? toVerificationRecord(pin) : null;
}

/**
 * Accept `fingerprint` as this user's identity key.
 *
 * This is the ONLY way a pin moves, and therefore the single recovery path out
 * of a fail-closed rotation: the user compares fingerprints out of band (QR /
 * safety numbers on the profile card), confirms, and both the user-scoped pin
 * and this peer's DM-channel pins are promoted together.
 */
export async function markIdentityVerified(userId: string, fingerprint: string): Promise<void> {
  const identity = normalizeIdentity(fingerprint);
  await transactIdentityTrust(async transaction => {
    const now = new Date().toISOString();
    const existing = await readIdentityPin(transaction, userId);
    const record: IdentityPinRecord = existing
      ? { ...existing, identity, verifiedAt: now, lastSeenAt: now,
          ...(existing.identity !== identity ? { previousIdentity: existing.identity } : {}) }
      : { identity, firstSeenAt: now, lastSeenAt: now, verifiedAt: now };
    delete record.pendingIdentity;
    delete record.pendingSeenAt;
    writeIdentityPin(transaction, userId, record);

    // Promote this peer's channel pins. A channel pin whose owner is unknown is
    // promoted only when it was waiting on exactly this key, so verifying one
    // peer can never silently re-anchor a conversation with somebody else.
    for (const { id: channelId, value } of await transaction.list<ChannelPinRecord>(CHANNEL_PIN_NAMESPACE)) {
      const ownedByPeer = value.userId === userId;
      if (!ownedByPeer && !(!value.userId && value.pendingIdentity === identity)) continue;
      if (value.identity === identity && !value.pendingIdentity) continue;
      const promoted: ChannelPinRecord = { userId, identity, pinnedAt: now };
      writeChannelPin(transaction, channelId, promoted);
    }
  });
}

/**
 * Verified / not verified / unknown.
 *
 * "Unknown" is the honest answer while the account vault is locked: the record
 * exists, this device simply cannot read it yet. Reporting "not verified" there
 * would invite a user to re-verify a key they already checked.
 */
export type IdentityTrustState = 'verified' | 'unverified' | 'unknown';

export async function getIdentityTrustState(
  userId: string,
  fingerprint: string,
): Promise<IdentityTrustState> {
  try {
    return (await isIdentityVerified(userId, fingerprint)) ? 'verified' : 'unverified';
  } catch (error) {
    if (error instanceof IdentityTrustLockedError) return 'unknown';
    throw error;
  }
}

export async function isIdentityVerified(userId: string, fingerprint: string): Promise<boolean> {
  const identity = normalizeIdentity(fingerprint);
  const pin = await transactIdentityTrust(transaction => readIdentityPin(transaction, userId));
  return Boolean(pin && pin.identity === identity && pin.verifiedAt);
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
// A locked vault refuses too — it cannot prove the key is the pinned one.

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
 * Batch form of {@link assertPinnedIdentityKey}: one vault transaction for the
 * whole set. Group DM fan-out wraps a sender key to every recipient, so the
 * per-recipient form would otherwise cost one transaction per member per
 * message.
 */
export async function assertPinnedIdentityKeys(
  entries: Array<{ userId: string; identityKeyHex: string }>,
  scope?: AccountScope | null,
): Promise<string[]> {
  if (entries.length === 0) return [];

  const identities = entries.map(entry => {
    const identity = normalizeIdentity(entry.identityKeyHex ?? '');
    if (!identity) {
      throw new IdentityPinError(
        'IDENTITY_KEY_MISSING',
        `No usable identity key for user ${entry.userId}`,
        { userId: entry.userId },
      );
    }
    return identity;
  });

  // A rotation must be remembered even though the assertion throws, so the
  // profile card can offer verification. A vault transaction discards its
  // staged writes when the body throws, so the pending key is committed in its
  // own transaction and the refusal is raised after it.
  const rotation = await transactIdentityTrust(async transaction => {
    const now = new Date().toISOString();
    for (let index = 0; index < entries.length; index++) {
      const { userId } = entries[index];
      const identity = identities[index];
      const existing = await readIdentityPin(transaction, userId);

      if (!existing) {
        writeIdentityPin(transaction, userId, { identity, firstSeenAt: now, lastSeenAt: now });
        continue;
      }

      if (existing.identity === identity) {
        // Deliberately does not touch `lastSeenAt`: this runs on every message
        // send, and a write per message would be a vault commit for pure
        // bookkeeping. `observeIdentityFingerprint` keeps that field fresh.
        if (existing.pendingIdentity) {
          const cleared = { ...existing };
          delete cleared.pendingIdentity;
          delete cleared.pendingSeenAt;
          writeIdentityPin(transaction, userId, cleared);
        }
        continue;
      }

      writeIdentityPin(transaction, userId, {
        ...existing,
        previousIdentity: existing.identity,
        rotatedAt: now,
        lastSeenAt: now,
        pendingIdentity: identity,
        pendingSeenAt: now,
      });
      return { userId, pinned: existing.identity, presented: identity };
    }
    return null;
  }, scope);

  if (rotation) {
    throw new IdentityPinError(
      'IDENTITY_KEY_ROTATED',
      rotationMessage(
        `User ${rotation.userId}'s`,
        formatIdentityFingerprint(rotation.pinned),
        formatIdentityFingerprint(rotation.presented),
      ),
      {
        userId: rotation.userId,
        pinnedFingerprint: formatIdentityFingerprint(rotation.pinned),
        presentedFingerprint: formatIdentityFingerprint(rotation.presented),
      },
    );
  }
  return identities.map(formatIdentityFingerprint);
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
  const identity = normalizeIdentity(identityKeyHex ?? '');
  if (!identity) {
    throw new IdentityPinError('IDENTITY_KEY_MISSING', 'No usable peer identity key for this DM', {
      channelId,
      userId: peerUserId ?? undefined,
    });
  }

  if (peerUserId) {
    await assertPinnedIdentityKey(peerUserId, identityKeyHex);
  }

  const rotation = await transactIdentityTrust(async transaction => {
    const now = new Date().toISOString();
    const existing = await readChannelPin(transaction, channelId);

    if (!existing) {
      writeChannelPin(transaction, channelId, {
        userId: peerUserId ?? '',
        identity,
        pinnedAt: now,
      });
      return null;
    }

    if (existing.identity === identity) {
      if (existing.pendingIdentity || (peerUserId && existing.userId !== peerUserId)) {
        const cleared: ChannelPinRecord = { ...existing, userId: peerUserId ?? existing.userId };
        delete cleared.pendingIdentity;
        delete cleared.pendingSeenAt;
        writeChannelPin(transaction, channelId, cleared);
      }
      return null;
    }

    // The channel pin disagrees. Accept only if the user explicitly verified
    // this exact key for the peer — the same action that promotes the pin.
    const ownerId = peerUserId || existing.userId;
    const owner = ownerId ? await readIdentityPin(transaction, ownerId) : null;
    if (owner && owner.identity === identity && owner.verifiedAt) {
      writeChannelPin(transaction, channelId, { userId: ownerId, identity, pinnedAt: now });
      return null;
    }

    writeChannelPin(transaction, channelId, {
      ...existing,
      userId: ownerId,
      pendingIdentity: identity,
      pendingSeenAt: now,
    });
    return { ownerId, pinned: existing.identity, presented: identity };
  });

  if (rotation) {
    throw new IdentityPinError(
      'IDENTITY_KEY_ROTATED',
      rotationMessage(
        "This conversation peer's",
        formatIdentityFingerprint(rotation.pinned),
        formatIdentityFingerprint(rotation.presented),
      ),
      {
        channelId,
        userId: rotation.ownerId || undefined,
        pinnedFingerprint: formatIdentityFingerprint(rotation.pinned),
        presentedFingerprint: formatIdentityFingerprint(rotation.presented),
      },
    );
  }
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
  const pin = await transactIdentityTrust(transaction => readChannelPin(transaction, channelId));
  return pin ? toDmPin(pin) : null;
}

/**
 * Accept a rotated identity key. Alias of {@link markIdentityVerified}, exposed
 * under the name the recovery flow reads better with.
 */
export async function acceptIdentityRotation(userId: string, fingerprint: string): Promise<void> {
  await markIdentityVerified(userId, fingerprint);
}
