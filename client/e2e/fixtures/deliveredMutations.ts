import { captureScopedOperation } from '../../src/lib/operationContext';
import { DeliveredMutations } from '../../src/lib/messages/deliveredMutations';
import { createDeliveryEditTransport, createEditResolutionTransport } from '../../src/lib/messages/durableEdit';
import { createDeliveredDeletionTransport } from '../../src/lib/messages/deliveredMutationTransport';
import { initializeDeliveryFixture } from './durableDelivery';

export async function initializeMutationFixture(initialize: boolean) {
  const base = await initializeDeliveryFixture(initialize, true);
  const context = captureScopedOperation(base.alice.scope);
  let now = 10_000;
  const target = { channelId: 'dm', messageId: '100', authorId: 'alice', encryption: { kind: 'dm' as const, peer: base.bobPeer } };
  const service = new DeliveredMutations({ vault: base.alice, lifetime: context,
    prepareEdit: (tx, owned, editNonce, content) => base.aliceDm.prepareDeliveredEdit(tx, owned.channelId, base.bobPeer, owned.messageId, editNonce, content),
    prepareDelete: (tx, owned) => base.aliceDm.retireDeliveredMessage(tx, owned.channelId, base.bobPeer),
    edit: createDeliveryEditTransport(context), resolveEdit: createEditResolutionTransport(context),
    deletion: createDeliveredDeletionTransport(context), now: () => now, random: () => 0.5,
    onError: error => { base.errors.push(String(error)); },
  });
  return { ...base, target, service, setMutationNow: (value: number) => { now = value; },
    closeAll: () => { service.stop(); context.dispose(); base.close(); } };
}
