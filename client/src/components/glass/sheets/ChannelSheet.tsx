import { useEffect, useRef, useState } from 'react';
import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useGuild } from '../../../hooks/useGuilds';
import type { Message } from '../../../types';
import { GuildEconomyPanel } from '../../guild/GuildEconomyPanel';
import { PinnedMessagesOverlay } from '../../layout/overlays/PinnedMessagesOverlay';
import { MediaGalleryPanel } from '../../media/MediaGalleryPanel';
import { ThreadPanel } from '../../message/ThreadPanel';
import { FollowsPage } from './FollowsPage';
import { NotificationsPage } from './NotificationsPage';
import { SheetFrame } from './SheetFrame';
import { SummaryPage } from './SummaryPage';
import { ThreadsPage, threadListParentOf } from './ThreadsPage';
import { CHANNEL_SHEET_PAGES, useSheetPages, type ChannelSheetPage } from './sheetStore';

/**
 * The channel sheet (docs/index-spec.md §6.1, §6.5: catch-up summary, pins,
 * threads, media, follows, leaderboard and notification settings, one page each;
 * WP IX-9, formerly WP-G18).
 *
 * One frame, several pages. The channel menu (the large or folded title) opens
 * the page it names; a segmented control at the top of the sheet moves between
 * them without going back to the menu. It scrolls sideways when the pages do not
 * fit the sheet's width. A thread pushed on the Threads page takes over the
 * sheet (title, timeline, message box) and its back button pops it.
 */

const PAGE_TITLE: Record<ChannelSheetPage, string> = {
  summary: 'Catch up summary',
  pins: 'Pinned messages',
  threads: 'Threads',
  follows: 'Channel follows',
  media: 'Media',
  leaderboard: 'Server leaderboard',
  notifications: 'Notifications',
};

const PAGE_TAB: Record<ChannelSheetPage, string> = {
  summary: 'Catch up',
  pins: 'Pins',
  threads: 'Threads',
  follows: 'Follows',
  media: 'Media',
  leaderboard: 'Leaderboard',
  notifications: 'Notifications',
};

export interface ChannelSheetProps {
  open: boolean;
  onClose: () => void;
  guildId: string | null;
  channelId: string | null;
}

/**
 * Which pages make sense where. A direct message has no threads, follows or
 * leaderboard; only an announcement channel has follows; a server page with no
 * channel (opened from the server home) has just the pages about the server.
 */
function pagesFor({ isDm, hasChannel, isAnnouncement }: { isDm: boolean; hasChannel: boolean; isAnnouncement: boolean }): ChannelSheetPage[] {
  return CHANNEL_SHEET_PAGES.filter((page) => {
    if (!hasChannel) return page === 'media' || page === 'leaderboard';
    if (isDm) return page === 'summary' || page === 'pins' || page === 'media';
    if (page === 'follows') return isAnnouncement;
    return true;
  });
}

function PinsPage({ channelId, onClose }: { channelId: string | null; onClose: () => void }) {
  const [pins, setPins] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Keyed by channel where it is used, so it starts empty for each.
  useEffect(() => {
    if (!channelId) return;
    let canceled = false;
    channelApi
      .getPins(channelId)
      .then(({ data }) => {
        if (!canceled) setPins(data);
      })
      .catch((err) => {
        if (!canceled) {
          setPins([]);
          setError(`Failed to load pinned messages: ${extractApiError(err)}`);
        }
      });
    return () => {
      canceled = true;
    };
  }, [channelId]);

  return (
    <PinnedMessagesOverlay
      open
      presentation="panel"
      onClose={onClose}
      channelId={channelId ?? undefined}
      pins={pins}
      onPinsChange={setPins}
      error={error}
      onErrorChange={setError}
    />
  );
}

export function ChannelSheet({ open, onClose, guildId, channelId }: ChannelSheetProps) {
  const channelPage = useSheetPages((s) => s.channelPage);
  const threadId = useSheetPages((s) => s.threadId);
  const setChannelPage = useSheetPages((s) => s.setChannelPage);
  const pushThread = useSheetPages((s) => s.pushThread);
  const popThread = useSheetPages((s) => s.popThread);
  const channelsById = useCurrentChannelStore((s) => s.channelsById);
  const channel = channelId ? channelsById[channelId] : undefined;
  const type = channel?.type ?? channel?.channel_type;
  const isDm = type === 1 || type === 3 || !guildId;
  const isAnnouncement = type === 5;
  const guildName = useGuild(guildId)?.name;

  const tabsRef = useRef<HTMLDivElement>(null);
  const pages = pagesFor({ isDm, hasChannel: Boolean(channelId), isAnnouncement });
  // Opened with no page named (`glassStore.openSheet('channel')`): pins, which
  // costs nothing to show (the summary would ask a model).
  const page: ChannelSheetPage = channelPage && pages.includes(channelPage)
    ? channelPage
    : pages.includes('pins') ? 'pins' : pages[0];

  const thread = threadId ? channelsById[threadId] : undefined;
  const pushed = page === 'threads' && threadId !== null;
  const parentName = pushed
    ? channelsById[thread?.parent_id ?? threadListParentOf(channel, channelId) ?? '']?.name ?? channel?.name
    : undefined;

  const channelName = channel?.name || (isDm ? 'Direct message' : 'Channel');
  const subtitle = pushed
    ? 'Thread'
    : page === 'leaderboard'
      ? guildName
      : page === 'media' && !channelId
        ? 'Every channel you can read'
        : channelName;

  const title = pushed ? thread?.name || 'Thread' : PAGE_TITLE[page];

  // Keep the page in force in view when the segments overflow the sheet.
  useEffect(() => {
    const selected = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (typeof selected?.scrollIntoView === 'function') selected.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [page, pushed]);

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      kind="channel"
      label={pushed ? `Thread: ${title}` : PAGE_TITLE[page]}
      title={title}
      subtitle={subtitle}
      onBack={pushed ? popThread : undefined}
      backLabel="Back to threads"
      closeLabel={pushed ? 'Close thread' : `Close ${PAGE_TITLE[page].toLowerCase()}`}
      body={pushed ? 'fill' : 'scroll'}
    >
      {pushed && threadId && guildId ? (
        <ThreadPanel
          guildId={guildId}
          threadChannelId={threadId}
          threadName={thread?.name || 'Thread'}
          parentChannelName={parentName ?? ''}
          onClose={onClose}
          // A deleted thread is gone from the list: go back to it.
          onDeleted={popThread}
        />
      ) : (
        <>
          {pages.length > 1 && (
            <div className="ix-sheet__tabs" ref={tabsRef}>
              <div className="glass-sheet-tabs" role="tablist" aria-label="Channel pages">
                {pages.map((value) => (
                  <button
                    key={value}
                    id={`channel-sheet-tab-${value}`}
                    type="button"
                    role="tab"
                    aria-selected={page === value}
                    aria-controls="channel-sheet-page"
                    data-page={value}
                    className="glass-sheet-tab glass-focusable"
                    onClick={() => setChannelPage(value)}
                    onKeyDown={(event) => {
                      // A segmented control moves with the arrow keys and selects as it goes.
                      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                      if (!step) return;
                      event.preventDefault();
                      const next = pages[(pages.indexOf(value) + step + pages.length) % pages.length];
                      setChannelPage(next);
                      // Every segment is in the DOM already, so focus can follow at once.
                      document.getElementById(`channel-sheet-tab-${next}`)?.focus();
                    }}
                    tabIndex={page === value ? 0 : -1}
                  >
                    {PAGE_TAB[value]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            key={page}
            id="channel-sheet-page"
            role={pages.length > 1 ? 'tabpanel' : undefined}
            aria-labelledby={pages.length > 1 ? `channel-sheet-tab-${page}` : undefined}
            className="pc-content-in"
            data-page={page}
          >
            {page === 'summary' && <SummaryPage key={channelId ?? 'none'} channelId={channelId} />}
            {page === 'pins' && <PinsPage key={channelId ?? 'none'} channelId={channelId} onClose={onClose} />}
            {page === 'threads' && (
              <ThreadsPage channelId={channelId} onOpen={pushThread} onClose={onClose} />
            )}
            {page === 'follows' && <FollowsPage key={channelId ?? 'none'} channelId={channelId} />}
            {page === 'media' && <MediaGalleryPanel guildId={guildId} channelId={channelId} />}
            {page === 'leaderboard' && guildId && <GuildEconomyPanel guildId={guildId} />}
            {page === 'notifications' && <NotificationsPage channelId={channelId} guildId={guildId} />}
          </div>
        </>
      )}
    </SheetFrame>
  );
}
