import { useCallback, useEffect, useRef, useState } from 'react';
import { Sticker as StickerIcon, Upload } from 'lucide-react';

import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import type { Sticker } from '../../types';
import { confirm } from '../../stores/confirmStore';
import { Button, EmptyState, Input } from '../ui';
import { ResourceImage } from '../ui/ResourceImage';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { safeClientResourceUrl } from '../../lib/security';
import { GateNotice, GroupLabel, SectionHeader } from './SettingsPrimitives';

/** The server's limits (`routes/stickers.rs`): shown up front, checked there too. */
const MAX_STICKERS = 60;
const MAX_STICKER_BYTES = 1024 * 1024;
const MAX_TAGS = 10;
const STICKER_TYPES = ['image/png', 'image/apng', 'image/webp', 'image/gif'];

interface StickersSectionProps {
  guildId: string;
  canManage: boolean;
}

function splitTags(raw: string): string[] {
  return raw.split(',').map((tag) => tag.trim()).filter(Boolean);
}

/** Server settings → Stickers: the Emojis section's layout, for stickers. */
export function StickersSection({ guildId, canManage }: StickersSectionProps) {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editTags, setEditTags] = useState('');
  const [saving, setSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const ticket = useDownloadTicket();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await guildApi.listStickers(guildId);
      setStickers(data);
      setError(null);
    } catch (err) {
      setError(`Could not load stickers: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  const full = stickers.length >= MAX_STICKERS;

  const chooseFile = (next: File | null) => {
    if (!next) {
      setFile(null);
      return;
    }
    if (!STICKER_TYPES.includes(next.type)) {
      setError('Stickers must be PNG, APNG, WebP, or GIF.');
      setFile(null);
      return;
    }
    if (next.size > MAX_STICKER_BYTES) {
      setError('Sticker image must be 1 MB or smaller.');
      setFile(null);
      return;
    }
    setError(null);
    setFile(next);
  };

  const upload = async () => {
    if (!file || !name.trim() || uploading || full) return;
    if (splitTags(tags).length > MAX_TAGS) {
      setError(`A sticker can have at most ${MAX_TAGS} tags.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const { data } = await guildApi.createSticker(guildId, {
        name: name.trim(),
        tags: splitTags(tags).join(','),
        file,
      });
      setStickers((prev) => [data, ...prev]);
      setName('');
      setTags('');
      setFile(null);
    } catch (err) {
      setError(`Could not upload the sticker: ${extractApiError(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const saveEdit = async (stickerId: string) => {
    if (!editName.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await guildApi.updateSticker(guildId, stickerId, {
        name: editName.trim(),
        tags: splitTags(editTags),
      });
      setStickers((prev) => prev.map((sticker) => (sticker.id === stickerId ? data : sticker)));
      setEditingId(null);
    } catch (err) {
      setError(`Could not save the sticker: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (sticker: Sticker) => {
    const ok = await confirm({
      title: `Delete ${sticker.name}?`,
      description: 'It is removed from the server and can no longer be sent.',
      confirmLabel: 'Delete sticker',
      variant: 'danger',
    });
    if (!ok) return;
    setError(null);
    try {
      await guildApi.deleteSticker(guildId, sticker.id);
      setStickers((prev) => prev.filter((item) => item.id !== sticker.id));
    } catch (err) {
      setError(`Could not delete ${sticker.name}: ${extractApiError(err)}`);
    }
  };

  const imageSrc = (sticker: Sticker) => {
    const safe = safeClientResourceUrl(sticker.image_url);
    return safe ? safeClientResourceUrl(resolveResourceUrl(safe, ticket)) : null;
  };

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="Stickers"
        description="Larger pictures anyone in the server can send in a message."
      />

      {!canManage && (
        <GateNotice>You can view server stickers, but the Manage Emojis permission is needed to add, edit, or delete them.</GateNotice>
      )}

      {error && <p role="alert" className="text-body text-accent-danger">{error}</p>}

      {canManage && (
        <section className="border-t border-border-subtle pt-6">
          <GroupLabel>Add a sticker</GroupLabel>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Input
              ref={nameInputRef}
              aria-label="Sticker name"
              placeholder="Name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              aria-label="Sticker tags"
              placeholder="Tags, separated by commas"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="pc-well inline-flex h-[var(--h-control-phone)] min-w-0 cursor-pointer items-center justify-center px-3.5 text-label text-text-secondary transition-colors hover:text-text-primary focus-within:shadow-[var(--shadow-well),var(--focus-ring)]">
              <input
                type="file"
                accept={STICKER_TYPES.join(',')}
                aria-label="Sticker image file"
                className="sr-only"
                onChange={(event) => {
                  chooseFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
              <span className="truncate">{file ? file.name : 'Choose PNG, APNG, WebP, or GIF · 1 MB'}</span>
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
          <p className="mt-3 max-w-prose text-meta leading-relaxed text-text-muted">
            {full
              ? `This server has all ${MAX_STICKERS} stickers it can hold. Delete one to add another.`
              : `Up to ${MAX_STICKERS} stickers per server, 1 MB each, with up to ${MAX_TAGS} tags of 30 characters or fewer.`}
          </p>
        </section>
      )}

      <section className="border-t border-border-subtle pt-6">
        <div className="flex items-baseline justify-between gap-3">
          <GroupLabel>Server stickers</GroupLabel>
          <span className="pc-mono text-meta text-text-muted">{stickers.length} of {MAX_STICKERS}</span>
        </div>
        {loading ? (
          <p className="mt-4 text-body text-text-secondary">Loading stickers…</p>
        ) : stickers.length === 0 ? (
          <EmptyState
            className="!py-8"
            icon={<StickerIcon size={20} />}
            title="No stickers yet"
            description="Upload a PNG, APNG, WebP, or GIF above and it can be sent in any channel in the server."
            action={
              canManage ? (
                <Button variant="ghost" onClick={() => nameInputRef.current?.focus()}>
                  Add a sticker
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {stickers.map((sticker) => {
              const editing = editingId === sticker.id;
              const stickerTags = sticker.tags ?? [];
              return (
                <li key={sticker.id} className="pc-well group flex items-start gap-3 p-3">
                  <ResourceImage
                    src={imageSrc(sticker)}
                    alt={sticker.name}
                    loading="lazy"
                    className="h-16 w-16 shrink-0 rounded-[var(--radius-chip)] bg-bg-raised object-contain p-1"
                    fallback={<span className="h-16 w-16 shrink-0 rounded-[var(--radius-chip)] bg-bg-raised" />}
                  />
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <div className="flex flex-col gap-2">
                        <Input
                          aria-label={`Name for ${sticker.name}`}
                          value={editName}
                          maxLength={64}
                          autoFocus
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveEdit(sticker.id);
                            if (event.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Input
                          aria-label={`Tags for ${sticker.name}`}
                          placeholder="Tags, separated by commas"
                          value={editTags}
                          onChange={(event) => setEditTags(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveEdit(sticker.id);
                            if (event.key === 'Escape') setEditingId(null);
                          }}
                        />
                      </div>
                    ) : (
                      <>
                        <p className="truncate text-label text-text-primary">{sticker.name}</p>
                        <p className="mt-1 truncate text-meta text-text-muted">
                          {stickerTags.length > 0 ? stickerTags.join(', ') : 'No tags'}
                        </p>
                      </>
                    )}
                    {canManage && (
                      <div className="mt-2.5 flex items-center gap-1 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                        {editing ? (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => void saveEdit(sticker.id)} disabled={!editName.trim()} loading={saving}>
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
                              setEditingId(sticker.id);
                              setEditName(sticker.name);
                              setEditTags(stickerTags.join(', '));
                            }}
                          >
                            Edit
                          </Button>
                        )}
                        <Button variant="danger" size="sm" onClick={() => void remove(sticker)}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
