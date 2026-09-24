import { useEffect } from 'react';

import { useTogetherStore, type TogetherNotice } from '../../../stores/togetherStore';
import { useLingering } from '../../../lib/motion';
import { cn } from '../../../lib/utils';

/** How long "Priya paused" stays up. */
export const NOTICE_MS = 3200;

/**
 * The newest change someone else made in this call ("Priya paused"), for a few
 * seconds. Changes land in the call, never in its chat.
 */
export function useLatestNotice(channelId: string | null): TogetherNotice | null {
  const notice = useTogetherStore((s) => {
    if (!channelId) return null;
    for (let i = s.notices.length - 1; i >= 0; i--) if (s.notices[i].channelId === channelId) return s.notices[i];
    return null;
  });
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => useTogetherStore.getState().dismissNotice(notice.id), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return notice;
}

/** A quiet pill over the top of the shared video. */
export function TogetherNoticePill({
  notice,
  nameOf,
  className,
}: {
  notice: TogetherNotice | null;
  nameOf: (userId: string | null) => string;
  className?: string;
}) {
  // The pill pops in over the video and, when its few seconds are up, pops
  // back out rather than vanishing (§5.2): the last notice is kept for the
  // leave. A newer notice replacing it is a new pill (keyed), so it pops in.
  const shown = useLingering(notice);
  return (
    <div aria-live="polite" className={cn('pointer-events-none flex justify-center', className)}>
      {shown.value && (
        <span
          key={shown.value.id}
          className={cn(
            'pc-tag inline-flex h-7 max-w-full items-center truncate px-3 text-meta font-medium',
            shown.leaving ? 'pc-pop-out' : 'pc-pop-in',
          )}
        >
          {noticeSentence(shown.value, nameOf)}
        </span>
      )}
    </div>
  );
}

export function noticeSentence(notice: TogetherNotice, nameOf: (userId: string | null) => string): string {
  if (notice.text.startsWith('left, so everyone')) return 'Everyone can control it now';
  return `${nameOf(notice.userId)} ${notice.text}`;
}
