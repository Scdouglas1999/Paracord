import { useState, type ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { useToolbar } from '../shell/toolbarStore';
import { LargeTitle } from './LargeTitle';
import { useTitleFold } from './useTitleFold';

export interface LargeTitlePageProps {
  /** The page's title: the large title, and the toolbar's folded title. */
  title: string;
  subtitle?: ReactNode;
  /** The title (large and folded) opens this: a menu, a profile. */
  onTitleClick?: () => void;
  titleHasPopup?: 'menu' | 'dialog';
  /** A pushed page (§6.1): the toolbar's back chevron. Esc and Alt+Left are the page's to bind. */
  onBack?: () => void;
  backLabel?: string;
  /** The toolbar's DM call button (§7.5). */
  toolbarCall?: ReactNode;
  /** Toolbar tools; default: shown when the route has a server or a conversation. */
  search?: boolean;
  members?: boolean;
  /**
   * `column` (default): the content sits in the conversation column (max 920 +
   * the side padding, centered, §3). `full`: the body spans main (a grid that
   * sets its own width), the title still in the column.
   */
  width?: 'column' | 'full';
  className?: string;
  bodyClassName?: string;
  'data-testid'?: string;
  children?: ReactNode;
}

/**
 * A page in main with the large-title layout (docs/index-spec.md §6.1, §5.14):
 * Overview, Events, Friends, Inbox, Forum, Sports, Daily word, Game servers,
 * Discover, Admin, Developer, and pushed pages (a thread, a game).
 *
 *   .ix-page            the scroller (58px of top padding: the toolbar floats over it)
 *     .ix-column        the column: max 920 + padding 48 (32 under 1024), centered
 *       LargeTitle      folds as the page scrolls
 *       .ix-page__body  children
 *
 * It registers with the toolbar (`useToolbar`): the folded title, the back
 * chevron, the call button, and the fold state. The conversation (IX-15) does
 * the same with its own pieces: `LargeTitle` in `MessageList`'s header,
 * `useTitleFold(listScroller)`, `useToolbar(...)`.
 */
export function LargeTitlePage({
  title,
  subtitle,
  onTitleClick,
  titleHasPopup,
  onBack,
  backLabel,
  toolbarCall,
  search,
  members,
  width = 'column',
  className,
  bodyClassName,
  'data-testid': testId,
  children,
}: LargeTitlePageProps) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const { folded, titleRef } = useTitleFold(scroller);
  useToolbar({
    title,
    onTitleClick: onTitleClick ?? null,
    titleHasPopup: titleHasPopup ?? null,
    folded,
    onBack: onBack ?? null,
    backLabel,
    call: toolbarCall,
    search,
    members,
  });

  const heading = (
    <LargeTitle
      title={title}
      subtitle={subtitle}
      onTitleClick={onTitleClick}
      titleHasPopup={titleHasPopup}
      foldRef={titleRef}
    />
  );

  return (
    <div ref={setScroller} className={cn('ix-page', className)} data-testid={testId}>
      {width === 'column' ? (
        <div className="ix-column">
          {heading}
          <div className={cn('ix-page__body', bodyClassName)}>{children}</div>
        </div>
      ) : (
        <>
          <div className="ix-column">{heading}</div>
          <div className={cn('ix-page__body', bodyClassName)}>{children}</div>
        </>
      )}
    </div>
  );
}
