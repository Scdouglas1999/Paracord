export interface X25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Double Ratchet state for a single session.
 * See the Signal specification for field semantics.
 */
export interface RatchetState {
  /** Our current sending DH keypair. */
  DHs: X25519KeyPair;
  /** Remote party's current DH public key (null until first message received). */
  DHr: Uint8Array | null;
  /** Root key (32 bytes). */
  RK: Uint8Array;
  /** Sending chain key (null before first DH ratchet). */
  CKs: Uint8Array | null;
  /** Receiving chain key (null before first message from peer). */
  CKr: Uint8Array | null;
  /** Sending message counter. */
  Ns: number;
  /** Receiving message counter. */
  Nr: number;
  /** Previous sending chain length. */
  PN: number;
  /** Skipped message keys: Map<"dhPubHex:counter", messageKey>. */
  MKSKIPPED: Map<string, Uint8Array>;
}

/** Serialized form of RatchetState for persistence (binary fields → base64). */
export interface SerializedRatchetState {
  DHs_pub: string;
  DHs_priv: string;
  DHr: string | null;
  RK: string;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Record<string, string>;
}

/** Signal protocol message header sent with each ciphertext. */
export interface MessageHeader {
  /** Sender's current DH ratchet public key (base64). */
  dh: string;
  /** Previous sending chain length. */
  pn: number;
  /** Message number in current sending chain. */
  n: number;
  /** Sender's identity key (base64) — only in first message (X3DH). */
  ik?: string;
  /** Ephemeral key used for X3DH (base64) — only in first message. */
  ek?: string;
  /** ID of consumed one-time prekey — only in first message. */
  opk_id?: number;
}

/** Prekey bundle fetched from the server for a peer. */
export interface PrekeyBundle {
  identityKey: Uint8Array;
  signedPrekey: {
    id: number;
    publicKey: Uint8Array;
    signature: Uint8Array;
  };
  oneTimePrekey?: {
    id: number;
    publicKey: Uint8Array;
  };
}

/** Local prekey store persisted in secure storage. */
export interface LocalPrekeyStore {
  signedPrekey: {
    id: number;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    createdAt: number;
  };
  oneTimePrekeys: Array<{
    id: number;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }>;
  nextOPKId: number;
}

/** Serialized form of LocalPrekeyStore for persistence. */
export interface SerializedLocalPrekeyStore {
  signedPrekey: {
    id: number;
    publicKey: string;
    privateKey: string;
    createdAt: number;
  };
  oneTimePrekeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
  nextOPKId: number;
}

// Protocol constants
export const MAX_SKIP = 256;
export const OPK_LOW_THRESHOLD = 20;
export const OPK_BATCH_SIZE = 50;
export const SIGNED_PREKEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
