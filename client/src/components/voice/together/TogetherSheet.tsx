import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { FileAudio, FileVideo, Link2, Loader2, Upload } from 'lucide-react';

import { channelApi } from '../../../api/channels';
import { fileApi } from '../../../api/files';
import { galleryApi, type GalleryAttachment } from '../../../api/gallery';
import { togetherErrorMessage, type TogetherApi, type TogetherItemInput } from '../../../api/together';
import { isYouTubeLink, parseTogetherLink, UNSUPPORTED_LINK } from '../../../lib/together/links';
import type { TogetherKind, TogetherSession } from '../../../lib/together/model';
import { captureVideoStill } from '../../../lib/together/capture';
import { expandYouTubePlaylist, PLAYLIST_LIMIT } from '../../../lib/together/youtube';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toastStore';
import { useTogetherStore } from '../../../stores/togetherStore';
import { Button, Popover, Switch, Tabs, TextField } from '../../ui';

const MEDIA_ACCEPT = 'video/mp4,video/webm,audio/mpeg,audio/ogg,audio/mp4,audio/x-m4a,audio/flac,audio/wav,audio/x-wav,.mp4,.webm,.mp3,.ogg,.m4a,.flac,.wav';
const RECENT_LIMIT = 8;

function isPlayableAttachment(attachment: GalleryAttachment): boolean {
  const type = (attachment.content_type ?? '').toLowerCase();
  return type.startsWith('video/') || type.startsWith('audio/');
}

/**
 * A still of the picked video, taken on this device. An upload is read from
 * the local file; a file already posted is fetched with this person's own
 * access. Null when the frame cannot be read (the item shows a film tile).
 */
async function pickedStill(picked: GalleryAttachment, uploaded: { id: string; file: File } | null): Promise<string | null> {
  let url: string | null = null;
  try {
    url = uploaded?.id === picked.id
      ? URL.createObjectURL(uploaded.file)
      : await fileApi.resolveAttachmentObjectUrl(`/api/v1/attachments/${picked.id}`);
    return await captureVideoStill(url);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

export interface TogetherSheetProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  guildId: string;
  channelId: string;
  api: TogetherApi;
  session: TogetherSession | null;
  selfUserId: string | null;
  /** Watch or listen, when there is no session yet. */
  initialKind?: TogetherKind;
  /** Which side of the anchor the sheet opens on. */
  side?: 'top' | 'bottom';
}

/**
 * The small sheet behind the call's Together button: choose watch or listen,
 * paste a link or pick a file, and start — or, with a session running, add to
 * its queue.
 */
export function TogetherSheet({
  anchor,
  open,
  onClose,
  guildId,
  channelId,
  api,
  session,
  selfUserId,
  initialKind = 'watch',
  side = 'top',
}: TogetherSheetProps) {
  const [kind, setKind] = useState<TogetherKind>(initialKind);
  const [link, setLink] = useState('');
  const [picked, setPicked] = useState<GalleryAttachment | null>(null);
  const [onlyMe, setOnlyMe] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<GalleryAttachment[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The file just uploaded here: its preview frame is read locally, not downloaded again. */
  const uploadedFile = useRef<{ id: string; file: File } | null>(null);
  const adding = session != null;
  const isStarter = session != null && session.started_by === selfUserId;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(null);
  }, [open]);

  useEffect(() => {
    if (!open || !showFiles || recent) return;
    let canceled = false;
    galleryApi
      .guildAttachments(guildId, { kind: 'video,file', limit: 50 })
      .then(({ data }) => {
        if (!canceled) setRecent(data.items.filter(isPlayableAttachment).slice(0, RECENT_LIMIT));
      })
      .catch((err: unknown) => {
        if (!canceled) setRecentError(togetherErrorMessage(err));
      });
    return () => {
      canceled = true;
    };
  }, [open, showFiles, recent, guildId]);

  const parsed = useMemo(() => (link.trim() ? parseTogetherLink(link) : null), [link]);
  const fromYouTube = parsed != null && isYouTubeLink(parsed);

  const items = async (): Promise<TogetherItemInput[]> => {
    if (picked) {
      const item: TogetherItemInput = { source: 'attachment', ref: picked.id };
      if ((picked.content_type ?? '').toLowerCase().startsWith('video/')) {
        setBusy('Taking a preview frame…');
        const still = await pickedStill(picked, uploadedFile.current);
        if (still) item.thumbnail = still;
      }
      return [item];
    }
    if (!parsed) throw new Error('Paste a link or pick a file first');
    switch (parsed.kind) {
      case 'youtube':
        return [{ source: 'youtube', ref: parsed.videoId }];
      case 'youtube-playlist': {
        setBusy('Reading the playlist…');
        const ids = await expandYouTubePlaylist(parsed.listId);
        return ids.map((id) => ({ source: 'youtube' as const, ref: id }));
      }
      case 'url':
        return [{ source: 'url', ref: parsed.url }];
      case 'error':
        throw new Error(parsed.message);
    }
  };

  const submit = async () => {
    setError(null);
    try {
      setBusy(adding ? 'Adding…' : 'Starting…');
      const list = await items();
      setBusy(adding ? 'Adding…' : 'Starting…');
      const next = adding
        ? await api.addItems(channelId, list)
        : await api.start(channelId, { kind, controller_policy: onlyMe ? 'starter' : 'everyone', items: list });
      useTogetherStore.getState().applySessionSnapshot(channelId, next);
      const added = adding ? next.items.length - (session?.items.length ?? 0) : next.items.length;
      if (list.length > 1 && added < list.length) {
        const left = list.length - added;
        toast.info(`Added ${added} of ${list.length}. ${left === 1 ? 'One video' : `${left} videos`} cannot play outside YouTube.`);
      }
      setLink('');
      setPicked(null);
      uploadedFile.current = null;
      onClose();
    } catch (err) {
      setError(err instanceof Error && !('response' in err) ? err.message : togetherErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // An upload becomes a normal attachment in this voice channel's chat, so it
  // is permission-checked like any other; then it is queued like one.
  const upload = async (file: File) => {
    setError(null);
    const type = file.type.toLowerCase();
    if (!type.startsWith('video/') && !type.startsWith('audio/')) {
      setError(UNSUPPORTED_LINK);
      return;
    }
    try {
      setBusy(`Uploading ${file.name}…`);
      const attachment = await fileApi.upload(channelId, file);
      await channelApi.sendMessage(channelId, { content: '', attachment_ids: [attachment.id] });
      uploadedFile.current = { id: attachment.id, file };
      setPicked({
        id: attachment.id,
        filename: attachment.filename ?? file.name,
        content_type: attachment.content_type ?? file.type,
      } as GalleryAttachment);
      setLink('');
    } catch (err) {
      setError(togetherErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const setPolicy = async (next: boolean) => {
    if (!session) {
      setOnlyMe(next);
      return;
    }
    try {
      const updated = await api.setPolicy(channelId, next ? 'starter' : 'everyone');
      useTogetherStore.getState().applySessionSnapshot(channelId, updated);
    } catch (err) {
      setError(togetherErrorMessage(err));
    }
  };

  const hint = parsed?.kind === 'youtube-playlist'
    ? `Plays from YouTube on each person's device. Adds up to ${PLAYLIST_LIMIT} videos.`
    : fromYouTube
      ? "Plays from YouTube on each person's device"
      : parsed?.kind === 'url'
        ? `Plays from ${parsed.host} on each person's device`
        : null;
  const linkError = parsed?.kind === 'error' ? parsed.message : null;
  const canSubmit = !busy && (picked != null || (parsed != null && parsed.kind !== 'error'));
  const lockedForMe = session != null && session.controller_policy === 'starter' && !isStarter;

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      side={side}
      align={side === 'top' ? 'center' : 'end'}
      label={adding ? 'Add to the queue' : 'Watch or listen together'}
      className="w-[min(23rem,calc(100vw-1.5rem))] p-3.5"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        {adding ? (
          <h2 className="text-label font-semibold text-text-primary">Add to the queue</h2>
        ) : (
          <Tabs
            label="What to do together"
            fill
            value={kind}
            onChange={setKind}
            items={[
              { value: 'watch', label: 'Watch together' },
              { value: 'listen', label: 'Listen together' },
            ]}
          />
        )}

        {lockedForMe ? (
          <p className="text-meta text-text-secondary">Only the person who started this can add to the queue.</p>
        ) : (
          <>
            <TextField
              label="Paste a link or pick a file"
              placeholder="YouTube link, or a link to an .mp4, .mp3 …"
              value={picked ? '' : link}
              disabled={picked != null}
              onChange={(event) => {
                setLink(event.target.value);
                setError(null);
              }}
              icon={<Link2 size={15} />}
              autoFocus
              error={linkError ?? undefined}
              hint={hint ?? undefined}
            />

            {picked ? (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] bg-bg-well px-2.5 py-2">
                {(picked.content_type ?? '').startsWith('audio/') ? (
                  <FileAudio size={16} className="shrink-0 text-text-secondary" aria-hidden />
                ) : (
                  <FileVideo size={16} className="shrink-0 text-text-secondary" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-label text-text-primary">{picked.filename}</span>
                <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="ghost" size="sm" aria-expanded={showFiles} onClick={() => setShowFiles((value) => !value)}>
                  <FileVideo size={14} aria-hidden />
                  Pick a file
                </Button>
                <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} disabled={busy != null}>
                  <Upload size={14} aria-hidden />
                  Upload
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={MEDIA_ACCEPT}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void upload(file);
                  }}
                />
              </div>
            )}

            {showFiles && !picked && (
              <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-control)] bg-bg-well p-1">
                {recentError && <p className="px-2 py-1.5 text-meta text-accent-danger">{recentError}</p>}
                {!recent && !recentError && (
                  <p className="flex items-center gap-2 px-2 py-1.5 text-meta text-text-muted">
                    <Loader2 size={13} className="animate-spin" aria-hidden /> Looking for videos and music…
                  </p>
                )}
                {recent?.length === 0 && (
                  <p className="px-2 py-1.5 text-meta text-text-muted">No videos or music posted in this server yet.</p>
                )}
                {recent?.map((attachment) => (
                  <button
                    key={attachment.id}
                    type="button"
                    onClick={() => {
                      setPicked(attachment);
                      setShowFiles(false);
                      setError(null);
                    }}
                    className="pc-focusable flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left hover:bg-bg-mod-subtle"
                  >
                    {(attachment.content_type ?? '').startsWith('audio/') ? (
                      <FileAudio size={15} className="shrink-0 text-text-muted" aria-hidden />
                    ) : (
                      <FileVideo size={15} className="shrink-0 text-text-muted" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate text-label text-text-primary">{attachment.filename}</span>
                    <span className="shrink-0 truncate text-meta text-text-muted">
                      {attachment.author.display_name ?? attachment.author.username}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {(!session || isStarter) && (
          <label className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-label text-text-primary">Only I can control it</span>
              <span className="text-meta text-text-muted">Others can still watch and listen</span>
            </span>
            <Switch
              size="sm"
              label="Only I can control it"
              checked={session ? session.controller_policy === 'starter' : onlyMe}
              onChange={(next) => void setPolicy(next)}
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-meta text-accent-danger">
            {error}
          </p>
        )}

        {!lockedForMe && (
          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className={cn('mr-auto flex min-w-0 items-center gap-1.5 truncate text-meta text-text-muted')}>
                <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden />
                <span className="truncate">{busy}</span>
              </span>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {adding ? 'Add to queue' : kind === 'watch' ? 'Start watching' : 'Start listening'}
            </Button>
          </div>
        )}
      </form>
    </Popover>
  );
}
