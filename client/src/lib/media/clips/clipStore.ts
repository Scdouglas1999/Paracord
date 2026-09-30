/**
 * Clips, end to end (docs/glass-spec.md §6.4): what is armed, the clip just
 * saved, and posting it.
 *
 * **Armed while watching.** The ring follows `voiceStore.watchView`: it is
 * armed once the watch is live and freed the moment the watch stops, fails, or
 * turns to another stream. When the watch moves into or out of the call (a new
 * engine, the same sharer) the ring keeps what it holds. Nothing is kept when
 * nothing is watched. Your own share is never armed: you can clip other
 * people's streams, not your own (the owner may want that later; it would tap
 * the encoder's output rather than a decoder's intake).
 *
 * **Saving** cuts the ring, times and muxes the frames (WebM or MP4 by codec),
 * and holds the file for the toast, with a thumbnail sampled from the watched
 * stream. **Posting** sends it through the conversation's own attachment path:
 * `fileApi.upload` and a message, or the encrypted producer in an end-to-end
 * encrypted conversation. A clip over the destination's upload limit is
 * refused with its size and the limit; it is never shortened to fit.
 */
import { create } from 'zustand';
import { extractApiError } from '../../../api/client';
import { fileApi } from '../../../api/files';
import { formatFileSize, wallClock } from '../../formatters';
import { createViewFrameSource } from '../../room/viewFrameSource';
import type { MessageState } from '../../../stores/messageStore';
import type { MediaViewState } from '../../../stores/voice/viewSessions';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { MediaEngine } from '../mediaEngine';
import { clipFilename, clipSeconds, screenSourceName } from './clipFilename';
import { muxClip } from './clipMux';
import { CLIP_WINDOW_MS } from './clipRing';
import { clipSourceForRuntime, type ClipSource } from './clipSource';
import { buildClipTimeline } from './clipTimeline';

export interface SavedClip {
  id: number;
  file: File;
  /** An object URL for the file (to save it to this device). */
  url: string;
  /** An object URL for a still of the stream, once sampled. */
  thumbnailUrl: string | null;
  durationMs: number;
  /** "Vincent's screen". */
  sourceName: string;
  /** When it was cut (ms since the epoch). */
  savedAt: number;
}

export type ClipPostPhase = 'idle' | 'posting' | 'posted';

export interface ClipStoreState {
  /** The watch the ring is armed for. */
  armed: { key: string; streamerId: string; engine: MediaEngine } | null;
  /** Why the ring is not armed for the stream on the stage, when it is not. */
  blocked: 'own-stream' | 'error' | null;
  armError: string | null;
  saving: boolean;
  saved: SavedClip | null;
  postPhase: ClipPostPhase;
  postProgress: number | null;
  /** Why the clip was not posted, in a sentence. */
  postError: string | null;
  /** Posting was refused for the clip's size. */
  tooLarge: boolean;
  postedTo: string | null;
}

const INITIAL: ClipStoreState = {
  armed: null,
  blocked: null,
  armError: null,
  saving: false,
  saved: null,
  postPhase: 'idle',
  postProgress: null,
  postError: null,
  tooLarge: false,
  postedTo: null,
};

export const useClipStore = create<ClipStoreState>(() => ({ ...INITIAL }));

/** How long "Posted to General" stays before the toast goes by itself. */
export const POSTED_TOAST_MS = 6_000;
const THUMB_WIDTH = 192;
const THUMB_HEIGHT = 108;

/* ---- Arming: follows the watch ---------------------------------------------------- */

let source: ClipSource | null = null;
let lifecycleStop: (() => void) | null = null;
let lifecycleUsers = 0;
/** Serializes arm/disarm so a quick stop-then-watch cannot interleave. */
let armChain: Promise<void> = Promise.resolve();

function watchKey(view: MediaViewState): string {
  return `${view.scope.serverId}:${view.guildId}:${view.channelId}:${view.streamerId}`;
}

function freeSaved(saved: SavedClip | null): void {
  if (!saved) return;
  URL.revokeObjectURL(saved.url);
  if (saved.thumbnailUrl) URL.revokeObjectURL(saved.thumbnailUrl);
}

let postedTimer: ReturnType<typeof setTimeout> | null = null;
function clearPostedTimer(): void {
  if (postedTimer) clearTimeout(postedTimer);
  postedTimer = null;
}

function disarm(): void {
  const state = useClipStore.getState();
  if (!state.armed && !state.saved && !state.blocked) return;
  clearPostedTimer();
  freeSaved(state.saved);
  useClipStore.setState({ ...INITIAL });
  const current = source;
  if (current) armChain = armChain.then(() => current.disarm()).catch(() => undefined);
}

function reconcile(view: MediaViewState | null): void {
  if (!view || view.kind !== 'watch' || view.phase === 'ended' || view.phase === 'failed') {
    disarm();
    return;
  }
  const key = watchKey(view);
  const state = useClipStore.getState();
  if (state.armed && state.armed.key !== key) disarm();
  if (view.streamerId === view.scope.userId) {
    if (useClipStore.getState().blocked !== 'own-stream') useClipStore.setState({ blocked: 'own-stream', armError: null });
    return;
  }
  if (view.phase !== 'live' || !view.engine) return; // keep what is held while it connects
  const armed = useClipStore.getState().armed;
  if (armed && armed.key === key && armed.engine === view.engine) return;
  const engine = view.engine;
  const streamerId = view.streamerId;
  source ??= clipSourceForRuntime();
  const current = source;
  useClipStore.setState({ armed: { key, streamerId, engine }, blocked: null, armError: null });
  armChain = armChain
    .then(() => current.arm(engine, streamerId))
    .catch((error: unknown) => {
      if (useClipStore.getState().armed?.key !== key) return;
      useClipStore.setState({
        armed: null,
        blocked: 'error',
        armError: `Clips cannot start: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
}

/**
 * Follow the watch for as long as something shows a Clip control or toast.
 * Returns the release; the last release disarms and frees everything.
 */
export function startClipLifecycle(): () => void {
  lifecycleUsers++;
  if (!lifecycleStop) {
    reconcile(useVoiceStore.getState().watchView);
    lifecycleStop = useVoiceStore.subscribe((state, previous) => {
      if (state.watchView !== previous.watchView) reconcile(state.watchView);
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lifecycleUsers--;
    if (lifecycleUsers === 0 && lifecycleStop) {
      lifecycleStop();
      lifecycleStop = null;
      disarm();
    }
  };
}

/* ---- Saving --------------------------------------------------------------------- */

let clipIds = 0;

/** A still of the stream now, as an object URL (cover-cropped 16:9), or null. */
async function sampleThumbnail(streamerId: string): Promise<string | null> {
  const bitmap = await createViewFrameSource('watch', streamerId).getLatestFrame();
  if (!bitmap) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const scale = Math.max(THUMB_WIDTH / bitmap.width, THUMB_HEIGHT / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, (THUMB_WIDTH - width) / 2, (THUMB_HEIGHT - height) / 2, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    bitmap.close();
  }
}

/** "Saved the last 30 seconds", or the true length when less was held. */
export function savedTitle(durationMs: number): string {
  if (durationMs >= CLIP_WINDOW_MS - 500) return 'Saved the last 30 seconds';
  const seconds = clipSeconds(durationMs);
  return `Saved the last ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** "From Vincent's screen, 9:14 PM". */
export function savedSubtitle(clip: Pick<SavedClip, 'sourceName' | 'savedAt'>): string {
  return `From ${clip.sourceName}, ${wallClock(clip.savedAt)}`;
}

/** Cut the last 30 seconds of the stream on the stage. Rejects with the reason when it cannot. */
export async function saveClip(target: { streamerId: string; streamerName: string }): Promise<void> {
  const state = useClipStore.getState();
  if (state.blocked === 'own-stream') throw new Error("You can clip other people's streams, not your own.");
  if (state.blocked === 'error') throw new Error(state.armError ?? 'Clips cannot start.');
  if (!state.armed || state.armed.streamerId !== target.streamerId || !source) {
    throw new Error(`Waiting for ${screenSourceName(target.streamerName)}.`);
  }
  if (state.saving) return;
  useClipStore.setState({ saving: true });
  const armedKey = state.armed.key;
  try {
    await armChain;
    const savedAt = Date.now();
    const capture = await source.cut();
    const timeline = buildClipTimeline(capture, { cutAt: savedAt });
    const { muxed, timeline: span } = muxClip(timeline);
    const sourceName = screenSourceName(target.streamerName);
    const file = new File(muxed.parts as BlobPart[], clipFilename(span.durationMs, sourceName, muxed.extension), { type: muxed.mimeType });
    if (useClipStore.getState().armed?.key !== armedKey) return; // the watch ended while cutting
    const id = ++clipIds;
    clearPostedTimer();
    freeSaved(useClipStore.getState().saved);
    useClipStore.setState({
      saved: { id, file, url: URL.createObjectURL(file), thumbnailUrl: null, durationMs: span.durationMs, sourceName, savedAt },
      postPhase: 'idle',
      postProgress: null,
      postError: null,
      tooLarge: false,
      postedTo: null,
    });
    // The still arrives when the next frame does; the toast shows without waiting for it.
    void sampleThumbnail(target.streamerId)
      .then((thumbnailUrl) => {
        if (!thumbnailUrl) return;
        const saved = useClipStore.getState().saved;
        if (saved?.id !== id) {
          URL.revokeObjectURL(thumbnailUrl);
          return;
        }
        useClipStore.setState({ saved: { ...saved, thumbnailUrl } });
      })
      .catch(() => undefined);
  } finally {
    useClipStore.setState({ saving: false });
  }
}

/* ---- Posting -------------------------------------------------------------------- */

export interface ClipDestination {
  channelId: string;
  /** "General", for "Post to General". */
  label: string;
  encrypted: boolean;
  /** The upload limit that applies, in bytes, when known. */
  maxBytes: number | null;
  /** Whether this person may attach files here now, and why not. */
  allowed: boolean;
  reason: string | null;
  sendMessage: MessageState['sendMessage'];
}

export function tooLargeMessage(size: number, maxBytes: number, label: string): string {
  return `This clip is ${formatFileSize(size)} and ${label} takes files up to ${formatFileSize(maxBytes)}, so it was not posted. Save it to this device instead.`;
}

/** Post the saved clip as your message in `destination`. Never throws; the toast shows what happened. */
export async function postSavedClip(destination: ClipDestination): Promise<void> {
  const clip = useClipStore.getState().saved;
  if (!clip || useClipStore.getState().postPhase !== 'idle') return;
  if (!destination.allowed) {
    useClipStore.setState({ postError: destination.reason ?? `You cannot post files in ${destination.label}.` });
    return;
  }
  if (destination.maxBytes !== null && clip.file.size > destination.maxBytes) {
    useClipStore.setState({ tooLarge: true, postError: tooLargeMessage(clip.file.size, destination.maxBytes, destination.label) });
    return;
  }
  useClipStore.setState({ postPhase: 'posting', postProgress: destination.encrypted ? null : 0, postError: null, tooLarge: false });
  const stillThisClip = () => useClipStore.getState().saved?.id === clip.id;
  try {
    if (destination.encrypted) {
      // The encrypted producer encrypts the file on this device and uploads only ciphertext.
      await destination.sendMessage(destination.channelId, '', undefined, [], undefined, undefined, {
        files: [clip.file],
        maxCiphertextBytes: destination.maxBytes ?? Number.MAX_SAFE_INTEGER,
      });
    } else {
      const attachment = await fileApi.upload(destination.channelId, clip.file, (percent) => {
        if (stillThisClip()) useClipStore.setState({ postProgress: percent });
      });
      await destination.sendMessage(destination.channelId, '', undefined, [attachment.id]);
    }
    if (!stillThisClip()) return;
    useClipStore.setState({ postPhase: 'posted', postProgress: null, postedTo: destination.label });
    clearPostedTimer();
    postedTimer = setTimeout(() => {
      if (stillThisClip()) dismissClip();
    }, POSTED_TOAST_MS);
  } catch (error) {
    if (!stillThisClip()) return;
    const status = (error as { response?: { status?: number } })?.response?.status;
    const tooLarge = status === 413;
    useClipStore.setState({
      postPhase: 'idle',
      postProgress: null,
      tooLarge,
      postError: tooLarge
        ? `This clip is ${formatFileSize(clip.file.size)}, more than ${destination.label} takes (${extractApiError(error)}), so it was not posted. Save it to this device instead.`
        : `The clip was not posted: ${extractApiError(error)}`,
    });
  }
}

/** Save the clip to this device (a download). */
export function downloadSavedClip(): void {
  const clip = useClipStore.getState().saved;
  if (!clip) return;
  const link = document.createElement('a');
  link.href = clip.url;
  link.download = clip.file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Close the toast and let the clip go (unless it is uploading). */
export function dismissClip(): void {
  const state = useClipStore.getState();
  if (state.postPhase === 'posting') return;
  clearPostedTimer();
  freeSaved(state.saved);
  useClipStore.setState({ saved: null, postPhase: 'idle', postProgress: null, postError: null, tooLarge: false, postedTo: null });
}

/** Tests only: forget everything, including the lifecycle. */
export function resetClipsForTests(nextSource: ClipSource | null = null): void {
  lifecycleStop?.();
  lifecycleStop = null;
  lifecycleUsers = 0;
  clearPostedTimer();
  source = nextSource;
  armChain = Promise.resolve();
  useClipStore.setState({ ...INITIAL });
}
