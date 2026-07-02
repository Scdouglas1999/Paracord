import { useEffect, useCallback } from 'react';
import { useMessageStore } from '../stores/messageStore';
import type { Message } from '../types';

const EMPTY_MESSAGES: Message[] = [];

export function useMessages(channelId: string | null) {
  const messages = useMessageStore((s) =>
    channelId ? (s.messages[channelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const hasMore = useMessageStore((s) =>
    channelId ? s.hasMore[channelId] !== false : false
  );
  const isLoading = useMessageStore((s) =>
    channelId ? !!s.loading[channelId] : false
  );
  const error = useMessageStore((s) =>
    channelId ? (s.messageErrors[channelId] ?? null) : null
  );
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const sendMessage = useMessageStore((s) => s.sendMessage);

  useEffect(() => {
    if (channelId) fetchMessages(channelId);
  }, [channelId, fetchMessages]);

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
