import { secureGet, secureSet } from './secureStorage';

interface IdentityVerificationRecord {
  fingerprint: string;
  first_seen_at: string;
  last_seen_at: string;
  rotated_at?: string;
  previous_fingerprint?: string;
  verified_at?: string;
}

type IdentityVerificationStore = Record<string, IdentityVerificationRecord>;

const SECURE_KEY = 'paracord:key-verification-store';
const LEGACY_STORAGE_KEY = 'paracord:identity-verification:v1';

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

export function formatIdentityFingerprint(identityKeyHex: string): string {
  const normalized = identityKeyHex.toLowerCase().replace(/[^a-f0-9]/g, '');
  return normalized.match(/.{1,4}/g)?.join(' ') ?? normalized;
}

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
      fingerprint,
      rotated_at: now,
      last_seen_at: now,
      verified_at: undefined,
    };
    store[userId] = record;
    await writeStore(store);
    return { rotated: true, previousFingerprint: existing.fingerprint, record };
  }

  const record: IdentityVerificationRecord = {
    ...existing,
    last_seen_at: now,
  };
  store[userId] = record;
  await writeStore(store);
  return { rotated: false, record };
}

export async function getIdentityVerification(userId: string): Promise<IdentityVerificationRecord | null> {
  const store = await readStore();
  return store[userId] ?? null;
}

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
      fingerprint,
      verified_at: now,
      last_seen_at: now,
    };
  }
  await writeStore(store);
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
