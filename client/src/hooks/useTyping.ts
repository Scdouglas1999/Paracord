import { useCallback, useRef } from 'react';
import { channelApi } from '../api/channels';
import { TYPING_TIMEOUT } from '../lib/constants';

export function useTyping(channelId: string | null) {
  const lastTypingRef = useRef<number>(0);

  const triggerTyping = useCallback(() => {
    if (!channelId) return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_TIMEOUT) return;
    lastTypingRef.current = now;
    channelApi.triggerTyping(channelId).catch(() => {
      /* ignore */
    });
  }, [channelId]);

  return { triggerTyping };
}
