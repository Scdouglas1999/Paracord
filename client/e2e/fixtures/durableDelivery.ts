import { createDeliveryEditTransport, createEditResolutionTransport } from '../../src/lib/messages/durableEdit';
import { useAuthStore } from '../../src/stores/authStore';
import { useServerListStore } from '../../src/stores/serverListStore';
import { setAccessToken } from '../../src/lib/authToken';
import { captureScopedOperation } from '../../src/lib/operationContext';
import { LOCAL_SERVER_ID } from '../../src/lib/serverScope';
import { DurableDelivery, createDeliveryTransport, createDeliveryDiscardTransport, createDeliveryResolutionTransport, queuedMutationRevision } from '../../src/lib/messages/durableDelivery';
import { listQueuedSends } from '../../src/lib/messages/durableOutbox';
import { initializeDmFixture } from './durableDm';

export async function initializeDeliveryFixture(initialize: boolean, allowBundleFetch = initialize) {
  const dm = await initializeDmFixture(initialize, LOCAL_SERVER_ID, false, allowBundleFetch);
  useServerListStore.setState({ activeServerId: LOCAL_SERVER_ID, servers: [] });
  useAuthStore.setState({ token: 'fixture-token', user: { id: 'alice', username: 'Alice', public_key: dm.alicePeer.publicKey } as never });
  setAccessToken('fixture-token');
  const context = captureScopedOperation(dm.alice.scope);
  let now = 10_000;
  const errors: string[] = [];
  let beforePrepare = async () => {};
  const pausePreparation = () => {
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    beforePrepare = async () => { entered(); await gate; };
    return { waiting, release };
  };
  const driver = new DurableDelivery({ edit: {
    resolveSend: createDeliveryResolutionTransport(context), resolveEdit: createEditResolutionTransport(context),
    send: createDeliveryEditTransport(context), prepare: dm.aliceDm.prepareEdit, restore: dm.aliceDm.restoreIntent,
  }, vault: dm.alice, lifetime: context, send: createDeliveryTransport(context), discard: createDeliveryDiscardTransport(context), reconcileRemoved: dm.aliceDm.reconcileRemoved,
  acknowledgeSend: (tx, record, message) => dm.aliceDm.acknowledgeSend(tx, record.nonce, message),
  prepareIntent: async (tx, intent) => { await beforePrepare(); return dm.aliceDm.prepareIntent(tx, intent); }, now: () => now, random: () => 0.5, onError: error => { errors.push(String(error)); } });
  return { ...dm, mutationRevision: queuedMutationRevision, queuedList: listQueuedSends, pausePreparation, driver, errors, setNow: (value: number) => { now = value; }, logout: () => { useAuthStore.setState({ token: null, user: null }); }, close: () => { driver.stop(); context.dispose(); dm.alice.close(); dm.bob.close(); } };
}
