import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The mute preference on the call pill (docs/glass-spec.md §5: "mute preference
 * (36px glass circle, mic or mic-slash; default muted)").
 *
 * It answers one question before you are in a call: does the microphone start
 * open or closed when you join? The default is closed. The preference belongs to
 * this device, not to a call: leaving a call never changes it, and a call's own
 * mic toggle (the microphone button once you have joined) never writes it.
 *
 * `voiceStore.selfMute` carries the preference into a call: `startCall` reads it
 * when it begins, and the in-place upgrade from listening applies it. It is set
 * back to false whenever a call ends, so the pill puts the preference back into
 * the store before every listen and every join (`applyJoinMute`).
 */
interface JoinMuteState {
  /** Join with the microphone closed. */
  joinMuted: boolean;
  setJoinMuted: (muted: boolean) => void;
}

export const useJoinMuteStore = create<JoinMuteState>()(
  persist(
    (set) => ({
      joinMuted: true,
      setJoinMuted: (joinMuted) => set({ joinMuted }),
    }),
    {
      name: 'paracord:glass:join-muted',
      version: 1,
      partialize: (state) => ({ joinMuted: state.joinMuted }),
    },
  ),
);
