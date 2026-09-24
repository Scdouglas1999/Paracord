import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Search, Volume2 } from 'lucide-react';

import { channelApi } from '../../api/channels';
import { apiErrorStatus, extractApiError } from '../../api/client';
import { previewSoundboardSound } from '../../lib/features/soundboard';
import { cn } from '../../lib/utils';
import { useSoundboardStore } from '../../stores/soundboardStore';
import { toast } from '../../stores/toastStore';
import { SoundEmoji } from '../ui/SoundEmoji';
import { StreamOverlayPortal, type AnchoredOverlayCoords } from './streamOverlayPortal';

const SEARCH_THRESHOLD = 12;
/** Hover dwell before a tile previews — scanning the grid shouldn't sound. */
const HOVER_PREVIEW_DELAY_MS = 140;

/**
 * The soundboard popover over the voice control bar: a grid of the server's
 * sounds. Click plays for everyone in the channel (the server's
 * `SOUNDBOARD_PLAY` comes back to us and drives local playback like any other
 * listener's); hovering a tile previews it only for you.
 */
export function SoundboardPopover({
  guildId,
  channelId,
  coords,
  panelRef,
  leaving = false,
}: {
  guildId: string;
  channelId: string;
  coords: AnchoredOverlayCoords | null;
  panelRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Closed, and playing its leave (§5.2): it shrinks back toward the control
   * bar. The host keeps it mounted for the beat with `useLingering`.
   */
  leaving?: boolean;
}) {
  const sounds = useSoundboardStore((s) => s.soundsByGuild.get(guildId));
  const loadSounds = useSoundboardStore((s) => s.loadSounds);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let canceled = false;
    loadSounds(guildId)
      .then(() => {
        if (!canceled) setFailed(false);
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [guildId, loadSounds]);

  useEffect(() => {
    searchRef.current?.focus();
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  const filtered = useMemo(() => {
    const list = sounds ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((sound) => sound.name.toLowerCase().includes(q));
  }, [sounds, search]);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const preview = useCallback(
    (soundId: string) => {
      const sound = (sounds ?? []).find((item) => item.id === soundId);
      if (!sound) return;
      setPreviewingId(soundId);
      void previewSoundboardSound(sound)
        .catch(() => {})
        .finally(() => {
          window.setTimeout(
            () => setPreviewingId((current) => (current === soundId ? null : current)),
            Math.max(300, Math.min(sound.duration_ms, 1500)),
          );
        });
    },
    [sounds],
  );

  const schedulePreview = useCallback(
    (soundId: string) => {
      clearHoverTimer();
      hoverTimer.current = window.setTimeout(() => preview(soundId), HOVER_PREVIEW_DELAY_MS);
    },
    [clearHoverTimer, preview],
  );

  const play = useCallback(
    async (soundId: string) => {
      if (playingId) return; // one in-flight request at a time
      clearHoverTimer();
      setPlayingId(soundId);
      try {
        await channelApi.playSoundboardSound(channelId, soundId);
        // Playback for us arrives with everyone else's via SOUNDBOARD_PLAY.
      } catch (err) {
        const status = apiErrorStatus(err);
        if (status === 429) {
          const retryAfter = (err as { response?: { data?: { retry_after?: number } } })
            .response?.data?.retry_after;
          toast.info(
            retryAfter && retryAfter > 1
              ? `Slow down — the soundboard needs ${retryAfter} more seconds.`
              : 'Slow down — the soundboard needs a moment.',
          );
        } else if (status === 403) {
          toast.error('You need the Use Soundboard permission in this channel.');
        } else {
          toast.error(`Could not play the sound: ${extractApiError(err)}`);
        }
      } finally {
        setPlayingId(null);
      }
    },
    [channelId, clearHoverTimer, playingId],
  );

  return (
    <StreamOverlayPortal
      panelRef={panelRef}
      role="dialog"
      aria-label="Soundboard"
      className={cn(
        'pc-floating w-[min(18.75rem,calc(100vw-1rem))] p-2',
        // A small surface opened from the control bar below it: it grows up
        // out of its bottom edge (§5.2).
        leaving ? 'pc-pop-out' : 'pc-pop-in',
      )}
      style={
        {
          bottom: coords?.bottom ?? 72,
          left: coords?.left ?? 8,
          '--pc-origin': '50% 100%',
        } as React.CSSProperties
      }
    >
      <div className="flex items-center gap-2 px-1.5 pb-2 pt-0.5">
        <AudioLines size={14} className="shrink-0 text-text-faint" aria-hidden />
        <span className="text-section text-text-faint">Soundboard</span>
      </div>

      {(sounds?.length ?? 0) > SEARCH_THRESHOLD && (
        <div className="pc-well mb-2 flex items-center gap-2 px-2.5">
          <Search size={13} className="shrink-0 text-text-faint" aria-hidden />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search sounds"
            aria-label="Search sounds"
            className="h-8 w-full bg-transparent text-label text-text-primary placeholder:text-text-faint focus:outline-none"
          />
        </div>
      )}

      {failed ? (
        <p className="px-1.5 py-3 text-meta text-text-secondary">
          Could not load this server&rsquo;s sounds.
        </p>
      ) : !sounds ? (
        <p className="px-1.5 py-3 text-meta text-text-secondary">Loading sounds…</p>
      ) : filtered.length === 0 ? (
        <p className="px-1.5 py-3 text-meta text-text-secondary">
          {sounds.length === 0
            ? 'This server has no sounds yet.'
            : 'No sounds match that search.'}
        </p>
      ) : (
        <ul className="grid max-h-72 grid-cols-3 gap-1.5 overflow-y-auto" role="listbox" aria-label="Server sounds">
          {filtered.map((sound) => (
            <li key={sound.id}>
              <button
                type="button"
                role="option"
                aria-selected={playingId === sound.id}
                onClick={() => void play(sound.id)}
                onMouseEnter={() => schedulePreview(sound.id)}
                onMouseLeave={() => {
                  clearHoverTimer();
                }}
                onFocus={() => schedulePreview(sound.id)}
                onBlur={clearHoverTimer}
                className={cn(
                  'pc-focusable flex h-[72px] w-full flex-col items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-1.5 text-center',
                  'bg-bg-raised text-text-secondary transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                  'hover:bg-bg-mod-strong hover:text-text-primary active:scale-[0.98]',
                  playingId === sound.id && 'bg-bg-mod-strong text-text-primary',
                )}
              >
                <span className="relative flex h-6 items-center justify-center">
                  <SoundEmoji emoji={sound.emoji} guildId={guildId} size={22} />
                  {previewingId === sound.id && (
                    <Volume2
                      size={11}
                      className="absolute -right-2 -top-1 text-accent-primary"
                      aria-hidden
                    />
                  )}
                </span>
                <span className="w-full truncate text-meta leading-tight">{sound.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </StreamOverlayPortal>
  );
}
