import { signAsync } from '@noble/ed25519';
import type { IdentityProof } from '@/api/generated/CredentialRegister';
import { CredentialError } from './errors';
import { toHex, utf8 } from './encoding';

/**
 * Proof of possession of the identity key (spec §3.3 step 4, §3.8, §3.9,
 * §3.11): an Ed25519 signature over
 *
 *   "<purpose>:" + nonce + ":" + timestamp + ":" + origin
 *
 * where nonce, timestamp and origin come from `POST /auth/challenge`. The
 * purpose prefix keeps these signatures from ever being valid as a plain
 * `/auth/verify` sign-in (whose message is the same without a purpose).
 */

export const PROOF_PURPOSE = {
  /** Sign-up, claim, v1 upgrade, "Start over" email reset. */
  register: 'paracord/credential/v2/register',
  /** New password after signing in with the recovery phrase. */
  reset: 'paracord/credential/v2/reset',
} as const;
export type ProofPurpose = (typeof PROOF_PURPOSE)[keyof typeof PROOF_PURPOSE];

/** The `/auth/challenge` response. */
export interface AuthChallenge {
  nonce: string;
  timestamp: number;
  server_origin: string;
}

export function credentialProofMessage(purpose: ProofPurpose, nonce: string, timestamp: number, origin: string): string {
  if (purpose !== PROOF_PURPOSE.register && purpose !== PROOF_PURPOSE.reset) {
    throw new CredentialError('invalid', 'Unknown proof purpose.');
  }
  if (!Number.isSafeInteger(timestamp)) throw new CredentialError('invalid', 'The challenge timestamp is not an integer.');
  return `${purpose}:${nonce}:${timestamp}:${origin}`;
}

/**
 * Sign a challenge for `purpose`. `expectedOrigin` is the home server the
 * client is talking to; a challenge naming any other origin is refused (the
 * same check `/auth/verify` sign-in makes in `attachAccountIdentity.ts`).
 */
export async function signCredentialProof(
  privateKey: Uint8Array,
  purpose: ProofPurpose,
  challenge: AuthChallenge,
  expectedOrigin: string,
): Promise<IdentityProof> {
  if (!challenge || typeof challenge.nonce !== 'string' || typeof challenge.server_origin !== 'string') {
    throw new CredentialError('invalid', 'The server sent a malformed challenge.');
  }
  let challengeOrigin: string;
  try {
    challengeOrigin = new URL(challenge.server_origin).origin;
  } catch {
    throw new CredentialError('invalid', 'The server sent a malformed challenge.');
  }
  if (challengeOrigin !== new URL(expectedOrigin).origin) {
    throw new CredentialError('origin_mismatch', 'The server signed this request for a different address. Paracord won\'t send it.');
  }
  const message = credentialProofMessage(purpose, challenge.nonce, challenge.timestamp, challenge.server_origin);
  const signature = await signAsync(utf8(message), privateKey);
  return { nonce: challenge.nonce, timestamp: challenge.timestamp, signature: toHex(signature) };
}
