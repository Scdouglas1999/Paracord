import { createKeysApi } from '../../api/keys';
import type { openAccountVault } from '../crypto/accountVaultSession';
import { DeliveredMutations, type DeliveredMessageTarget } from './deliveredMutations';
import { createDeliveredDeletionTransport } from './deliveredMutationTransport';
import { createDeliveryEditTransport, createEditResolutionTransport } from './durableEdit';
import { createDurableDm } from './durableDm';

/** All storage, peer-key reads and mutations belong to this verified vault session. */
export function createAccountDeliveredMutations(
  session: Awaited<ReturnType<typeof openAccountVault>>,
  events: { onChange?: () => void; onError(error: unknown): void; beforeAttempt?(target: DeliveredMessageTarget): Promise<void> },
) {
  session.assertCurrent();
  const dm = createDurableDm(session.vault, session.privateKey, createKeysApi(() => session.context.api));
  return new DeliveredMutations({
    vault: session.vault, lifetime: session, ...events,
    async prepareEdit(tx, target, editNonce, content) {
      if (target.encryption.kind === 'dm') {
        return dm.prepareDeliveredEdit(tx, target.channelId, target.encryption.peer, target.messageId, editNonce, content);
      }
      return { channelId: target.channelId, messageId: target.messageId, editNonce,
        serializedRequest: JSON.stringify({ content, edit_nonce: editNonce }) };
    },
    async prepareDelete(tx, target) {
      if (target.encryption.kind === 'dm') await dm.retireDeliveredMessage(tx, target.channelId, target.encryption.peer);
    },
    edit: createDeliveryEditTransport(session.context),
    resolveEdit: createEditResolutionTransport(session.context),
    deletion: createDeliveredDeletionTransport(session.context),
  });
}
