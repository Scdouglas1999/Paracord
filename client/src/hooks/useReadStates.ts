import { useReadStateStore, EMPTY_READ_STATES } from '../stores/readStateStore';
import { useCurrentAccountScope } from './useCurrentUser';
import { accountScopeKey } from '../lib/serverScope';

export function useCurrentReadStates() {
  const scope = useCurrentAccountScope();
  return useReadStateStore(state => scope ? state.byAccount[accountScopeKey(scope)] ?? EMPTY_READ_STATES : EMPTY_READ_STATES);
}
