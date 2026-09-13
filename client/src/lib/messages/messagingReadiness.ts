import type { ActionDecision } from '../conversationActions';
import type { MessagingSnapshot } from './accountMessagingRuntime';

/** Server permission and encrypted device acceptance must both be ready. */
export function runtimeSendDecision(server: ActionDecision, state: MessagingSnapshot, encrypted: boolean, channelId: string, channelType?: number): ActionDecision {
  if (!server.allowed) return server;
  const block = (reason: string, supported = true) => ({ supported, allowed: false, reason });
  if (channelType === 3) return block('Group direct messages are waiting for account encryption migration. Your draft stays saved.', false);
  if (state.storage !== 'ready') return block(state.error ?? (state.storage === 'awaiting-handshake'
    ? 'Wait for this server’s authenticated connection before sending.' : 'Save this draft in encrypted device storage before sending.'));
  if (state.synchronization !== 'ready') return block('Wait for this account’s authenticated message recovery before sending.');
  if (state.channelErrors?.[channelId]) return block(state.channelErrors[channelId]);
  if (!encrypted) return server;
  if (state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId === channelId) return block(state.encryptionError ?? 'Review this conversation’s older encryption keys before sending.');
  if (state.encryption === 'ready') return server;
  return block(state.encryptionError ?? (state.encryption === 'setup' ? 'Set up encryption for this server account before sending.'
    : state.encryption === 'locked' ? 'Unlock this server account’s encryption identity before sending.' : 'Wait for this server account’s encryption to be verified before sending.'));
}

/**
 * Attaching a file needs everything sending needs — unlocked encrypted storage,
 * a verified identity and a ready peer — because the producer writes the staged
 * ciphertext into the same account vault the message is queued in.
 */
export function runtimeAttachDecision(server: ActionDecision, state: MessagingSnapshot, encrypted: boolean, channelId: string, channelType?: number): ActionDecision {
  return runtimeSendDecision(server, state, encrypted, channelId, channelType);
}
