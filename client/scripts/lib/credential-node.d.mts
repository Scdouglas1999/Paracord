// Types for credential-node.mjs, so typechecked e2e fixtures can import it.

export interface KdfParams { alg: 'scrypt'; log_n: number; r: number; p: number }
export interface Identity { secretKey: Buffer; publicKey: string; sign(message: string): string }
export interface Challenge { nonce: string; timestamp: number; server_origin: string }
export interface OnePasswordAccount {
  username: string;
  email: string;
  id: string;
  token: string;
  refreshToken: string | null;
  publicKey: string;
  phrase: string;
}

export const DEFAULT_KDF: Readonly<KdfParams>;
export function b64url(bytes: Uint8Array): string;
export function deriveKeys(password: string, salt: Uint8Array, kdf?: KdfParams): { authKey: string; wrapKey: Buffer };
export function identity(secretKey?: Buffer): Identity;
export function wrapIdentity(wrapKey: Buffer, id: Identity, iv?: Buffer): string;
export function newCredential(password: string, kdf?: KdfParams): {
  credential: { salt: string; kdf: KdfParams; auth_key: string };
  wrapKey: Buffer;
};
export function proof(id: Identity, purpose: string, challenge: Challenge): { nonce: string; timestamp: number; signature: string };
export function phraseOf(id: Identity): string;
export function registerOnePassword(
  base: string,
  account: { username: string; email: string; password: string; displayName?: string; inviteCode?: string },
): Promise<OnePasswordAccount>;
export function signInOnePassword(base: string, identifier: string, password: string): Promise<Record<string, unknown>>;
export function selfCheck(): void;
