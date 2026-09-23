import { Hash, Volume2, MessageSquare, Users, Compass } from 'lucide-react';
import { ChannelType, type Guild, type Channel } from '../../types';
import { safeStoredImageDataUrl } from '../../lib/security';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import {
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../ui/Modal';
import { GroupLabel } from './SettingsPrimitives';

interface GuildWelcomeScreenProps {
  guild: Guild;
  channels: Channel[];
  onDismiss: () => void;
}

export function GuildWelcomeScreen({ guild, channels, onDismiss }: GuildWelcomeScreenProps) {
  // Group channels by category
  const categories = new Map<string | null, { name: string; channels: Channel[] }>();
  const categoryNames = new Map<string, string>();

  for (const ch of channels) {
    if (ch.type === 4) {
      categoryNames.set(ch.id, ch.name || 'Unknown');
    }
  }

  for (const ch of channels) {
    if (ch.type === 4) continue; // skip category channels themselves
    // A thread is one conversation inside a channel, not a channel to explore.
    if (ch.type === ChannelType.Thread) continue;
    const parentId = ch.parent_id || null;
    if (!categories.has(parentId)) {
      categories.set(parentId, {
        name: parentId ? categoryNames.get(parentId) || 'Other' : 'Channels',
        channels: [],
      });
    }
    categories.get(parentId)!.channels.push(ch);
  }

  // Sort channels within each category by position
  for (const cat of categories.values()) {
    cat.channels.sort((a, b) => a.position - b.position);
  }

  const textChannels = channels.filter(ch => ch.type === 0 || ch.channel_type === 0);
  const iconSrc = safeStoredImageDataUrl(guild.icon_hash);

  const gettingStarted = [
    {
      icon: Users,
      title: 'Meet the members',
      body:
        guild.member_count === 1
          ? "You're first through the door — invite a few friends to get things going."
          : `${guild.member_count} people are already here. Say hi when you're ready.`,
    },
    {
      icon: Compass,
      title: 'Find your channels',
      body:
        textChannels.length > 0
          ? `${textChannels.length} ${textChannels.length === 1 ? 'channel is' : 'channels are'} waiting below — each one is a different conversation.`
          : 'Channels will show up here as the server takes shape.',
    },
    {
      icon: MessageSquare,
      title: 'Break the ice',
      body: 'A first message goes a long way. Drop a hello and settle in.',
    },
  ];

  return (
    <Modal
      open
      onClose={onDismiss}
      labelledBy="guild-welcome-title"
      describedBy="guild-welcome-description"
      showCloseButton
      closeLabel="Close welcome screen"
      panelClassName="w-[min(92vw,32rem)]"
    >
      <div className="flex max-h-[min(86dvh,42rem)] flex-col">
        <ModalHeader
          className="pb-5 pr-14"
          icon={
            <div className="pc-well flex h-16 w-16 items-center justify-center overflow-hidden rounded-[var(--radius-card)]">
              {iconSrc ? (
                <img
                  src={iconSrc}
                  alt={guild.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="pc-display text-title text-text-primary">
                  {guild.name.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
          }
        >
          <GroupLabel>Welcome aboard</GroupLabel>
          <ModalTitle id="guild-welcome-title" className="mt-1">
            {guild.name}
          </ModalTitle>
          {guild.description ? (
            <ModalDescription id="guild-welcome-description">
              {guild.description}
            </ModalDescription>
          ) : (
            <p
              id="guild-welcome-description"
              className="mt-2 flex items-center gap-1.5 text-meta text-text-muted"
            >
              <Users size={13} className="shrink-0" aria-hidden />
              {guild.member_count} member{guild.member_count !== 1 ? 's' : ''}
            </p>
          )}
        </ModalHeader>
        <Divider />

        <ModalBody className="min-h-0 flex-1 overflow-auto py-5">
          {/* Getting-started rows */}
          <GroupLabel>Get started</GroupLabel>
          <div className="mt-2 divide-y divide-border-subtle">
            {gettingStarted.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3 py-3">
                <div className="pc-well mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center text-text-muted">
                  <Icon size={16} aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="pc-display text-name text-text-primary">{title}</div>
                  <p className="mt-0.5 text-meta leading-relaxed text-text-secondary">{body}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Channel overview */}
          {textChannels.length > 0 && (
            <div className="mt-5">
              <GroupLabel>Explore channels</GroupLabel>
              <div className="scrollbar-thin mt-2 max-h-44 space-y-0.5 overflow-y-auto">
                {Array.from(categories.entries()).map(([catId, cat]) => (
                  <div key={catId || '__uncategorized'}>
                    {catId && (
                      <div className="mb-0.5 mt-2 px-2 text-section text-text-faint">
                        {cat.name}
                      </div>
                    )}
                    {cat.channels.slice(0, 8).map(ch => {
                      const isVoice = ch.type === 2 || ch.channel_type === 2;
                      const isForum = ch.type === 7 || ch.channel_type === 7;
                      return (
                        <div
                          key={ch.id}
                          className="flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-label text-text-secondary"
                        >
                          {isVoice ? (
                            <Volume2 size={16} className="shrink-0 text-channel-icon" aria-hidden />
                          ) : isForum ? (
                            <MessageSquare size={16} className="shrink-0 text-channel-icon" aria-hidden />
                          ) : (
                            <Hash size={16} className="shrink-0 text-channel-icon" aria-hidden />
                          )}
                          <span className="truncate font-medium">{ch.name || 'unknown'}</span>
                          {ch.topic && (
                            <span className="ml-auto max-w-[140px] truncate text-meta text-text-faint">
                              {ch.topic}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </ModalBody>

        {/* Footer action — the one primary action on this screen. */}
        <Divider />
        <ModalFooter className="items-center pt-4">
          <Button onClick={onDismiss}>
            Jump in
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
