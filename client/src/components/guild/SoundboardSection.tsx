import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Play, Square, Upload } from 'lucide-react';

import { guildApi, type SoundboardSound } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { confirm } from '../../stores/confirmStore';
import { Button, EmptyState, Input } from '../ui';
import { EmojiPicker } from '../ui/EmojiPicker';
import { SoundEmoji } from '../ui/SoundEmoji';
import {
  SOUNDBOARD_EXTENSIONS,
  SOUNDBOARD_MAX_BYTES,
  SOUNDBOARD_MAX_NAME,
  SOUNDBOARD_MAX_PER_GUILD,
  SOUNDBOARD_MAX_SECONDS,
  SOUNDBOARD_MIME_TYPES,
  SOUNDBOARD_MIN_NAME,
  previewSoundboardSound,
} from '../../lib/features/soundboard';
import { toast } from '../../stores/toastStore';
import { GateNotice, GroupLabel, SectionHeader } from './SettingsPrimitives';

interface SoundboardSectionProps {
  guildId: string;
  canManage: boolean;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Server settings → Soundboard: the Stickers section's layout, for sounds. */
export function SoundboardSection({ guildId, canManage }: SoundboardSectionProps) {
  const [sounds, setSounds] = useState<SoundboardSound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [volume, setVolume] = useState(100);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiTarget, setEmojiTarget] = useState<'new' | string>('new');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputLabelRef = useRef<HTMLLabelElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await guildApi.listSounds(guildId);
      setSounds(data);
      setError(null);
    } catch (err) {
      setError(`Could not load sounds: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the list live while the section is open — another manager's upload or
  // delete lands through the gateway.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ guild_id?: string }>).detail;
      if (detail?.guild_id && String(detail.guild_id) !== String(guildId)) return;
      void load();
    };
    window.addEventListener('paracord:sounds-changed', handler);
    return () => window.removeEventListener('paracord:sounds-changed', handler);
  }, [guildId, load]);

  const full = sounds.length >= SOUNDBOARD_MAX_PER_GUILD;

  const chooseFile = (next: File | null) => {
    if (!next) {
      setFile(null);
      return;
    }
    const looksAudio =
      SOUNDBOARD_MIME_TYPES.includes(next.type) || SOUNDBOARD_EXTENSIONS.test(next.name);
    if (!looksAudio) {
      setError('Sounds must be MP3, OGG, WAV, or M4A.');
      setFile(null);
      return;
    }
    if (next.size > SOUNDBOARD_MAX_BYTES || next.size === 0) {
      setError('Sound files must be between 1 byte and 1 MB.');
      setFile(null);
      return;
    }
    setError(null);
    setFile(next);
    if (!name.trim()) {
      setName(next.name.replace(/\.[^.]+$/, '').slice(0, SOUNDBOARD_MAX_NAME));
    }
  };

  const upload = async () => {
    const trimmed = name.trim();
    if (!file || !trimmed || uploading || full) return;
    if (trimmed.length < SOUNDBOARD_MIN_NAME || trimmed.length > SOUNDBOARD_MAX_NAME) {
      setError(`Sound name must be ${SOUNDBOARD_MIN_NAME}-${SOUNDBOARD_MAX_NAME} characters.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const { data } = await guildApi.createSound(guildId, {
        name: trimmed,
        emoji: emoji ?? undefined,
        volume,
        file,
      });
      setSounds((prev) => [data, ...prev]);
      setName('');
      setEmoji(null);
      setVolume(100);
      setFile(null);
    } catch (err) {
      setError(`Could not upload the sound: ${extractApiError(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const saveEdit = async (soundId: string) => {
    if (!editName.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await guildApi.updateSound(guildId, soundId, { name: editName.trim() });
      setSounds((prev) => prev.map((sound) => (sound.id === soundId ? data : sound)));
      setEditingId(null);
    } catch (err) {
      setError(`Could not save the sound: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const setSoundVolume = async (sound: SoundboardSound, next: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(next)));
    setSounds((prev) =>
      prev.map((item) => (item.id === sound.id ? { ...item, volume: clamped } : item)),
    );
    try {
      await guildApi.updateSound(guildId, sound.id, { volume: clamped });
    } catch (err) {
      setSounds((prev) => prev.map((item) => (item.id === sound.id ? sound : item)));
      setError(`Could not save the volume: ${extractApiError(err)}`);
    }
  };

  const setSoundEmoji = async (sound: SoundboardSound, next: string | null) => {
    try {
      const { data } = await guildApi.updateSound(guildId, sound.id, { emoji: next ?? '' });
      setSounds((prev) => prev.map((item) => (item.id === sound.id ? data : item)));
    } catch (err) {
      setError(`Could not save the emoji: ${extractApiError(err)}`);
    }
  };

  const remove = async (sound: SoundboardSound) => {
    const ok = await confirm({
      title: `Delete ${sound.name}?`,
      description: 'It is removed from the server and can no longer be played.',
      confirmLabel: 'Delete sound',
      variant: 'danger',
    });
    if (!ok) return;
    setError(null);
    try {
      await guildApi.deleteSound(guildId, sound.id);
      setSounds((prev) => prev.filter((item) => item.id !== sound.id));
    } catch (err) {
      setError(`Could not delete ${sound.name}: ${extractApiError(err)}`);
    }
  };

  const preview = async (sound: SoundboardSound) => {
    if (previewingId === sound.id) return;
    setPreviewingId(sound.id);
    try {
      await previewSoundboardSound(sound);
    } catch (err) {
      toast.error(`Could not play the preview: ${extractApiError(err)}`);
    } finally {
      // Keep the mark up for the clip's length so a replay click is visible.
      window.setTimeout(
        () => setPreviewingId((current) => (current === sound.id ? null : current)),
        Math.max(400, Math.min(sound.duration_ms, 2000)),
      );
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="Soundboard"
        description="Short sounds anyone in a voice channel can play for everyone in it."
      />

      {!canManage && (
        <GateNotice>You can view server sounds, but the Manage Emojis permission is needed to add, edit, or delete them.</GateNotice>
      )}

      {error && <p role="alert" className="text-body text-accent-danger">{error}</p>}

      {canManage && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Add a sound</GroupLabel>
          <div className="mt-4 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <div className="relative">
              <button
                type="button"
                aria-label="Choose an emoji for the sound"
                onClick={() => { setEmojiTarget('new'); setShowEmojiPicker((v) => !v); }}
                className="pc-well pc-focusable flex h-[var(--h-control-phone)] w-[var(--h-control-phone)] items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
              >
                <SoundEmoji emoji={emoji} guildId={guildId} size={22} />
              </button>
              {showEmojiPicker && emojiTarget === 'new' && (
                <div className="absolute left-0 top-full z-50 mt-2 max-w-[90vw]">
                  <Suspense fallback={null}>
                    <EmojiPicker
                      guildId={guildId}
                      onSelect={(picked) => { setEmoji(picked); setShowEmojiPicker(false); }}
                      onClose={() => setShowEmojiPicker(false)}
                    />
                  </Suspense>
                </div>
              )}
            </div>
            <Input
              ref={nameInputRef}
              aria-label="Sound name"
              placeholder={`Name (${SOUNDBOARD_MIN_NAME}–${SOUNDBOARD_MAX_NAME} characters)`}
              value={name}
              maxLength={SOUNDBOARD_MAX_NAME}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label
              ref={fileInputLabelRef}
              className="pc-well inline-flex h-[var(--h-control-phone)] min-w-0 cursor-pointer items-center justify-center px-3.5 text-label text-text-secondary transition-colors hover:text-text-primary focus-within:shadow-[var(--shadow-well),var(--focus-ring)]"
            >
              <input
                type="file"
                accept={[...SOUNDBOARD_MIME_TYPES, '.mp3', '.ogg', '.wav', '.m4a'].join(',')}
                aria-label="Sound file"
                className="sr-only"
                onChange={(event) => {
                  chooseFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
              <span className="truncate">{file ? file.name : 'Choose MP3, OGG, WAV, or M4A · 1 MB · 5 s'}</span>
            </label>
            <Button
              onClick={() => void upload()}
              loading={uploading}
              disabled={!name.trim() || !file || full || uploading}
              className="h-[var(--h-control-phone)]"
            >
              <Upload size={15} aria-hidden />
              Upload
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label htmlFor="sound-upload-volume" className="text-label text-text-secondary">
              Volume
            </label>
            <input
              id="sound-upload-volume"
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              className="h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-bg-mod-strong accent-accent-primary [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-primary"
            />
            <span className="pc-mono w-10 text-meta text-text-muted">{volume}%</span>
          </div>
          <p className="mt-3 max-w-prose text-meta leading-relaxed text-text-muted">
            {full
              ? `This server has all ${SOUNDBOARD_MAX_PER_GUILD} sounds it can hold. Delete one to add another.`
              : `Up to ${SOUNDBOARD_MAX_PER_GUILD} sounds per server, 1 MB and ${SOUNDBOARD_MAX_SECONDS} seconds each.`}
          </p>
        </section>
      )}

      <section className="border-t border-border-subtle pt-6">
        <div className="flex items-baseline justify-between gap-3">
          <GroupLabel>Server sounds</GroupLabel>
          <span className="pc-mono text-meta text-text-muted">{sounds.length} of {SOUNDBOARD_MAX_PER_GUILD}</span>
        </div>
        {loading ? (
          <p className="mt-4 text-body text-text-secondary">Loading sounds…</p>
        ) : sounds.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<AudioLines size={20} />}
            title="No sounds yet"
            description="Upload an MP3, OGG, WAV, or M4A and anyone in a voice channel can play it for everyone."
            action={
              canManage ? (
                <Button variant="ghost" onClick={() => fileInputLabelRef.current?.click()}>
                  <Upload size={14} aria-hidden />
                  Upload a sound
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {sounds.map((sound) => {
              const editing = editingId === sound.id;
              return (
                <li key={sound.id} className="pc-well group flex items-center gap-3 p-3">
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      aria-label={sound.emoji ? `Change emoji for ${sound.name}` : `Pick an emoji for ${sound.name}`}
                      disabled={!canManage}
                      onClick={() => { setEmojiTarget(sound.id); setShowEmojiPicker(true); }}
                      className="pc-well flex h-10 w-10 items-center justify-center text-text-secondary transition-colors enabled:hover:text-text-primary disabled:cursor-default"
                    >
                      <SoundEmoji emoji={sound.emoji} guildId={guildId} size={22} />
                    </button>
                    {showEmojiPicker && emojiTarget === sound.id && (
                      <div className="absolute left-0 top-full z-50 mt-2 max-w-[90vw]">
                        <Suspense fallback={null}>
                          <EmojiPicker
                            guildId={guildId}
                            onSelect={(picked) => {
                              void setSoundEmoji(sound, picked);
                              setShowEmojiPicker(false);
                            }}
                            onClose={() => setShowEmojiPicker(false)}
                          />
                        </Suspense>
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <Input
                        aria-label={`Name for ${sound.name}`}
                        value={editName}
                        maxLength={SOUNDBOARD_MAX_NAME}
                        autoFocus
                        onChange={(event) => setEditName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveEdit(sound.id);
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <p className="truncate text-label text-text-primary">{sound.name}</p>
                        <p className="mt-0.5 text-meta text-text-muted">
                          {formatDuration(sound.duration_ms)}
                        </p>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    aria-label={`Preview ${sound.name}`}
                    onClick={() => void preview(sound)}
                    className="pc-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                  >
                    {previewingId === sound.id ? <Square size={14} aria-hidden /> : <Play size={15} aria-hidden />}
                  </button>

                  {canManage && (
                    <div className="flex w-32 shrink-0 items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={sound.volume}
                        aria-label={`Volume for ${sound.name}`}
                        onChange={(event) =>
                          setSounds((prev) =>
                            prev.map((item) =>
                              item.id === sound.id ? { ...item, volume: Number(event.target.value) } : item,
                            ),
                          )
                        }
                        onPointerUp={() => void setSoundVolume(sound, sound.volume)}
                        onBlur={() => void setSoundVolume(sound, sound.volume)}
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-mod-strong accent-accent-primary [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-primary"
                      />
                      <span className="pc-mono w-8 shrink-0 text-right text-[10px] text-text-faint">
                        {sound.volume}%
                      </span>
                    </div>
                  )}

                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                      {editing ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => void saveEdit(sound.id)} disabled={!editName.trim()} loading={saving}>
                            Save
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingId(sound.id);
                            setEditName(sound.name);
                          }}
                        >
                          Rename
                        </Button>
                      )}
                      <Button variant="danger" size="sm" onClick={() => void remove(sound)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
