import { ToggleRow } from '../../ui';
import { useJoinMuteStore } from '../../glass/pill/muteStore';

/**
 * Settings › Voice & video › Join calls muted (docs/index-spec.md §8.5, §13
 * default 16): the pill's pre-join mute preference, now a setting. The card's
 * Join and Listen apply it (`pillActions.applyJoinMute`); a call's own mic
 * control never writes it.
 */
export function JoinMutedSetting({ className }: { className?: string }) {
  const joinMuted = useJoinMuteStore((state) => state.joinMuted);
  const setJoinMuted = useJoinMuteStore((state) => state.setJoinMuted);
  return (
    <ToggleRow
      label="Join calls muted"
      description="Your microphone starts off when you join a call. Unmute from the call’s card or the call."
      checked={joinMuted}
      onChange={setJoinMuted}
      className={className}
    />
  );
}
