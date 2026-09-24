import { createKeysApi } from '../../api/keys';
import type { openAccountVault } from '../crypto/accountVaultSession';
import { DeliveredMutations, type DeliveredMessageTarget } from './deliveredMutations';
import { createDeliveredDeletionTransport } from './deliveredMutationTransport';
import { createDeliveryEditTransport, createEditResolutionTransport } from './durableEdit';
import { createDurableDm } from './durableDm';
import { createDurableGroup } from './durableGroup';
import { createChannelApi } from '../../api/channels';

/** All storage, peer-key reads and mutations belong to this verified vault session. */
export function createAccountDeliveredMutations(
  session: Awaited<ReturnType<typeof openAccountVault>>,
  events: { onChange?: () => void; onError(error: unknown): void; beforeAttempt?(target: DeliveredMessageTarget): Promise<void> },
) {
  session.assertCurrent();
  const dm = createDurableDm(session.vault, session.privateKey, createKeysApi(() => session.context.api));
  const group = createDurableGroup(session.vault, session.privateKey, createChannelApi(() => session.context.api));
  return new DeliveredMutations({
    vault: session.vault, lifetime: session, ...events,
    async prepareEdit(tx, target, editNonce, content) {
      if (target.encryption.kind === 'dm') {
        return dm.prepareDeliveredEdit(tx, target.channelId, target.encryption.peer, target.messageId, editNonce, content, [], target.forward);
      }
      if (target.encryption.kind === 'group') {
        return group.prepareDeliveredEdit(tx, target.channelId, target.encryption.members, target.messageId, editNonce, content, [], target.forward);
      }
      return { channelId: target.channelId, messageId: target.messageId, editNonce,
        serializedRequest: JSON.stringify({ content, edit_nonce: editNonce }) };
    },
    async prepareDelete(tx, target) {
      // A group epoch is not a chain, so deleting a delivered group message
      // strands no keys and needs no retirement — only the 1:1 ratchet does.
      if (target.encryption.kind === 'dm') await dm.retireDeliveredMessage(tx, target.channelId, target.encryption.peer);
    },
    edit: createDeliveryEditTransport(session.context),
    resolveEdit: createEditResolutionTransport(session.context),
    deletion: createDeliveredDeletionTransport(session.context),
  });
}
