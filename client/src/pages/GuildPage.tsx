import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { TopBar } from '../components/layout/TopBar';
import { ForumView } from '../components/channel/ForumView';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { cancelMessageFetch } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { GuildWelcomeScreen } from '../components/guild/GuildWelcomeScreen';
import { GuildOnboardingGate } from '../components/guild/GuildOnboardingGate';
import { channelApi } from '../api/channels';
import { usePermissions } from '../hooks/usePermissions';
import { Permissions, hasPermission } from '../types';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../lib/versionedStorage';
import { GuildLoadingScreen, ChannelNotFoundScreen } from './guild/GuildStateScreens';
import { VoiceStageChannel } from './guild/VoiceStageChannel';
import { TextChannelView } from './guild/TextChannelView';

export function GuildPage() {
  const { guildId, channelId } = useParams();
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const channels = useChannelStore((s) => s.channels);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const isLoading = useChannelStore((s) =>
    guildId ? (s.isLoading && !(s.channelsByGuild[guildId]?.length > 0)) : false
  );
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const channel = channels.find((c) => c.id === channelId);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const setWatchedStreamer = useVoiceStore((s) => s.setWatchedStreamer);

  const [isPhoneLayout, setIsPhoneLayout] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });

  // Welcome screen state
  const guilds = useGuildStore((s) => s.guilds);
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

  const channelName = channel?.name || 'Unknown Channel';
  const isVoice = channel?.type === 2;
  const isStage = channel?.type === 13 || channel?.channel_type === 13;
  const isVoiceLike = isVoice || isStage;
  const isForum = channel?.type === 7 || channel?.channel_type === 7;
  const canManageStage = Boolean(
    guildId && (isGuildAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS)),
  );

  // Fetch channels when guildId changes
  useEffect(() => {
    if (guildId) {
      selectGuild(guildId);
      useChannelStore.getState().selectGuild(guildId);
      if (!useChannelStore.getState().guildChannelsLoaded[guildId]) {
        fetchChannels(guildId);
      }
      if (!useMemberStore.getState().membersLoaded[guildId]) {
        void fetchMembers(guildId);
      }
    }
    // Only re-run when guildId changes, not when loaded-state objects change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  const prevChannelIdRef = useRef<string | undefined>(channelId);

  useEffect(() => {
    const prevChannelId = prevChannelIdRef.current;
    prevChannelIdRef.current = channelId;

    if (prevChannelId && prevChannelId !== channelId) {
      cancelMessageFetch(prevChannelId);
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
    if (!channelId) return;
    channelApi
      .get(channelId)
      .then(({ data }) => {
        useChannelStore.getState().updateChannel(data);
      })
      .catch(() => {
        /* keep existing channel cache on failure */
      });
  }, [channelId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const updateIsPhoneLayout = () => setIsPhoneLayout(mediaQuery.matches);
    updateIsPhoneLayout();
    mediaQuery.addEventListener('change', updateIsPhoneLayout);
    return () => mediaQuery.removeEventListener('change', updateIsPhoneLayout);
  }, []);

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

  if (channelId && !channel) {
    return <ChannelNotFoundScreen guildId={guildId} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        channelName={channelName}
        channelTopic={channel?.topic}
        isVoice={isVoiceLike}
        isForum={isForum}
        guildId={guildId}
        guildName={currentGuild?.name}
      />

      {showWelcome && currentGuild && (
        <GuildWelcomeScreen
          guild={currentGuild}
          channels={channels}
          onDismiss={dismissWelcome}
        />
      )}
      {!showWelcome && guildId && <GuildOnboardingGate guildId={guildId} />}
      {isVoiceLike ? (
        <VoiceStageChannel
          guildId={guildId}
          channelId={channelId}
          channelName={channelName}
          isStage={isStage}
          canManageStage={canManageStage}
          currentUserId={currentUserId}
          isPhoneLayout={isPhoneLayout}
        />
      ) : isForum ? (
        <ForumView channelId={channelId!} channelName={channelName} />
      ) : (
        <TextChannelView
          guildId={guildId}
          channelId={channelId!}
          channelName={channelName}
          channel={channel}
          channels={channels}
        />
      )}
    </div>
  );
}
