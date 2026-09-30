import { captureScopedOperation } from '../lib/operationContext';
import { useCurrentChannelStore, getAccountChannelView, useGuildChannels } from '../hooks/useChannels';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { entityScopeKey as memberScopeKey } from '../lib/serverScope';
import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ForumView } from '../components/channel/ForumView';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { cancelMessageFetch } from '../stores/messageStore';
import { BuildingNotFound } from '../components/guild/BuildingNotFound';
import { GuildWelcomeScreen } from '../components/guild/GuildWelcomeScreen';
import { GuildOnboardingGate } from '../components/guild/GuildOnboardingGate';
import { createChannelApi } from '../api/channels';
import { ChannelType } from '../types';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../lib/versionedStorage';
import { GuildLoadingScreen, ChannelNotFoundScreen, ChannelLoadErrorScreen } from './guild/GuildStateScreens';
import { TextChannelView } from './guild/TextChannelView';
import { ChannelAmbient } from '../components/sports/ChannelPin';
import { ConversationPane, type ConversationSubject } from '../components/glass/conversation';
import { StageChannelPanel } from '../components/glass/stage/StageChannelPanel';
export function GuildPage() {
  const { guildId, channelId } = useParams();
  const navigate = useNavigate();
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const channels = useGuildChannels(guildId);
  const channelError = useCurrentChannelStore(s => guildId ? s.errors[guildId] : undefined);
  // "Not yours to see" is a state with a way back, not an error string to
  // print at somebody who followed a stale link.
  const channelsDenied = useCurrentChannelStore(s => (guildId ? Boolean(s.denied[guildId]) : false));
  const fetchChannels = useCurrentChannelStore((s) => s.fetchChannels);
  const memberScope = useCurrentAccountScope();
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const isLoading = useCurrentChannelStore((s) =>
    guildId ? (s.loading[guildId] && !(s.channelsByGuild[guildId]?.length > 0)) : false
  );
  const selectChannel = useCurrentChannelStore((s) => s.selectChannel);
  const channel = channels.find((c) => c.id === channelId);

  // Welcome screen state
  const guilds = useCurrentGuilds();
  const currentGuild = guilds.find((g) => g.id === guildId);
  const [showWelcome, setShowWelcome] = useState(() => {
    if (!guildId) return false;
    return !getVersionedStorageItem(
      `guild-welcomed:${guildId}`,
      [`guild-welcomed:${guildId}`],
    );
  });

  const dismissWelcome = () => {
    if (guildId) {
      setVersionedStorageItem(`guild-welcomed:${guildId}`, '1');
    }
    setShowWelcome(false);
  };

  const channelName = channel?.name || 'Unknown channel';
  const isStage = channel?.type === ChannelType.Stage || channel?.channel_type === ChannelType.Stage;
  const isForum = channel?.type === 7 || channel?.channel_type === 7;

  // Fetch channels when guildId changes
  useEffect(() => {
    if (guildId && memberScope) {
      if (memberScope) selectGuild({ id: guildId, scope: memberScope });
      if (!getAccountChannelView(memberScope).guildChannelsLoaded[guildId]) {
        fetchChannels(guildId);
      }
      if (memberScope && !useMemberStore.getState().membersLoaded[memberScopeKey(memberScope, guildId)]) {
        void fetchMembers(guildId, memberScope);
      }
    }
    // Only re-run when guildId changes, not when loaded-state objects change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, memberScope]);

  useEffect(() => () => {
    if (memberScope && channelId) cancelMessageFetch(memberScope, channelId);
  }, [memberScope, channelId]);

  // Watching is the stage's (glassStore), not the route's: switching channels
  // keeps a stream playing beside the new conversation (docs/glass-spec.md §6.3).
  useEffect(() => {
    if (channelId && channel) {
      selectChannel(channelId);
    }
  }, [channelId, channel, selectChannel]);

  useEffect(() => {
    if (!channelId || !memberScope) return;
    const context = captureScopedOperation(memberScope);
    createChannelApi(() => context.api).get(channelId)
      .then(({ data }) => { context.assertCurrent(); useChannelStore.getState().updateChannel(data, memberScope); })
      .catch(() => { /* The channel list exposes its request error. */ });
    return () => context.dispose();
  }, [channelId, memberScope]);

  // Listen for custom event to re-show welcome screen from sidebar menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.guildId === guildId) {
        setShowWelcome(true);
      }
    };
    window.addEventListener('paracord:show-welcome', handler);
    return () => window.removeEventListener('paracord:show-welcome', handler);
  }, [guildId]);

  if (isLoading) {
    return <GuildLoadingScreen />;
  }

  if (channelsDenied) {
    return <BuildingNotFound onGoHome={() => navigate('/app')} />;
  }

  if (channelError && guildId) {
    return <ChannelLoadErrorScreen error={channelError} onRetry={() => { void fetchChannels(guildId); }} />;
  }

  if (channelId && !channel) {
    return <ChannelNotFoundScreen guildId={guildId} />;
  }

  const entryChrome = (
    <>
      {showWelcome && currentGuild && (
        <GuildWelcomeScreen
          guild={currentGuild}
          channels={channels}
          onDismiss={dismissWelcome}
        />
      )}
      {!showWelcome && guildId && <GuildOnboardingGate guildId={guildId} />}
    </>
  );

  // Every route that gets here has both ids (`guilds/:guildId/channels/:channelId`).
  if (!guildId || !channelId) return null;

  const subject: ConversationSubject = {
    kind: 'channel',
    guildId,
    guildName: currentGuild?.name,
    channelId,
    channelName,
    topic: channel?.topic,
    isForum,
  };

  // A forum keeps its own body (posts, not a timeline) under the shared header.
  if (isForum) {
    return (
      <ConversationPane
        subject={subject}
        notices={entryChrome}
        timeline={<ForumView channelId={channelId} channelName={channelName} />}
      />
    );
  }

  // A text channel, a thread, or a voice channel's chat: the conversation pane
  // the shell floats on the room, with its header, its timeline in the 720px
  // column and its message box. A voice or stage channel's header carries that
  // channel's pill (join, listen, watch; "Show the call" once you are in), and
  // the call itself is the stage (docs/design/glass-plan.md §8.4: voice channel
  // chat beside the stage; stage channels use the stage look). A stage channel
  // adds its session (topic, moderators, raised hands) over the chat.
  return (
    <TextChannelView
      guildId={guildId}
      channelId={channelId}
      channelName={channelName}
      channel={channel}
      channels={channels}
      subject={subject}
      notices={
        <>
          {channel?.type === ChannelType.Text && (
            <ChannelAmbient guildId={guildId} channelId={channelId} />
          )}
          {isStage && <StageChannelPanel guildId={guildId} channelId={channelId} channelName={channelName} />}
          {entryChrome}
        </>
      }
    />
  );
}
