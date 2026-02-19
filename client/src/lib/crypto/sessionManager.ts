import { secureGet, secureSet, secureDelete } from '../secureStorage';
import { generateX25519KeyPair } from './x3dh';
import { toBase64, fromBase64 } from './util';
import type {
  RatchetState,
  SerializedRatchetState,
  LocalPrekeyStore,
  SerializedLocalPrekeyStore,
  X25519KeyPair,
} from './types';
import { OPK_BATCH_SIZE } from './types';

const SESSION_PREFIX = 'signal:session:';
const PREKEY_STORE_KEY = 'signal:prekeys';

// ── Ratchet State serialization ──────────────────────────────────

export function serializeState(state: RatchetState): SerializedRatchetState {
  const skipped: Record<string, string> = {};
  for (const [k, v] of state.MKSKIPPED) {
    skipped[k] = toBase64(v);
  }
  return {
    DHs_pub: toBase64(state.DHs.publicKey),
    DHs_priv: toBase64(state.DHs.privateKey),
    DHr: state.DHr ? toBase64(state.DHr) : null,
    RK: toBase64(state.RK),
    CKs: state.CKs ? toBase64(state.CKs) : null,
    CKr: state.CKr ? toBase64(state.CKr) : null,
    Ns: state.Ns,
    Nr: state.Nr,
    PN: state.PN,
    MKSKIPPED: skipped,
  };
}

export function deserializeState(s: SerializedRatchetState): RatchetState {
  const mkSkipped = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(s.MKSKIPPED)) {
    mkSkipped.set(k, fromBase64(v));
  }
  return {
    DHs: {
      publicKey: fromBase64(s.DHs_pub),
      privateKey: fromBase64(s.DHs_priv),
    },
    DHr: s.DHr ? fromBase64(s.DHr) : null,
    RK: fromBase64(s.RK),
    CKs: s.CKs ? fromBase64(s.CKs) : null,
    CKr: s.CKr ? fromBase64(s.CKr) : null,
    Ns: s.Ns,
    Nr: s.Nr,
    PN: s.PN,
    MKSKIPPED: mkSkipped,
  };
}

// ── Session persistence ──────────────────────────────────────────

function sessionKey(myPubHex: string, peerPubHex: string): string {
  // Deterministic ordering so both sides use the same key
  const sorted = [myPubHex, peerPubHex].sort();
  return `${SESSION_PREFIX}${sorted[0]}:${sorted[1]}`;
}

export async function loadSession(
  myPubHex: string,
  peerPubHex: string,
): Promise<RatchetState | null> {
  const raw = await secureGet(sessionKey(myPubHex, peerPubHex));
  if (!raw) return null;
  try {
    return deserializeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveSession(
  myPubHex: string,
  peerPubHex: string,
  state: RatchetState,
): Promise<void> {
  const serialized = serializeState(state);
  await secureSet(sessionKey(myPubHex, peerPubHex), JSON.stringify(serialized));
}

export async function deleteSession(
  myPubHex: string,
  peerPubHex: string,
): Promise<void> {
  await secureDelete(sessionKey(myPubHex, peerPubHex));
}

// ── Prekey Store ─────────────────────────────────────────────────

function serializePrekeyStore(store: LocalPrekeyStore): SerializedLocalPrekeyStore {
  return {
    signedPrekey: {
      id: store.signedPrekey.id,
      publicKey: toBase64(store.signedPrekey.publicKey),
      privateKey: toBase64(store.signedPrekey.privateKey),
      createdAt: store.signedPrekey.createdAt,
    },
    oneTimePrekeys: store.oneTimePrekeys.map((k) => ({
      id: k.id,
      publicKey: toBase64(k.publicKey),
      privateKey: toBase64(k.privateKey),
    })),
    nextOPKId: store.nextOPKId,
  };
}

function deserializePrekeyStore(s: SerializedLocalPrekeyStore): LocalPrekeyStore {
  return {
    signedPrekey: {
      id: s.signedPrekey.id,
      publicKey: fromBase64(s.signedPrekey.publicKey),
      privateKey: fromBase64(s.signedPrekey.privateKey),
      createdAt: s.signedPrekey.createdAt,
    },
    oneTimePrekeys: s.oneTimePrekeys.map((k) => ({
      id: k.id,
      publicKey: fromBase64(k.publicKey),
      privateKey: fromBase64(k.privateKey),
    })),
    nextOPKId: s.nextOPKId,
  };
}

export async function loadPrekeyStore(): Promise<LocalPrekeyStore | null> {
  const raw = await secureGet(PREKEY_STORE_KEY);
  if (!raw) return null;
  try {
    return deserializePrekeyStore(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function savePrekeyStore(store: LocalPrekeyStore): Promise<void> {
  await secureSet(PREKEY_STORE_KEY, JSON.stringify(serializePrekeyStore(store)));
}

/**
 * Generate a fresh prekey bundle for the local user.
 * Signs the X25519 signed prekey with the Ed25519 identity key.
 */
export function generatePrekeyBundle(_identityPrivateEd25519: Uint8Array): LocalPrekeyStore {
  // Generate signed prekey (X25519)
  const spk = generateX25519KeyPair();
  const spkId = Date.now();

  // Generate initial batch of one-time prekeys (X25519)
  const oneTimePrekeys: LocalPrekeyStore['oneTimePrekeys'] = [];
  for (let i = 0; i < OPK_BATCH_SIZE; i++) {
    const opk = generateX25519KeyPair();
    oneTimePrekeys.push({
      id: spkId + i + 1,
      publicKey: opk.publicKey,
      privateKey: opk.privateKey,
    });
  }

  return {
    signedPrekey: {
      id: spkId,
      publicKey: spk.publicKey,
      privateKey: spk.privateKey,
      createdAt: Date.now(),
    },
    oneTimePrekeys,
    nextOPKId: spkId + OPK_BATCH_SIZE + 1,
  };
}

/**
 * Generate additional one-time prekeys and return the updated store + public keys for upload.
 */
export function generateAdditionalOPKs(
  store: LocalPrekeyStore,
  count: number,
): { store: LocalPrekeyStore; newPublicKeys: Array<{ id: number; publicKey: Uint8Array }> } {
  const newKeys: LocalPrekeyStore['oneTimePrekeys'] = [];
  const newPublicKeys: Array<{ id: number; publicKey: Uint8Array }> = [];
  let nextId = store.nextOPKId;

  for (let i = 0; i < count; i++) {
    const opk = generateX25519KeyPair();
    newKeys.push({ id: nextId, publicKey: opk.publicKey, privateKey: opk.privateKey });
    newPublicKeys.push({ id: nextId, publicKey: opk.publicKey });
    nextId++;
  }

  return {
    store: {
      ...store,
      oneTimePrekeys: [...store.oneTimePrekeys, ...newKeys],
      nextOPKId: nextId,
    },
    newPublicKeys,
  };
}

/**
 * Consume a local one-time prekey by ID, returning its private key.
 */
export function consumeLocalOPK(
  store: LocalPrekeyStore,
  opkId: number,
): { privateKey: Uint8Array; updatedStore: LocalPrekeyStore } | null {
  const idx = store.oneTimePrekeys.findIndex((k) => k.id === opkId);
  if (idx === -1) return null;

  const key = store.oneTimePrekeys[idx];
  const remaining = [...store.oneTimePrekeys];
  remaining.splice(idx, 1);

  return {
    privateKey: key.privateKey,
    updatedStore: { ...store, oneTimePrekeys: remaining },
  };
}

/**
 * Get the signed prekey pair from the store as an X25519KeyPair.
 */
export function getSignedPrekeyPair(store: LocalPrekeyStore): X25519KeyPair {
  return {
    publicKey: store.signedPrekey.publicKey,
    privateKey: store.signedPrekey.privateKey,
  };
}
