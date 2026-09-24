import type { FeedUser } from '../../../../api/serverFeed';
import type { Member } from '../../../../types';
import type { HomeEvent } from '../useUpcomingEvents';
import { ComingUpWidget } from './ComingUpWidget';
import { DailyWordWidget } from './DailyWordWidget';
import { GameWidget } from './GameWidget';
import { MediaWidget } from './MediaWidget';
import { MostActiveWidget } from './MostActiveWidget';
import { NewHereWidget } from './NewHereWidget';
import { PinnedWidget } from './PinnedWidget';
import type { HomeWidgetId } from './widgetConfig';

export interface WidgetContext {
  guildId: string;
  nowMs: number;
  viewerId: string | null;
  events: readonly HomeEvent[];
  eventsError: string | null;
  members: readonly Member[] | undefined;
  announcementChannels: readonly { id: string; name: string }[];
  mentionNames: Map<string, string>;
  /** A live game is already a card in "Live now". */
  liveGameShown: boolean;
  channelName: (channelId: string | null) => string | null;
  onRsvp: (eventId: string) => void;
  onCalendar: () => void;
  onOpenMedia: () => void;
  onOpenLeaderboard: () => void;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onSayHi: (user: FeedUser) => void;
}

/** One widget by id. Each returns nothing when it has nothing to show. */
export function HomeWidget({ id, context }: { id: HomeWidgetId; context: WidgetContext }) {
  switch (id) {
    case 'coming_up':
      return (
        <ComingUpWidget
          events={context.events}
          error={context.eventsError}
          nowMs={context.nowMs}
          channelName={context.channelName}
          onRsvp={context.onRsvp}
          onCalendar={context.onCalendar}
        />
      );
    case 'media':
      return <MediaWidget guildId={context.guildId} onOpenMedia={context.onOpenMedia} />;
    case 'most_active':
      return (
        <MostActiveWidget guildId={context.guildId} nowMs={context.nowMs} onOpenLeaderboard={context.onOpenLeaderboard} />
      );
    case 'game':
      return <GameWidget guildId={context.guildId} liveShownElsewhere={context.liveGameShown} />;
    case 'pinned':
      return (
        <PinnedWidget
          guildId={context.guildId}
          announcementChannels={context.announcementChannels}
          mentionNames={context.mentionNames}
          onOpenMessage={context.onOpenMessage}
        />
      );
    case 'new_here':
      return (
        <NewHereWidget
          members={context.members}
          viewerId={context.viewerId}
          nowMs={context.nowMs}
          onSayHi={context.onSayHi}
        />
      );
    case 'daily_word':
      return <DailyWordWidget guildId={context.guildId} nowMs={context.nowMs} />;
  }
}

/** The widgets in the owner's order. Empty ones leave no gap: they render nothing. */
export function WidgetStack({ ids, context }: { ids: readonly HomeWidgetId[]; context: WidgetContext }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3.5 empty:hidden">
      {ids.map((id) => (
        <HomeWidget key={id} id={id} context={context} />
      ))}
    </div>
  );
}
