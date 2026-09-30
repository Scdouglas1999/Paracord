import { useMobile } from '../hooks/useMobile';
import { captureScopedOperation } from '../lib/operationContext';
import { useCurrentChannelStore, getAccountChannelView, useGuildChannels } from '../hooks/useChannels';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { entityScopeKey as memberScopeKey } from '../lib/serverScope';
import { useCurrentUser, useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ForumView } from '../components/channel/ForumView';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { cancelMessageFetch } from '../stores/messageStore';
import { useVoiceStore } from '../stores/voiceStore';
import { BuildingNotFound } from '../components/guild/BuildingNotFound';
import { GuildWelcomeScreen } from '../components/guild/GuildWelcomeScreen';
import { GuildOnboardingGate } from '../components/guild/GuildOnboardingGate';
import { createChannelApi } from '../api/channels';
import { usePermissions } from '../hooks/usePermissions';
import { ChannelType, Permissions, hasPermission } from '../types';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../lib/versionedStorage';
import { GuildLoadingScreen, ChannelNotFoundScreen, ChannelLoadErrorScreen } from './guild/GuildStateScreens';
import { VoiceStageChannel } from './guild/VoiceStageChannel';
import { TextChannelView } from './guild/TextChannelView';
import { ChannelAmbient } from '../components/sports/ChannelPin';
import { ConversationPane, type ConversationSubject } from '../components/glass/conversation';
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
  const currentUserId = useCurrentUser()?.id ?? null;
  const setWatchedStreamer = useVoiceStore((s) => s.setWatchedStreamer);

  const isPhoneLayout = useMobile();

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

  const { permissions, isAdmin: isGuildAdmin } = usePermissions(guildId || null);

  const channelName = channel?.name || 'Unknown channel';
  const isVoice = channel?.type === 2;
  const isStage = channel?.type === 13 || channel?.channel_type === 13;
  const isVoiceLike = isVoice || isStage;
  const isForum = channel?.type === 7 || channel?.channel_type === 7;
  const canManageStage = Boolean(
    guildId && (isGuildAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS)),
  );

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

  const prevChannelIdRef = useRef<string | undefined>(channelId);

  useEffect(() => {
    const prevChannelId = prevChannelIdRef.current;
    prevChannelIdRef.current = channelId;

    if (prevChannelId && prevChannelId !== channelId) {
      // Only drop a watched stream when the user actually switches channels.
      // Clearing on the initial mount would stomp a RoomCard "Watch" handoff,
      // which sets voiceStore.watchedStreamerId *before* navigating here.
      setWatchedStreamer(null);
    }

    if (channelId && channel) {
      selectChannel(channelId);
    }
  }, [channelId, channel, selectChannel, setWatchedStreamer]);

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

  /* The Stage carries its own header (spec §7.2: room name, building and
     duration, the here-now strip, Invite / Layout / more), so it is not a
     conversation and keeps its own page inside the conversation pane until
     the Glass stage (WP-G14) takes the voice route over. */
  if (isVoiceLike) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {entryChrome}
        <VoiceStageChannel
          guildId={guildId}
          channelId={channelId}
          channelName={channelName}
          isStage={isStage}
          canManageStage={canManageStage}
          currentUserId={currentUserId}
          isPhoneLayout={isPhoneLayout}
        />
      </div>
    );
  }

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

  // A text channel or a thread: the conversation pane the shell floats on the
  // room, with its header, its timeline in the 720px column and its message box.
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
          {entryChrome}
        </>
      }
    />
  );
}
