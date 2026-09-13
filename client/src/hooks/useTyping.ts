import { useCallback, useEffect, useRef } from 'react';
import { channelApi } from '../api/channels';
import { TYPING_TIMEOUT } from '../lib/constants';

/**
 * The typing indicator, both ends of it.
 *
 * `triggerTyping` is throttled to one start per `TYPING_TIMEOUT`, which is what
 * keeps a long message from becoming a stream of requests. `stopTyping` ends the
 * indicator the moment the message goes out or the composer empties: before it
 * existed, the only thing that ever cleared "…is typing" was the recipient's own
 * expiry timer, so it stayed on screen for seconds after the message had landed.
 *
 * A stop is only sent when this composer actually started something, and it
 * clears the throttle so the next keystroke starts a fresh indicator.
 */
export function useTyping(channelId: string | null) {
  const lastTypingRef = useRef<number>(0);
  const startedRef = useRef(false);

  const stopTyping = useCallback(() => {
    if (!channelId || !startedRef.current) return;
    startedRef.current = false;
    lastTypingRef.current = 0;
    channelApi.triggerTyping(channelId, true).catch(() => {
      /* ignore */
    });
  }, [channelId]);

  const triggerTyping = useCallback(() => {
    if (!channelId) return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_TIMEOUT) return;
    lastTypingRef.current = now;
    startedRef.current = true;
    channelApi.triggerTyping(channelId).catch(() => {
      /* ignore */
    });
  }, [channelId]);

  // Leaving the conversation ends the indicator too — otherwise the last thing
  // the other person saw was this author typing something that never arrives.
  useEffect(() => stopTyping, [stopTyping]);

  return { triggerTyping, stopTyping };
}
