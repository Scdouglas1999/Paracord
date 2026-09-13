import { useEffect, useCallback } from 'react';
import { useCurrentMessageStore, useCurrentMessageStoreApi } from './useMessageStore';
import type { Message } from '../types';

const EMPTY_MESSAGES: Message[] = [];

export function useMessages(channelId: string | null) {
  const scope = useCurrentMessageStoreApi().scope;
  const messages = useCurrentMessageStore((s) =>
    channelId ? (s.messages[channelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const hasMore = useCurrentMessageStore((s) =>
    channelId ? s.hasMore[channelId] !== false : false
  );
  const isLoading = useCurrentMessageStore((s) =>
    channelId ? !!s.loading[channelId] : false
  );
  const error = useCurrentMessageStore((s) =>
    channelId ? (s.messageErrors[channelId] ?? null) : null
  );
  const fetchMessages = useCurrentMessageStore((s) => s.fetchMessages);
  const sendMessage = useCurrentMessageStore((s) => s.sendMessage);

  useEffect(() => {
    if (scope && channelId) void fetchMessages(channelId);
  }, [scope, channelId, fetchMessages]);

  const loadMore = useCallback(() => {
    if (channelId && hasMore && messages.length > 0) {
      fetchMessages(channelId, { before: messages[0].id });
    }
  }, [channelId, hasMore, messages, fetchMessages]);

  const send = useCallback(
    (content: string, referencedMessageId?: string) => {
      if (channelId) sendMessage(channelId, content, referencedMessageId);
    },
    [channelId, sendMessage]
  );

  return { messages, hasMore, isLoading, error, loadMore, sendMessage: send };
}
