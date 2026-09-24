import { useEffect, useState } from 'react';
import { Film, Music } from 'lucide-react';

import type { TogetherItem } from '../../../lib/together/model';
import { cn } from '../../../lib/utils';

export type CoverItem = Pick<TogetherItem, 'thumbnail' | 'content_type' | 'source'>;

/** Audio files get the music note; everything else (video, YouTube) the film. */
export function isAudioCover(item: CoverItem): boolean {
  return item.source !== 'youtube' && (item.content_type ?? '').startsWith('audio/');
}

/**
 * The picture for an item: YouTube's thumbnail, or the still the adder's
 * device took from an attached video; otherwise a quiet film or music glyph on
 * a raised surface.
 */
export function TogetherCover({
  item,
  className,
  large = false,
}: {
  item: CoverItem;
  className?: string;
  large?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.thumbnail]);

  if (item.thumbnail && !broken) {
    return (
      <img
        src={item.thumbnail}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
        className={cn('h-full w-full object-cover', className)}
      />
    );
  }
  const Glyph = isAudioCover(item) ? Music : Film;
  return (
    <div aria-hidden className={cn('flex h-full w-full items-center justify-center bg-bg-mod-strong text-text-secondary', className)}>
      <Glyph size={large ? 40 : 18} strokeWidth={1.6} />
    </div>
  );
}
