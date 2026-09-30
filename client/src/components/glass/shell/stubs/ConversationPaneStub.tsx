import { TopBar } from '../../../layout/TopBar';
import { CallPill } from '../../pill';
import { PlacesToggle } from '../PlacesToggle';
import { useGlassLayout } from '../useGlassLayout';
import type { ConversationPaneProps } from '../slots';

/**
 * STUB (WP-G7) for `components/glass/conversation` — WP-G11 replaces it with
 * the Glass conversation (76px header, call pill, composer capsule); WP-G10
 * restyles the timeline it is handed.
 *
 * The regions and their geometry are final; what fills the header is not. The
 * header is today's Lantern `TopBar`, built from `subject`, and the adapter
 * rules in styles/glass-layout.css (keyed on `glass-stub-conversation`) move
 * its title to the column's left edge and its actions to the pane's right
 * edge. The pill slot is mounted where the spec puts it and renders nothing
 * until WP-G12.
 */
export function ConversationPane({ subject, notices, timeline, composer, dock }: ConversationPaneProps) {
  const layout = useGlassLayout();
  const header =
    subject.kind === 'dm' ? (
      <TopBar isDM recipientName={subject.title} dmChannelId={subject.channelId} />
    ) : (
      <TopBar
        channelName={subject.channelName}
        channelTopic={subject.topic ?? undefined}
        isForum={subject.isForum}
        guildId={subject.guildId}
        guildName={subject.guildName}
      />
    );

  return (
    <div className="glass-conversation glass-stub-conversation" data-subject={subject.kind}>
      <div className="glass-conversation__header">
        <PlacesToggle className="glass-conversation__places-toggle" />
        <div className="glass-conversation__heading">{header}</div>
        <CallPill
          guildId={subject.kind === 'channel' ? subject.guildId : null}
          layout={layout === 'phone' ? 'stacked' : 'row'}
        />
      </div>
      {notices != null && <div className="glass-conversation__notices">{notices}</div>}
      <div className="glass-conversation__timeline">{timeline}</div>
      {composer != null && <div className="glass-conversation__composer">{composer}</div>}
      {dock}
    </div>
  );
}
