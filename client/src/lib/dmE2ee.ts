import { createDmCipher } from './dmCipher';
import { loadSession, saveSession, loadPrekeyStore, savePrekeyStore } from './crypto/sessionManager';
import { assertPinnedDmPeerIdentity } from './keyVerification';
import { keysApi } from '../api/keys';
export { createDmCipher, DmE2eeError } from './dmCipher';
export type { DmCipherDependencies, DmE2eeErrorCode } from './dmCipher';

// Transitional entry points for callers not yet using the account vault.
// Resolve dependencies at invocation, avoiding initialization cycles with the gateway.
function existingCipher() {
  return createDmCipher({ loadSession, saveSession, loadPrekeyStore, savePrekeyStore, assertPinnedDmPeerIdentity, keysApi });
}
export async function encryptDmMessage(...args: Parameters<ReturnType<typeof createDmCipher>['encryptDmMessage']>) {
  return existingCipher().encryptDmMessage(...args);
}
export async function encryptDmMessageV2(...args: Parameters<ReturnType<typeof createDmCipher>['encryptDmMessageV2']>) {
  return existingCipher().encryptDmMessageV2(...args);
}
export async function decryptDmMessage(...args: Parameters<ReturnType<typeof createDmCipher>['decryptDmMessage']>) {
  return existingCipher().decryptDmMessage(...args);
}
