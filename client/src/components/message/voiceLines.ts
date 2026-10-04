import { create } from 'zustand';

import { useVoiceStore } from '../../stores/voiceStore';

/**
 * "You joined General" (docs/index-spec.md §4.11, §5.7): a system line for
 * your OWN joins and leaves of a server's voice channel, so a busy voice
 * channel never floods the conversation with everybody else's comings and
 * goings.
 *
 * The server writes no message for a voice join, so these are this client's
 * observations, like the prototype's: kept for the session, never sent, never
 * counted as unread, never in the message store. The timeline draws a line in
 * the voice channel's own conversation and in its server's first text channel
 * (the prototype's general), at the moment it happened, among the messages.
 *
 * One recorder for the whole app, started by the first timeline that mounts
 * (`startVoiceLines`): a join made while another place is on screen is still
 * there when you open the channel.
 */

export interface VoiceLine {
  /** Unique for the session; the row's key. */
  id: string;
  kind: 'joined' | 'left';
  guildId: string;
  /** The voice channel. */
  channelId: string;
  /** RFC 3339, when it happened. */
  at: string;
}

/** Older lines than this many are forgotten (a session is not an archive). */
const MAX_LINES = 60;

interface VoiceLineState {
  lines: VoiceLine[];
  add: (line: Omit<VoiceLine, 'id'>) => void;
  reset: () => void;
}

let sequence = 0;

export const useVoiceLineStore = create<VoiceLineState>()((set) => ({
  lines: [],
  add: (line) =>
    set((state) => ({
      lines: [...state.lines, { ...line, id: `voice:${++sequence}` }].slice(-MAX_LINES),
    })),
  reset: () => set({ lines: [] }),
}));

interface Seat {
  channelId: string;
  guildId: string;
}

/** Where this client sits right now: joined (not listening) to a server's voice channel. */
function seatOf(state: ReturnType<typeof useVoiceStore.getState>): Seat | null {
  // A DM call is not a server's voice channel: the server writes its own line for it.
  if (!state.connected || !state.channelId || !state.guildId || state.guildId === 'dm') return null;
  if (state.callMode !== 'joined') return null;
  return { channelId: state.channelId, guildId: state.guildId };
}

let stop: (() => void) | null = null;

/** Start recording your own joins and leaves (idempotent; never stops while the app runs). */
export function startVoiceLines(): void {
  if (stop) return;
  let seat = seatOf(useVoiceStore.getState());
  stop = useVoiceStore.subscribe((state) => {
    const next = seatOf(state);
    if (next?.channelId === seat?.channelId) return;
    const at = new Date().toISOString();
    const { add } = useVoiceLineStore.getState();
    if (seat) add({ kind: 'left', guildId: seat.guildId, channelId: seat.channelId, at });
    if (next) add({ kind: 'joined', guildId: next.guildId, channelId: next.channelId, at });
    seat = next;
  });
}

/** Tests only: forget the recorder and every line. */
export function resetVoiceLinesForTests(): void {
  stop?.();
  stop = null;
  sequence = 0;
  useVoiceLineStore.getState().reset();
}

/** The sentence a line stands for. */
export function voiceLineText(line: Pick<VoiceLine, 'kind'>, channelName: string): string {
  return line.kind === 'joined' ? `You joined ${channelName}` : `You left ${channelName}`;
}
