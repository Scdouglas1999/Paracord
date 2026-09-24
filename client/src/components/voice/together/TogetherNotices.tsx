import { useEffect } from 'react';

import { useTogetherStore, type TogetherNotice } from '../../../stores/togetherStore';
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
  return (
    <div aria-live="polite" className={cn('pointer-events-none flex justify-center', className)}>
      {notice && (
        <span
          key={notice.id}
          className="pc-tag pc-enter inline-flex h-7 max-w-full items-center truncate px-3 text-meta font-medium"
        >
          {noticeSentence(notice, nameOf)}
        </span>
      )}
    </div>
  );
}

export function noticeSentence(notice: TogetherNotice, nameOf: (userId: string | null) => string): string {
  if (notice.text.startsWith('left, so everyone')) return 'Everyone can control it now';
  return `${nameOf(notice.userId)} ${notice.text}`;
}
