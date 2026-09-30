import { create } from 'zustand';

import { toast } from '../../../stores/toastStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { voiceErrorMessage } from '../../../stores/voice/errors';
import { useJoinMuteStore } from './muteStore';

/**
 * What the pill's buttons do (docs/design/glass-g6-checkpoint.md, "How to use
 * it, G12"). Every action is a call into `voiceStore` or `glassStore`; the pill
 * holds no media state of its own.
 *
 *   Listen        `listen`. Never opens the microphone and never sends. Pressed
 *                 again it leaves (there is nothing else to stop).
 *   Join          `joinChannel`, which from listening is the in-place upgrade
 *                 (the same connection, no reconnect gap). The mute preference
 *                 goes in first.
 *   Leave         `leaveChannel`. The only way out of a call.
 *   Watch         `glassStore.openStage`. The stage owns the view session: it
 *                 starts the watch when it opens and stops it when it closes,
 *                 so watching never joins and closing never leaves.
 *
 * A refused join or listen does not throw: the store closes the call and sets
 * `connectionError` (and `connectionErrorCode`, for the one refusal the
 * interface acts on). Each action reads that back and says so, out loud.
 */

export interface PillActionTarget {
  serverId: string;
  guildId: string;
  channelId: string;
  /** For the sentence that names a failure. */
  title: string;
}

/**
 * Channels whose listening in a moderator turned off, as far as this device has
 * been told. A refused Listen disables the button for a while, with the
 * server's own sentence; when the window ends a press asks the server again, so
 * a moderator turning it back on is noticed without a reload. The server is
 * always the authority: this only saves a pointless press.
 */
export const LISTEN_BLOCK_MS = 2 * 60_000;

interface ListenBlockState {
  /** `serverId:channelId` -> the server's sentence. */
  blocked: Record<string, string>;
  block: (key: string, reason: string) => void;
  clear: (key: string) => void;
}

const expiry = new Map<string, ReturnType<typeof setTimeout>>();

export const useListenBlockStore = create<ListenBlockState>()((set) => ({
  blocked: {},
  block: (key, reason) => {
    const pending = expiry.get(key);
    if (pending !== undefined) clearTimeout(pending);
    expiry.set(
      key,
      setTimeout(() => {
        expiry.delete(key);
        useListenBlockStore.getState().clear(key);
      }, LISTEN_BLOCK_MS),
    );
    set((state) => ({ blocked: { ...state.blocked, [key]: reason } }));
  },
  clear: (key) => {
    const pending = expiry.get(key);
    if (pending !== undefined) clearTimeout(pending);
    expiry.delete(key);
    set((state) => {
      if (!(key in state.blocked)) return state;
      const { [key]: _gone, ...rest } = state.blocked;
      return { blocked: rest };
    });
  },
}));

export const listenBlockKey = (target: Pick<PillActionTarget, 'serverId' | 'channelId'>) =>
  `${target.serverId}:${target.channelId}`;

/** The server's sentence while listening in is off for this channel, else null. */
export function listenBlockReason(
  blocked: ListenBlockState['blocked'],
  target: Pick<PillActionTarget, 'serverId' | 'channelId'>,
): string | null {
  return blocked[listenBlockKey(target)] ?? null;
}

/**
 * Put the mute preference where `voiceStore` reads it. `selfMute` is false again
 * after every call, and the preference is what the person chose for the next
 * one, so this runs before every listen and every join.
 */
export async function applyJoinMute(): Promise<void> {
  const want = useJoinMuteStore.getState().joinMuted;
  const voice = useVoiceStore.getState();
  if (voice.selfMute !== want) await voice.toggleMute();
}

/** Tell the person why a join or a listen did not happen. Returns true when it failed. */
function reportRefusal(target: PillActionTarget, verb: 'join' | 'listen in to'): boolean {
  const voice = useVoiceStore.getState();
  if (!voice.connectionError || voice.connectionErrorChannelId !== target.channelId) return false;
  if (voice.connectionErrorCode === 'LISTEN_IN_DISABLED') {
    useListenBlockStore.getState().block(listenBlockKey(target), voice.connectionError);
    toast.info(voice.connectionError);
    return true;
  }
  toast.error(`Could not ${verb} ${target.title}: ${voice.connectionError}`);
  return true;
}

/** Listen in, or (while listening) stop. */
export async function toggleListen(target: PillActionTarget, listening: boolean): Promise<void> {
  const voice = useVoiceStore.getState();
  if (listening) {
    await voice.leaveChannel();
    return;
  }
  await applyJoinMute();
  useListenBlockStore.getState().clear(listenBlockKey(target));
  try {
    await useVoiceStore.getState().listen(target.channelId, target.guildId);
  } catch (error) {
    toast.error(`Could not listen in to ${target.title}: ${voiceErrorMessage(error, 'Try again.')}`);
    return;
  }
  reportRefusal(target, 'listen in to');
}

/** Join with the mute preference; from listening, upgrade in place. */
export async function joinCall(target: PillActionTarget): Promise<void> {
  await applyJoinMute();
  try {
    await useVoiceStore.getState().joinChannel(target.channelId, target.guildId);
  } catch (error) {
    const modeError = useVoiceStore.getState().modeError;
    toast.error(`Could not join ${target.title}: ${modeError ?? voiceErrorMessage(error, 'Try again.')}`);
    return;
  }
  reportRefusal(target, 'join');
}

export async function leaveCall(): Promise<void> {
  await useVoiceStore.getState().leaveChannel();
}

/** The microphone button once you have joined. */
export async function toggleMic(): Promise<void> {
  await useVoiceStore.getState().toggleMute();
}

/**
 * The mute circle before you join, and while you listen: the preference the
 * next join applies. While listening the store's `selfMute` is that preference
 * (the engine sends nothing either way), so it follows.
 */
export async function toggleJoinMute(listening: boolean): Promise<void> {
  const next = !useJoinMuteStore.getState().joinMuted;
  useJoinMuteStore.getState().setJoinMuted(next);
  if (listening && useVoiceStore.getState().selfMute !== next) {
    await useVoiceStore.getState().toggleMute();
  }
}

/** Watch: the stage grows out of the pill. It never joins the call. */
export function watchStream(target: Omit<PillActionTarget, 'title'>, streamerId: string): void {
  useGlassStore.getState().openStage({
    serverId: target.serverId,
    guildId: target.guildId,
    channelId: target.channelId,
    streamerId,
  });
}
