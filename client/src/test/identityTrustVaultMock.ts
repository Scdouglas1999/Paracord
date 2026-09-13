import type { User } from '../types';
import type { AccountVault, VaultTransaction } from '../lib/crypto/accountVault';
import {
  registerIdentityTrustVault,
  releaseIdentityTrustVault,
  resetIdentityTrustVaults,
} from '../lib/crypto/identityTrust';
import { LOCAL_SERVER_ID, type AccountScope } from '../lib/serverScope';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';

/**
 * A stand-in for the account vault that peer trust is stored in.
 *
 * It keeps the two properties the real vault gives the trust store and that the
 * tests depend on: records survive as long as the vault is open (so a "reload"
 * is modelled by re-opening the same backing map), and an atomic transaction
 * commits nothing when its body throws.
 */
export function createIdentityTrustVault(records = new Map<string, unknown>()) {
  const address = (namespace: string, id: string) => JSON.stringify([namespace, id]);
  const vault = {
    async transact<T>(run: (transaction: VaultTransaction) => Promise<T>): Promise<T> {
      const staged = new Map<string, { namespace: string; id: string; value: unknown | null }>();
      const transaction: VaultTransaction = {
        async get<V>(namespace: string, id: string): Promise<V | null> {
          const pending = staged.get(address(namespace, id));
          if (pending) return (pending.value as V | null) ?? null;
          return (records.get(address(namespace, id)) as V | undefined) ?? null;
        },
        async list<V>(namespace: string): Promise<Array<{ id: string; value: V }>> {
          const values = new Map<string, V>();
          for (const [key, value] of records) {
            const [space, id] = JSON.parse(key) as [string, string];
            if (space === namespace) values.set(id, value as V);
          }
          for (const pending of staged.values()) {
            if (pending.namespace !== namespace) continue;
            if (pending.value === null) values.delete(pending.id);
            else values.set(pending.id, pending.value as V);
          }
          return [...values].map(([id, value]) => ({ id, value }));
        },
        put(namespace, id, value) {
          staged.set(address(namespace, id), { namespace, id, value: JSON.parse(JSON.stringify(value)) as unknown });
        },
        remove(namespace, id) {
          staged.set(address(namespace, id), { namespace, id, value: null });
        },
      };
      const result = await run(transaction);
      for (const pending of staged.values()) {
        if (pending.value === null) records.delete(address(pending.namespace, pending.id));
        else records.set(address(pending.namespace, pending.id), pending.value);
      }
      return result;
    },
  };
  return { vault: vault as unknown as AccountVault, records };
}

/** Register an open trust vault for the active account, as the runtime does. */
export function installIdentityTrustVault(records?: Map<string, unknown>, userId = 'me') {
  const scope: AccountScope = { serverId: LOCAL_SERVER_ID, userId };
  useServerListStore.setState({ activeServerId: LOCAL_SERVER_ID });
  useAuthStore.setState({ user: { id: scope.userId, username: userId } as User });
  const { vault, records: backing } = createIdentityTrustVault(records);
  registerIdentityTrustVault(scope, vault);
  return {
    scope,
    records: backing,
    /** Model locking: the vault closes, the stored records stay where they are. */
    lock: () => releaseIdentityTrustVault(scope, vault),
  };
}

export function resetIdentityTrust() {
  resetIdentityTrustVaults();
}
