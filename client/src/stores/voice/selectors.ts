import type { VoiceState } from '../../types';

/**
 * Reading the Glass fields of a voice state (docs/glass-spec.md §5, §6, §7):
 * who is listening in, and how long a stream has been live. Every value comes
 * from the server (`mode`, `self_stream_started_at`); nothing is inferred
 * from what this client happened to observe.
 */

/** "Listening in" on the roster. */
export function isListeningIn(state: Pick<VoiceState, 'mode'> | null | undefined): boolean {
  return state?.mode === 'listen';
}

/** When this member's stream started (ms since epoch), or null when not streaming. */
export function streamStartedAt(
  state: Pick<VoiceState, 'self_stream' | 'self_stream_started_at'> | null | undefined,
): number | null {
  if (!state?.self_stream || !state.self_stream_started_at) return null;
  const at = Date.parse(state.self_stream_started_at);
  return Number.isFinite(at) ? at : null;
}

/** Whole minutes a stream has been live at `nowMs` ("LIVE 42 MIN"), or null. */
export function liveMinutes(
  state: Pick<VoiceState, 'self_stream' | 'self_stream_started_at'> | null | undefined,
  nowMs: number,
): number | null {
  const started = streamStartedAt(state);
  if (started === null) return null;
  return Math.max(0, Math.floor((nowMs - started) / 60_000));
}

/** The members of `members` who are listening in, in roster order. */
export function listenersOf(members: readonly VoiceState[] | undefined): VoiceState[] {
  return (members ?? []).filter((member) => member.mode === 'listen');
}
