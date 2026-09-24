import type { CallSession } from './callSession';
import { isTauri } from '../../lib/tauriEnv';

/**
 * Native (Tauri) audio-device routing for the QUIC media engine.
 *
 * The desktop backend enumerates through the sound server (PipeWire/PulseAudio
 * on Linux, WASAPI/CoreAudio elsewhere) and returns a **stable id** per device
 * — a sound-server node name, not an enumeration index — plus the name a person
 * would recognize. The WebView cannot drive those devices via `setSinkId` (that
 * only reaches the WebView's own audio graph), so when a native voice session is
 * active we must additionally route the OS device through the native commands.
 *
 * Every call here is runtime-resolved and degrades gracefully (empty list /
 * no-op) so web and older desktop builds keep working unchanged.
 */

/** Which picker group a device belongs to. */
export type NativeDeviceGroup = 'system-default' | 'device' | 'monitor';

/** Shape returned by the native `voice_list_*_devices` commands. */
export interface AudioDeviceInfo {
  /**
   * Stable device identity — a sound-server node name on Linux, the device name
   * on Windows/macOS, or `@default`. This is what gets persisted and handed back
   * to the switch commands; it survives a re-plug, which an index does not.
   */
  id: string;
  /** Human-readable device name from the sound server. */
  name: string;
  /** Secondary line: the profile, or what "System default" resolves to now. */
  detail?: string;
  /** Whether this is the OS default device, when the backend reports it. */
  is_default?: boolean;
  /** `monitor` rows are loopbacks of what is playing, never microphones. */
  group?: NativeDeviceGroup;
}

/** Reserved id meaning "follow the OS default", re-resolved at open time. */
export const NATIVE_SYSTEM_DEFAULT_ID = '@default';

/** A native device list plus which layer named it. */
export interface NativeDeviceList {
  devices: AudioDeviceInfo[];
  /** `sound-server` or `cpal`; `cpal` means raw driver names. */
  backend: string;
  /** Present when the names are degraded — surfaced, never silent. */
  warning?: string;
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Best-effort structured logging to the native client log; never throws. */
async function clientLog(line: string): Promise<void> {
  try {
    await tauriInvoke('append_client_log', { line });
  } catch {
    /* logging is non-fatal */
  }
}

function coerceDevices(value: unknown): AudioDeviceInfo[] {
  if (!Array.isArray(value)) return [];
  const devices: AudioDeviceInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string') continue;
    // `id` is the current shape; an older backend answered with a bare `index`,
    // which stays usable as an id because the switch commands still accept one.
    const rawId = record['id'];
    const rawIndex = record['index'];
    const id =
      typeof rawId === 'string' && rawId.trim()
        ? rawId
        : typeof rawIndex === 'number'
          ? String(rawIndex)
          : null;
    if (id === null) continue;
    const group = record['group'];
    devices.push({
      id,
      name,
      detail: typeof record['detail'] === 'string' ? record['detail'] : undefined,
      is_default: typeof record['is_default'] === 'boolean' ? record['is_default'] : undefined,
      group:
        group === 'system-default' || group === 'device' || group === 'monitor' ? group : undefined,
    });
  }
  return devices;
}

function coerceDeviceList(value: unknown): NativeDeviceList {
  // The current backend answers `{ devices, backend, warning }`; an older one
  // answered a bare array.
  if (Array.isArray(value)) {
    return { devices: coerceDevices(value), backend: 'cpal' };
  }
  if (!value || typeof value !== 'object') return { devices: [], backend: 'unknown' };
  const record = value as Record<string, unknown>;
  return {
    devices: coerceDevices(record['devices']),
    backend: typeof record['backend'] === 'string' ? record['backend'] : 'unknown',
    warning: typeof record['warning'] === 'string' ? record['warning'] : undefined,
  };
}

/** List native output devices, or an empty list when unavailable (web / older build). */
export async function listNativeOutputDeviceList(): Promise<NativeDeviceList> {
  if (!isTauri()) return { devices: [], backend: 'unavailable' };
  try {
    return coerceDeviceList(await tauriInvoke('voice_list_output_devices'));
  } catch {
    return { devices: [], backend: 'unavailable' };
  }
}

/** List native input devices, or an empty list when unavailable (web / older build). */
export async function listNativeInputDeviceList(): Promise<NativeDeviceList> {
  if (!isTauri()) return { devices: [], backend: 'unavailable' };
  try {
    return coerceDeviceList(await tauriInvoke('voice_list_input_devices'));
  } catch {
    return { devices: [], backend: 'unavailable' };
  }
}

/** List native output devices, or `[]` when unavailable (web / older build). */
export async function listNativeOutputDevices(): Promise<AudioDeviceInfo[]> {
  return (await listNativeOutputDeviceList()).devices;
}

/** List native input devices, or `[]` when unavailable (web / older build). */
export async function listNativeInputDevices(): Promise<AudioDeviceInfo[]> {
  return (await listNativeInputDeviceList()).devices;
}

/**
 * Resolve a selected device (a stable native id, a browser deviceId, a legacy
 * index string, or a device label) to the stable id the switch commands take.
 *
 * Matching order: exact id, then exact name, then case-insensitive name. An
 * unrecognized selection resolves to `@default`, which the backend re-resolves
 * to the live system default at open time and logs as a fallback — a device
 * that has gone away never silently becomes some other device.
 */
export function resolveNativeDeviceId(
  devices: AudioDeviceInfo[],
  selected: string | null | undefined
): string {
  const trimmed = (selected ?? '').trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === 'default' ||
    trimmed.toLowerCase() === 'communications'
  ) {
    return NATIVE_SYSTEM_DEFAULT_ID;
  }
  const byId = devices.find((d) => d.id === trimmed);
  if (byId) return byId.id;
  const byName = devices.find((d) => d.name === trimmed);
  if (byName) return byName.id;
  const lower = trimmed.toLowerCase();
  const byNameCi = devices.find((d) => d.name.toLowerCase() === lower);
  if (byNameCi) return byNameCi.id;
  // A legacy build persisted a bare cpal index. The backend still accepts one,
  // so pass it through rather than silently switching the user's device.
  if (/^\d+$/.test(trimmed)) return trimmed;
  return NATIVE_SYSTEM_DEFAULT_ID;
}

export async function switchNativeInputDevice(selected: string | null | undefined, owner: Pick<CallSession, 'id' | 'assertCurrent'>): Promise<void> {
  if (!isTauri()) return;
  const devices = await listNativeInputDevices();
  owner.assertCurrent();
  const id = resolveNativeDeviceId(devices, selected);
  try {
    await tauriInvoke('voice_switch_input_device', { deviceId: id, ownerId: owner.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void clientLog(`[voice] native voice_switch_input_device failed (id=${id}): ${message}`);
    throw err;
  }
}

/**
 * Route the native (cpal) output device to match the user's selection.
 *
 * Resolves the selected label/deviceId against the live native device list and
 * invokes `voice_switch_output_device` with the stable id. Any failure
 * (command unavailable on older builds, no active native session, cpal error)
 * is logged and swallowed — output routing must never break the call.
 */
export async function switchNativeOutputDevice(selected: string | null | undefined, owner: Pick<CallSession, 'id' | 'assertCurrent'>): Promise<void> {
  if (!isTauri()) return;
  const devices = await listNativeOutputDevices();
  owner.assertCurrent();
  const id = resolveNativeDeviceId(devices, selected);
  try {
    await tauriInvoke('voice_switch_output_device', { deviceId: id, ownerId: owner.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void clientLog(`[voice] native voice_switch_output_device failed (id=${id}): ${message}`);
  }
}
