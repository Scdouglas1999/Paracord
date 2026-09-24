/**
 * Soundboard playback: short sounds anyone in a voice channel can play for
 * everyone in it (`POST /channels/{id}/soundboard/play` → `SOUNDBOARD_PLAY`).
 *
 * Every listener plays the sound locally — never through the sender's mic
 * uplink — at `sound.volume x personal soundboard volume`, on the same output
 * device the call uses:
 *
 *   - Browser / LiveKit calls play through a Web Audio graph routed to the
 *     selected output device (`AudioContext.setSinkId`, or a
 *     `MediaStreamDestination` → `<audio>` element where the context method is
 *     missing).
 *   - Native (Tauri/QUIC) calls hand 48 kHz stereo PCM to
 *     `voice_play_soundboard`, which feeds the cpal mixer alongside remote
 *     voice — WebView `setSinkId` cannot reach cpal's output device.
 *
 * Decoded buffers are cached per session so repeat plays are instant, and a
 * guild's sounds are preloaded when its voice channel is joined. Deafen gates
 * playback at start AND mid-clip (live gain nodes are silenced while deafened,
 * matching remote audio); the "Play soundboard sounds" setting gates every
 * path including local previews.
 */

import { getApi } from '../../api/activeClient';
import type { SoundboardSound } from '../../api/guilds';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { isTauri } from '../tauriEnv';

export const SOUNDBOARD_MAX_BYTES = 1024 * 1024;
export const SOUNDBOARD_MAX_SECONDS = 5;
export const SOUNDBOARD_MAX_PER_GUILD = 48;
export const SOUNDBOARD_MIN_NAME = 2;
export const SOUNDBOARD_MAX_NAME = 32;
export const SOUNDBOARD_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
];
export const SOUNDBOARD_EXTENSIONS = /\.(mp3|ogg|wav|m4a)$/i;

/** "Play soundboard sounds" toggle (Settings → Voice). On unless explicitly off. */
export function soundboardEnabled(): boolean {
  const notif = useAuthStore.getState().settings?.notifications as
    | Record<string, unknown>
    | undefined;
  return notif?.['soundboardEnabled'] !== false;
}

/** Personal soundboard volume as a 0..1 multiplier (Settings → Voice; 0–100). */
export function soundboardVolume(): number {
  const notif = useAuthStore.getState().settings?.notifications as
    | Record<string, unknown>
    | undefined;
  const raw = notif?.['soundboardVolume'];
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value / 100));
}

/** Effective gain for one play: the sound's own volume x the listener's. */
export function soundboardGain(sound: Pick<SoundboardSound, 'volume'>): number {
  const soundVolume = Number.isFinite(sound.volume)
    ? Math.min(1, Math.max(0, sound.volume / 100))
    : 1;
  return soundVolume * soundboardVolume();
}

/** The output device the call is routed to (`''`/undefined = system default). */
export function soundboardOutputDeviceId(): string | undefined {
  const notif = useAuthStore.getState().settings?.notifications as
    | Record<string, unknown>
    | undefined;
  const id = notif?.['audioOutputDeviceId'];
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Asset fetch + decode cache
// ---------------------------------------------------------------------------

/** sound.id -> decoded buffer; a rejected entry is evicted so a retry can run. */
const decodedCache = new Map<string, Promise<AudioBuffer>>();
/** sound.id -> 48 kHz interleaved stereo PCM for the native mixer path. */
const pcm48Cache = new Map<string, Promise<Float32Array>>();

async function fetchSoundBytes(sound: SoundboardSound): Promise<ArrayBuffer> {
  // Authenticated fetch — the file endpoint requires membership, and the axios
  // client carries the Bearer token on web and desktop alike.
  const path = sound.sound_url.replace(/^\/api\/v1\//, '');
  const { data } = await getApi().get<ArrayBuffer>(path, { responseType: 'arraybuffer' });
  return data;
}

let decodeContext: AudioContext | null = null;

function getDecodeContext(): AudioContext {
  if (!decodeContext || decodeContext.state === 'closed') {
    decodeContext = new AudioContext();
  }
  return decodeContext;
}

function decodeSound(sound: SoundboardSound): Promise<AudioBuffer> {
  const cached = decodedCache.get(sound.id);
  if (cached) return cached;
  const promise = fetchSoundBytes(sound).then((bytes) =>
    getDecodeContext().decodeAudioData(bytes),
  );
  decodedCache.set(sound.id, promise);
  promise.catch(() => {
    if (decodedCache.get(sound.id) === promise) decodedCache.delete(sound.id);
  });
  return promise;
}

/** Stereo 48 kHz interleaved PCM — the native mixer's wire format. */
function resampleTo48kStereo(sound: SoundboardSound): Promise<Float32Array> {
  const cached = pcm48Cache.get(sound.id);
  if (cached) return cached;
  const promise = decodeSound(sound).then(async (buffer) => {
    const frames = Math.ceil(buffer.duration * 48000);
    const offline = new OfflineAudioContext(2, Math.max(frames, 1), 48000);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
    const interleaved = new Float32Array(rendered.length * 2);
    for (let i = 0; i < rendered.length; i++) {
      interleaved[i * 2] = left[i];
      interleaved[i * 2 + 1] = right[i];
    }
    return interleaved;
  });
  pcm48Cache.set(sound.id, promise);
  promise.catch(() => {
    if (pcm48Cache.get(sound.id) === promise) pcm48Cache.delete(sound.id);
  });
  return promise;
}

/**
 * Fetch + decode every sound in the guild so the first play is instant.
 * Fire-and-forget on voice join; failures are dropped from the cache so the
 * next play retries the fetch.
 */
export function preloadGuildSounds(sounds: readonly SoundboardSound[]): void {
  for (const sound of sounds) {
    void decodeSound(sound).catch(() => {});
  }
}

/** Drop cached audio for a sound (deleted or re-uploaded). */
export function evictSoundCache(soundId: string): void {
  decodedCache.delete(soundId);
  pcm48Cache.delete(soundId);
}

/** Drop every cached sound for a guild (e.g. on leave) — ids change per guild. */
export function evictGuildSoundCache(guildId: string, sounds: readonly SoundboardSound[]): void {
  for (const sound of sounds) {
    if (sound.guild_id === guildId) evictSoundCache(sound.id);
  }
}

// ---------------------------------------------------------------------------
// Playback — browser path
// ---------------------------------------------------------------------------

interface PlaybackGraph {
  ctx: AudioContext;
  /** The node sources connect to: the context destination, or a MediaStream destination feeding the routed element. */
  output: AudioNode;
  /** Present when the ctx cannot route itself and output goes through an element. */
  element: HTMLAudioElement | null;
}

let playback: PlaybackGraph | null = null;
let playbackSinkId: string | null | undefined; // undefined = never applied

/** Gain nodes currently sounding, for live deafen gating. */
const activeGains = new Map<GainNode, number>();

async function getPlaybackGraph(deviceId: string | undefined): Promise<PlaybackGraph> {
  if (!playback || playback.ctx.state === 'closed') {
    const ctx = new AudioContext();
    playback = { ctx, output: ctx.destination, element: null };
    playbackSinkId = undefined;
  }
  const sink = deviceId ?? null;
  if (playbackSinkId === sink) return playback;

  const ctx = playback.ctx as AudioContext & {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (!playback.element && typeof ctx.setSinkId === 'function') {
    try {
      await ctx.setSinkId(sink ?? '');
      playbackSinkId = sink;
      return playback;
    } catch {
      // Fall through to the element route — an unknown device id throws here.
    }
  }

  // Element route: MediaStreamDestination → <audio> + HTMLMediaElement.setSinkId.
  // This is also what remote call audio uses on this engine.
  if (!playback.element) {
    const dest = playback.ctx.createMediaStreamDestination();
    const element = new Audio();
    element.autoplay = true;
    element.srcObject = dest.stream;
    playback.element = element;
    playback.output = dest;
    void element.play().catch(() => {});
  }
  const el = playback.element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof el.setSinkId === 'function') {
    try {
      await el.setSinkId(sink ?? '');
    } catch {
      // Unsupported/unknown device — play on the default rather than not at all.
    }
  }
  playbackSinkId = sink;
  return playback;
}

/**
 * Wire a buffer into the playback graph. Returns once the source is scheduled;
 * the gain node registers in `activeGains` until the clip ends so a deafen
 * mid-clip silences it like remote audio does.
 */
async function playBuffer(buffer: AudioBuffer, gain: number): Promise<void> {
  const graph = await getPlaybackGraph(soundboardOutputDeviceId());
  if (graph.ctx.state === 'suspended') {
    await graph.ctx.resume().catch(() => {});
  }
  const source = graph.ctx.createBufferSource();
  source.buffer = buffer;
  const gainNode = graph.ctx.createGain();
  gainNode.gain.value = useVoiceStore.getState().selfDeaf ? 0 : gain;
  activeGains.set(gainNode, gain);
  source.connect(gainNode);
  gainNode.connect(graph.output);
  source.onended = () => {
    activeGains.delete(gainNode);
    gainNode.disconnect();
  };
  source.start();
}

// A deafen mid-clip silences whatever is already sounding; undeafen restores it.
let deafenSubscribed = false;
function subscribeDeafen(): void {
  if (deafenSubscribed) return;
  deafenSubscribed = true;
  useVoiceStore.subscribe((state, prev) => {
    if (state.selfDeaf === prev.selfDeaf) return;
    for (const [node, gain] of activeGains) {
      node.gain.value = state.selfDeaf ? 0 : gain;
    }
  });
}

// ---------------------------------------------------------------------------
// Playback — native path
// ---------------------------------------------------------------------------

/**
 * Play through the cpal mixer when a native media session owns the call. The
 * webview decodes and resamples (no compressed-audio decoder exists natively);
 * the command paces 20 ms frames into the mixer and re-checks the shared
 * `deafened` flag per frame.
 */
async function playNative(sound: SoundboardSound, gain: number): Promise<void> {
  const engine = useVoiceStore.getState().mediaEngine;
  const ownerId = engine?.sessionOwnerId;
  if (!ownerId) throw new Error('no native media session');
  const pcm = await resampleTo48kStereo(sound);
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('voice_play_soundboard', {
    pcm: Array.from(pcm),
    gain,
    ownerId,
  });
}

/** True when the call's audio is owned by the native engine (cpal mixer). */
function nativePlaybackActive(): boolean {
  return isTauri() && Boolean(useVoiceStore.getState().mediaEngine?.sessionOwnerId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SoundboardPlayPayload {
  guild_id?: string;
  channel_id?: string;
  sound_id?: string;
  user_id?: string;
  sound?: SoundboardSound;
  at?: number;
}

/**
 * Local-only playback — the settings preview button and the popover's hover
 * preview. Gated on the soundboard toggle and deafen, never on channel
 * membership.
 */
export async function previewSoundboardSound(sound: SoundboardSound): Promise<void> {
  if (!soundboardEnabled()) return;
  const gain = soundboardGain(sound);
  if (gain <= 0) return;
  subscribeDeafen();
  if (nativePlaybackActive()) {
    await playNative(sound, gain);
    return;
  }
  const buffer = await decodeSound(sound);
  await playBuffer(buffer, gain);
}

/**
 * Handle a `SOUNDBOARD_PLAY` dispatch: the sound only plays while the listener
 * is still in that voice channel; the ripple mark is recorded regardless so
 * everyone in the call sees who played what (a deafened listener sees the
 * ripple without hearing the sound).
 */
export async function handleSoundboardPlay(payload: SoundboardPlayPayload): Promise<void> {
  const voice = useVoiceStore.getState();
  if (!voice.connected || !payload.channel_id || payload.channel_id !== voice.channelId) return;
  const sound = payload.sound;
  if (!sound) return;

  // The caller is a channel participant by server construction, so every tile
  // in this call can attribute the play.
  const { useSoundboardStore } = await import('../../stores/soundboardStore');
  useSoundboardStore.getState().recordPlay({
    channelId: payload.channel_id,
    userId: payload.user_id ?? '',
    emoji: sound.emoji ?? null,
    soundName: sound.name,
  });

  if (!soundboardEnabled() || voice.selfDeaf) return;
  const gain = soundboardGain(sound);
  if (gain <= 0) return;
  subscribeDeafen();
  try {
    if (nativePlaybackActive()) {
      await playNative(sound, gain);
    } else {
      const buffer = await decodeSound(sound);
      // Re-check: the listener may have left the channel while the clip decoded.
      const now = useVoiceStore.getState();
      if (!now.connected || now.channelId !== payload.channel_id || now.selfDeaf) return;
      await playBuffer(buffer, gain);
    }
  } catch (err) {
    console.warn('[soundboard] playback failed:', err);
  }
}
