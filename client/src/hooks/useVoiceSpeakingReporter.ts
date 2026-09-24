import { useEffect } from 'react';

import { connectionManager } from '../lib/connectionManager';
import { SpeakingEdges } from '../lib/voice/speakingEdges';
import type { AccountScope } from '../lib/serverScope';
import type { VoiceState } from '../types';
import { useVoiceStore } from '../stores/voiceStore';

/** The server voice channel this client reports speaking in. */
export interface SpeakingTarget {
  serverId: string;
  guildId: string;
  channelId: string;
}

export interface SpeakingReportInput {
  target: SpeakingTarget | null;
  /** The local speaking flag, false whenever muted in any way. */
  speaking: boolean;
  muted: boolean;
}

/** The slice of the voice store the reporter reads. */
export interface SpeakingReportSource {
  connected: boolean;
  callScope: AccountScope | null;
  guildId: string | null;
  channelId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  participants: ReadonlyMap<string, VoiceState>;
  speakingUsers: ReadonlySet<string>;
}

/**
 * What to report, from the voice store: only a connected call in a server
 * voice channel (a DM call has nobody outside it to tell), and never while
 * self-muted, deafened, server-muted or suppressed on a stage.
 */
export function speakingReportInput(state: SpeakingReportSource): SpeakingReportInput {
  const { callScope, guildId, channelId } = state;
  const target =
    state.connected && callScope && guildId && guildId !== 'dm' && channelId
      ? { serverId: callScope.serverId, guildId, channelId }
      : null;
  const selfId = callScope?.userId ?? null;
  const self = selfId ? state.participants.get(selfId) : undefined;
  const muted = state.selfMute || state.selfDeaf || Boolean(self?.mute) || Boolean(self?.suppress);
  const speaking = Boolean(target && selfId && !muted && state.speakingUsers.has(selfId));
  return { target, speaking, muted };
}

function sameTarget(a: SpeakingTarget | null, b: SpeakingTarget | null): boolean {
  return a === b || (!!a && !!b && a.serverId === b.serverId && a.guildId === b.guildId && a.channelId === b.channelId);
}

/**
 * Report this client's own speaking edges in its server voice channel, so the
 * people outside the call see who is talking (the server home's Live now card
 * and the sidebar's voice rows). Mounted once for the whole app.
 */
export function useVoiceSpeakingReporter(): void {
  useEffect(() => {
    let target: SpeakingTarget | null = null;
    let edges: SpeakingEdges | null = null;

    const retarget = (next: SpeakingTarget | null) => {
      // Leaving or switching calls: the old channel hears "stopped" at once.
      // The server clears a leaver itself too; this covers a switch that
      // outruns the voice state update.
      if (edges?.reporting && target) {
        connectionManager.updateVoiceSpeaking(target.serverId, target.channelId, false);
      }
      edges?.dispose();
      edges = null;
      target = next;
      if (next) {
        edges = new SpeakingEdges((speaking) =>
          connectionManager.updateVoiceSpeaking(next.serverId, next.channelId, speaking),
        );
      }
    };

    const apply = (state: SpeakingReportSource) => {
      const input = speakingReportInput(state);
      if (!sameTarget(input.target, target)) retarget(input.target);
      if (!edges) return;
      if (input.muted) edges.stopNow();
      else edges.update(input.speaking);
    };

    apply(useVoiceStore.getState());
    const unsubscribe = useVoiceStore.subscribe((state) => apply(state));
    return () => {
      unsubscribe();
      retarget(null);
    };
  }, []);
}
