import type { ReactNode, Ref } from 'react';

import { cn } from '../../../lib/utils';

export interface LargeTitleProps {
  /** The title (36/700): a channel's name, a person's, a page's. */
  title: ReactNode;
  /** The line under it (14, ink-3): the topic, "Direct message", a lock and "End-to-end encrypted"... */
  subtitle?: ReactNode;
  /** The title is a button: the channel menu, or a DM's profile card (§4.11). */
  onTitleClick?: () => void;
  titleHasPopup?: 'menu' | 'dialog';
  /** The element that folds (`useTitleFold().titleRef`). */
  foldRef?: Ref<HTMLElement>;
  className?: string;
}

/**
 * The large title (docs/index-spec.md §3.1 "Large title", §4.11): padding-top 8
 * inside the column, h1 36/700 tracking −.03em, subtitle 14 ink-3 4px under it.
 * The whole block folds (scale and fade from its left edge, §5.14). The h1
 * carries the test id `ix-title`.
 */
export function LargeTitle({ title, subtitle, onTitleClick, titleHasPopup, foldRef, className }: LargeTitleProps) {
  return (
    <header ref={foldRef} className={cn('ix-large-title', className)}>
      <h1 className="ix-large-title__h" data-testid="ix-title">
        {onTitleClick ? (
          <button type="button" className="ix-large-title__button" aria-haspopup={titleHasPopup} onClick={onTitleClick}>
            {title}
          </button>
        ) : (
          title
        )}
      </h1>
      {subtitle != null && subtitle !== '' && <p className="ix-large-title__sub">{subtitle}</p>}
    </header>
  );
}
