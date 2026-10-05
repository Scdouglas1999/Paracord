import { useEffect, useMemo, useState } from 'react';

import { userApi } from '../../../api/users';
import { useCurrentChannelStore, useGuildChannels } from '../../../hooks/useChannels';
import { useGuild } from '../../../hooks/useGuilds';
import { usePermissions } from '../../../hooks/usePermissions';
import { pendingGroupMembers, isGroupDm } from '../../../lib/messages/messagingReadiness';
import { useRelationshipStore } from '../../../stores/relationshipStore';
import { Permissions, hasPermission, type Channel } from '../../../types';
import type { ConversationSubject } from './types';
import type { WelcomeFacts } from './welcomeModel';

const channelKind = (channel: Pick<Channel, 'type' | 'channel_type'>) => channel.type ?? channel.channel_type;

/**
 * The channel the server opens on: its `default_channel_id`, else its first text
 * channel, else its first channel (the same choice `guildLandingPath` makes).
 */
export function useLandingChannelId(guildId: string | null): string | null {
  const guild = useGuild(guildId);
  const channels = useGuildChannels(guildId);
  return useMemo(() => {
    const open = channels.filter((channel) => channelKind(channel) !== 4);
    return (
      (
        open.find((channel) => channel.id === guild?.default_channel_id) ??
        open.find((channel) => channelKind(channel) === 0) ??
        open[0]
      )?.id ?? null
    );
  }, [channels, guild?.default_channel_id]);
}

export interface WelcomeFactsInput {
  subject: ConversationSubject;
  /** The conversation's own send decision (`useConversationActions`). */
  canSend: boolean;
  /** The first visit to a server you did not make; decided once per visit (`isWelcomed`). */
  joiner: boolean;
  /** Offer "Pick roles" (the server's onboarding has roles and the page can open it). */
  hasRoles: boolean;
}

/**
 * The facts `buildWelcome` decides from (docs/index-spec.md §4.13), gathered from
 * the stores. It runs inside the empty state, so none of it costs anything in a
 * conversation that has messages: the profile request for "You share Game Night"
 * is made only for a new one-to-one message.
 */
export function useWelcomeFacts({ subject, canSend, joiner, hasRoles }: WelcomeFactsInput): WelcomeFacts {
  const guildId = subject.kind === 'channel' ? subject.guildId : null;
  const guild = useGuild(guildId);
  const channels = useGuildChannels(guildId);
  const { permissions, isAdmin } = usePermissions(guildId);

  // Create Invite and Manage Events (the server maps events to Manage Server). A
  // plan is posted as a message, so it also needs Send Messages here.
  const canInvite = guildId !== null && (isAdmin || hasPermission(permissions, Permissions.CREATE_INSTANT_INVITE));
  const canPlan = guildId !== null && canSend && (isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD));

  const landingId = useLandingChannelId(guildId);
  const serverEmpty = useMemo(
    () => channels.filter((channel) => channelKind(channel) !== 4).every((channel) => !channel.last_message_id),
    [channels],
  );

  // A new one-to-one message: friends, or the servers the two of you share.
  const recipientId = subject.kind === 'dm' && !subject.isGroup ? (subject.recipient?.id ?? null) : null;
  const friends = useRelationshipStore((state) =>
    recipientId ? state.relationships.some((relation) => relation.type === 1 && relation.user.id === recipientId) : false,
  );
  const [shared, setShared] = useState<{ id: string; names: string[] } | null>(null);
  useEffect(() => {
    if (!recipientId || friends) return;
    let live = true;
    userApi
      .getProfile(recipientId)
      .then(({ data }) => {
        if (live) setShared({ id: recipientId, names: data.mutual_guilds.map((guildRow) => guildRow.name) });
      })
      .catch(() => {
        // The line falls back to "Direct message": a profile that could not be read says nothing.
      });
    return () => {
      live = false;
    };
  }, [recipientId, friends]);

  // A group whose members have not all published an identity key cannot carry a message.
  const channel = useCurrentChannelStore((state) => state.channelsById[subject.channelId]);
  const waitingOn = useMemo(
    () => (subject.kind === 'dm' && isGroupDm(channel?.channel_type ?? channel?.type) ? pendingGroupMembers(channel?.recipients) : []),
    [subject.kind, channel],
  );

  return {
    subject,
    serverName: subject.kind === 'channel' ? (guild?.name ?? subject.guildName) : undefined,
    description: guild?.description ?? null,
    firstChannel: landingId !== null && landingId === subject.channelId,
    serverEmpty,
    joiner,
    canInvite,
    canPlan,
    canSend,
    hasRoles,
    relationship: recipientId ? { friends, sharedServers: shared?.id === recipientId ? shared.names : [] } : undefined,
    waitingOn,
  };
}
