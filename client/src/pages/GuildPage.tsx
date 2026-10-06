import { captureScopedOperation } from '../lib/operationContext';
import { useCurrentChannelStore, getAccountChannelView, useGuildChannels } from '../hooks/useChannels';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { entityScopeKey as memberScopeKey } from '../lib/serverScope';
import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { cancelMessageFetch } from '../stores/messageStore';
import { BuildingNotFound } from '../components/guild/BuildingNotFound';
import { ServerSignedOutPage } from '../components/ix/session/ServerSignedOutPage';
import { useGuildServerState } from '../hooks/useGuildServerState';
import { GuildOnboardingGate } from '../components/guild/GuildOnboardingGate';
import { createChannelApi } from '../api/channels';
import { ChannelType } from '../types';
import { GuildLoadingScreen, ChannelNotFoundScreen, ChannelLoadErrorScreen } from './guild/GuildStateScreens';
import { TextChannelView } from './guild/TextChannelView';
import { ChannelAmbient } from '../components/sports/ChannelPin';
import { ForumPage } from '../components/ix/conversation/ForumPage';
import type { ConversationSubject } from '../components/ix/conversation';
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

  const guilds = useCurrentGuilds();
  const currentGuild = guilds.find((g) => g.id === guildId);
  const guildServer = useGuildServerState(guildId);
  // "Pick roles" in the joiner welcome brings the onboarding page back: a new key mounts the gate
  // afresh (it asks the server again and is no longer put away).
  const [gateRun, setGateRun] = useState(0);

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
    // A server whose connection dropped while its account is still shown has no client to
    // capture; this refresh is only a refinement of the list's own, so it simply waits.
    let context: ReturnType<typeof captureScopedOperation>;
    try {
      context = captureScopedOperation(memberScope);
    } catch {
      return;
    }
    createChannelApi(() => context.api).get(channelId)
      .then(({ data }) => { context.assertCurrent(); useChannelStore.getState().updateChannel(data, memberScope); })
      .catch(() => { /* The channel list exposes its request error. */ });
    return () => context.dispose();
  }, [channelId, memberScope]);

  // A place on a saved server that is not connected yet is waited for (or, signed out, asked
  // to sign in), never reported gone: its channels are simply not here yet.
  if (!currentGuild && guildServer && guildServer.state?.phase !== 'connected') {
    return guildServer.state?.phase === 'signed-out' ? <ServerSignedOutPage server={guildServer.server} /> : <GuildLoadingScreen />;
  }

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

  // The server's onboarding (rules, roles) is a page over main; the welcome is the conversation's own
  // (`IxConversation`: the empty channel's cards, or the joiner card above the message box).
  const entryChrome = guildId ? <GuildOnboardingGate key={gateRun} guildId={guildId} /> : null;

  // Every route that gets here has both ids (`guilds/:guildId/channels/:channelId`).
  if (!guildId || !channelId) return null;

  const subject: ConversationSubject = {
    kind: 'channel',
    guildId,
    guildName: currentGuild?.name,
    channelId,
    channelName,
    topic: channel?.topic,
  };

  // A forum keeps its own body (posts, not a timeline) under the shared large title.
  if (isForum) {
    return (
      <>
        <ForumPage subject={subject} />
        {entryChrome}
      </>
    );
  }

  // A text channel, a thread, or a voice channel's chat: the Index conversation (docs/index-spec.md
  // §4.11, §8.1). A pinned score and a stage channel's session sit under the large title; the
  // onboarding page covers main on its own. Joining a voice channel never navigates: its call is
  // the card and the call view.
  const hasNotices = channel?.type === ChannelType.Text || isStage;
  return (
    <>
      <TextChannelView
        guildId={guildId}
        channelId={channelId}
        channelName={channelName}
        channel={channel}
        channels={channels}
        subject={subject}
        onPickRoles={() => setGateRun((run) => run + 1)}
        notices={
          hasNotices ? (
            <>
              {channel?.type === ChannelType.Text && <ChannelAmbient guildId={guildId} channelId={channelId} />}
              {isStage && <StageChannelPanel guildId={guildId} channelId={channelId} channelName={channelName} />}
            </>
          ) : undefined
        }
      />
      {entryChrome}
    </>
  );
}
