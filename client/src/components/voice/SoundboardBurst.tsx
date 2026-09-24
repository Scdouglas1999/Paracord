import { useEffect, useReducer } from 'react';

import { SOUNDBOARD_MARK_TTL_MS, useSoundboardStore } from '../../stores/soundboardStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { SoundEmoji } from '../ui/SoundEmoji';

/**
 * The ripple on a voice tile when its owner plays a soundboard sound: the
 * sound's emoji pops in and lifts while a ring breathes out of the tile's edge.
 * Everyone in the call sees it — including a deafened listener, who hears
 * nothing but still sees who played what.
 */
export function SoundboardBurst({ userId }: { userId: string }) {
  const channelId = useVoiceStore((s) => s.channelId);
  const mark = useSoundboardStore((s) =>
    s.recentPlays.find(
      (play) =>
        play.userId === userId &&
        play.channelId === channelId &&
        Date.now() - play.at < SOUNDBOARD_MARK_TTL_MS,
    ),
  );
  const guildId = useVoiceStore((s) => s.guildId);
  const [, force] = useReducer((tick: number) => tick + 1, 0);

  // Re-render when the mark ages out so it clears on its own.
  useEffect(() => {
    if (!mark) return;
    const remaining = SOUNDBOARD_MARK_TTL_MS - (Date.now() - mark.at);
    if (remaining <= 0) return;
    const timer = window.setTimeout(force, remaining);
    return () => window.clearTimeout(timer);
  }, [mark, mark?.key, mark?.at]);

  if (!mark) return null;
  return (
    <div
      key={mark.key}
      className="pc-soundboard-burst z-10"
      role="status"
      aria-label={`played ${mark.soundName}`}
    >
      <SoundEmoji emoji={mark.emoji} guildId={guildId ?? ''} size={30} className="pc-soundboard-burst-emoji" />
    </div>
  );
}
