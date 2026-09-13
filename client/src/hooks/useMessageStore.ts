import { create, useStore } from 'zustand';
import { getMessageStore, type MessageState } from '../stores/messageStore';
import { useCurrentAccountScope } from './useCurrentUser';
import { useAvailableAccountScopes } from './useAvailableAccountScopes';
import { accountScopeKey } from '../lib/serverScope';
import type { AccountScope } from '../lib/serverScope';

const unavailable = (): never => { throw new Error('Sign in to this server before accessing messages.'); };
const emptyStore = Object.assign(create<MessageState>(() => ({
  messages: {}, hasMore: {}, loading: {}, messageErrors: {}, pins: {}, decryptingIds: new Set(), deletedMessageIds: new Set(), offlineQueue: [],
  fetchMessages: unavailable, sendMessage: unavailable, scheduleMessage: unavailable, editScheduledMessage: unavailable,
  flushOfflineQueue: unavailable, editMessage: unavailable, deleteMessage: unavailable, setMessages: unavailable,
  fetchPins: unavailable, pinMessage: unavailable, unpinMessage: unavailable, addReaction: unavailable, removeReaction: unavailable,
  handleReactionAdd: unavailable, handleReactionRemove: unavailable, updatePinState: unavailable, addMessage: unavailable,
  updateMessage: unavailable, removeMessage: unavailable, removeMessages: unavailable, updateUserIdentity: unavailable, reset() {},
})), { scope: null });

function useOwnedMessageStoreApi(scope: AccountScope | null) {
  const available = useAvailableAccountScopes();
  const owner = scope && available.find(candidate => accountScopeKey(candidate) === accountScopeKey(scope));
  return owner ? getMessageStore(owner) : emptyStore;
}
export function useCurrentMessageStoreApi() {
  return useOwnedMessageStoreApi(useCurrentAccountScope());
}
export function useCurrentMessageStore<T>(selector: (state: MessageState) => T): T {
  return useStore(useCurrentMessageStoreApi(), selector);
}
export function useAccountMessageStore<T>(scope: AccountScope, selector: (state: MessageState) => T): T {
  return useStore(useOwnedMessageStoreApi(scope), selector);
}
