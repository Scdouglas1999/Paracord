import { useRef, type CSSProperties, type ReactNode } from 'react';

import { useConversationActions } from '../../../hooks/useConversationActions';
import { ForumView } from '../../channel/ForumView';
import { ErrorBoundary } from '../../ErrorBoundary';
import { LargeTitle } from '../page';
import { openChannelMenu } from '../menus';
import { serverPlace, usePlaceHue, useToolbar } from '../shell';
import type { ConversationSubject } from './types';

type ForumSubject = Extract<ConversationSubject, { kind: 'channel' }>;

export interface ForumPageProps {
  subject: ForumSubject;
  /** Under the title (the entry gates, a pinned notice). */
  notices?: ReactNode;
}

/**
 * A forum channel in main (docs/index-spec.md §8.1): the same large title and
 * toolbar as a conversation, over the forum's own posts. Chrome only: the posts,
 * their tags and the New post form keep `ForumView`'s own layout and scroller (a
 * forum has no feed to fold the title into, so the title stays put and the toolbar
 * shows no folded one).
 */
export function ForumPage({ subject, notices }: ForumPageProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const { actions } = useConversationActions(subject.channelId);
  const hue = usePlaceHue(serverPlace(subject.guildId));
  const summary = actions.summary;
  const subtitle = subject.topic?.trim() || undefined;

  const openMenu = () => {
    const element = host.current?.querySelector<HTMLElement>('.ix-large-title__button');
    openChannelMenu(
      {
        subject: { kind: 'channel', guildId: subject.guildId, channelId: subject.channelId, channelName: subject.channelName },
        summary,
      },
      element ? { element, align: 'start' } : { x: 0, y: 0 },
    );
  };

  useToolbar({
    title: subject.channelName,
    onTitleClick: openMenu,
    titleHasPopup: 'menu',
    folded: false,
    search: true,
    members: true,
  });

  return (
    <div
      ref={host}
      className="ix-conv ix-conv--forum"
      data-testid="ix-conversation"
      data-subject="forum"
      style={{ '--ix-hue': hue } as CSSProperties}
    >
      <div className="ix-tl-col ix-conv-head ix-conv-head--forum">
        <LargeTitle
          title={subject.channelName}
          subtitle={subtitle}
          onTitleClick={openMenu}
          titleHasPopup="menu"
        />
        {notices != null && <div className="ix-conv-notices">{notices}</div>}
      </div>
      <div className="ix-forum-body">
        <ErrorBoundary variant="section" label="posts">
          <ForumView channelId={subject.channelId} channelName={subject.channelName} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
