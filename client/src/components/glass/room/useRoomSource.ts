import { useEffect, useMemo } from 'react';

import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { useGuild } from '../../../hooks/useGuilds';
import { useAuthenticatedImage } from '../../../lib/authenticatedImage';
import { resolveGuildIconUrl } from '../../../lib/guildIcon';
import { roomFixtureRequested } from '../../../lib/room/devFixture';
import { isTauri } from '../../../lib/tauriEnv';
import {
  ambientTargetFor,
  chooseRoomSource,
  pickRoomStream,
  type RoomSourceSpec,
} from '../../../lib/room/sources';
import { entityScopeKey } from '../../../lib/serverScope';
import { resolveBannerUrl } from '../../../lib/userAvatar';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType } from '../../../types';

const NO_CHANNELS: readonly { id: string; type: ChannelType }[] = [];

/**
 * A URL `<img>` can load as it is (the same rule `useAuthenticatedImage`
 * applies). For those the room takes the URL itself: the hook hands back the
 * previous value for one render after a change, and a room that saw "no
 * banner" for that render would start fading out before the next one came in.
 */
function loadableAsIs(src: string | null): boolean {
  return !src || src.startsWith('data:') || src.startsWith('blob:') || !isTauri();
}

/**
 * What lights the room for the route's server (docs/glass-spec.md §4), and the
 * ambient view that goes with it.
 *
 * The room owns the client's one ambient view: it asks for the current
 * server's busiest live stream, and stops it on Home and DMs, in a server with
 * nothing live, and when the backdrop unmounts. (While the window is hidden or
 * another server is current, WP-G6 closes the view itself and reopens it when
 * that changes back.)
 */
export function useRoomSource(guildId: string | null): RoomSourceSpec {
  const scope = useCurrentAccountScope();
  const selfUserId = useCurrentUser()?.id ?? null;
  const guild = useGuild(guildId);
  const channels = useChannelStore((state) =>
    guildId && scope ? state.channelsByGuild[entityScopeKey(scope, guildId)] ?? NO_CHANNELS : NO_CHANNELS,
  );
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const stage = useGlassStore((state) => state.stage);

  const voiceChannelIds = useMemo(
    () =>
      channels
        .filter((channel) => channel.type === ChannelType.Voice || channel.type === ChannelType.Stage)
        .map((channel) => channel.id),
    [channels],
  );

  const stream = useMemo(
    () =>
      guildId
        ? pickRoomStream({ guildId, voiceChannelIds, channelParticipants, selfUserId })
        : null,
    [guildId, voiceChannelIds, channelParticipants, selfUserId],
  );

  // In a browser a banner path is loadable only with the download ticket:
  // subscribing re-resolves it once the ticket is minted.
  useDownloadTicket();
  const bannerSrc = resolveBannerUrl(guild?.banner_hash ?? null);
  const iconSrc = guild ? resolveGuildIconUrl(guild) : null;
  const bannerResolved = useAuthenticatedImage(bannerSrc);
  const iconResolved = useAuthenticatedImage(iconSrc);
  const bannerUrl = loadableAsIs(bannerSrc) ? bannerSrc : bannerResolved;
  const iconUrl = loadableAsIs(iconSrc) ? iconSrc : iconResolved;

  const stageTarget =
    stage.mode !== 'none' && stage.serverId && stage.guildId && stage.channelId && stage.streamerId
      ? { serverId: stage.serverId, guildId: stage.guildId, channelId: stage.channelId, streamerId: stage.streamerId }
      : null;
  const stageKey = stageTarget
    ? `${stageTarget.serverId}:${stageTarget.guildId}:${stageTarget.channelId}:${stageTarget.streamerId}`
    : null;

  const serverId = scope?.serverId ?? null;
  const bannerDeclared = Boolean(guild?.banner_hash);
  const streamKey = stream ? `${stream.channelId}:${stream.streamerId}` : null;
  const spec = useMemo(
    () =>
      chooseRoomSource({
        serverId,
        guildId,
        stage: stageTarget,
        stream,
        bannerUrl,
        iconUrl,
        bannerDeclared,
      }),
    // The objects are rebuilt on every voice update; their identities are the keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverId, guildId, stageKey, streamKey, bannerUrl, iconUrl, bannerDeclared],
  );

  // The ambient view: requested for the current server's busiest stream, and
  // stopped everywhere else. Its identity is its key; the same target again
  // is a no-op in the store as well.
  const ambient = ambientTargetFor({ serverId, guildId, stream });
  const ambientKey = ambient ? `${ambient.serverId}:${ambient.guildId}:${ambient.channelId}:${ambient.streamerId}` : null;
  useEffect(() => {
    // The review harness lights the room from its fixture: no media stack runs.
    if (roomFixtureRequested()) return;
    const { startAmbient, stopAmbient } = useVoiceStore.getState();
    if (!ambient) {
      stopAmbient();
      return;
    }
    try {
      startAmbient(ambient);
    } catch (error) {
      console.error('[room] the ambient view could not be requested; the room waits', {
        target: ambient,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Keyed on the target's identity, not the object rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambientKey]);

  useEffect(
    () => () => {
      if (!roomFixtureRequested()) useVoiceStore.getState().stopAmbient();
    },
    [],
  );

  return spec;
}
