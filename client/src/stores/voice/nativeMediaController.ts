import { isTauri } from '../../lib/tauriEnv';

/**
 * Native (Tauri / cpal) audio-device routing for the QUIC media engine.
 *
 * The desktop backend exposes cpal output/input devices by host index. The
 * WebView cannot drive those devices via `setSinkId` (that only reaches the
 * WebView's own audio graph), so when a native voice session is active we must
 * additionally route the OS output device through the native commands.
 *
 * The `voice_list_output_devices` command lands in a later wave; every call
 * here is runtime-resolved and degrades gracefully (empty list / no-op) until
 * it exists, so web and older desktop builds keep working unchanged.
 */

/** Shape returned by the native `voice_list_*_devices` commands. */
export interface AudioDeviceInfo {
  /** cpal host device index; passed back to switch commands as a string. */
  index: number;
  /** Human-readable device name from the OS. */
  name: string;
  /** Whether this is the OS default device, when the backend reports it. */
  is_default?: boolean;
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

function coerceDeviceList(value: unknown): AudioDeviceInfo[] {
  if (!Array.isArray(value)) return [];
  const devices: AudioDeviceInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const index = record['index'];
    const name = record['name'];
    if (typeof index !== 'number' || typeof name !== 'string') continue;
    devices.push({
      index,
      name,
      is_default: typeof record['is_default'] === 'boolean' ? record['is_default'] : undefined,
    });
  }
  return devices;
}

/** List native output devices, or `[]` when unavailable (web / older build). */
export async function listNativeOutputDevices(): Promise<AudioDeviceInfo[]> {
  if (!isTauri()) return [];
  try {
    return coerceDeviceList(await tauriInvoke('voice_list_output_devices'));
  } catch {
    return [];
  }
}

/** List native input devices, or `[]` when unavailable (web / older build). */
export async function listNativeInputDevices(): Promise<AudioDeviceInfo[]> {
  if (!isTauri()) return [];
  try {
    return coerceDeviceList(await tauriInvoke('voice_list_input_devices'));
  } catch {
    return [];
  }
}

/**
 * Resolve a selected output device (a browser deviceId, a native index string,
 * or a device label) to a native cpal index string.
 *
 * Matching order: exact index string, then exact name, then case-insensitive
 * name. Falls back to "0" (first/default device) when nothing matches so the
 * switch command still targets a valid device.
 */
export function resolveNativeDeviceIndex(
  devices: AudioDeviceInfo[],
  selected: string | null | undefined
): string {
  const trimmed = (selected ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'default') {
    const def = devices.find((d) => d.is_default);
    return String(def?.index ?? 0);
  }
  const byIndex = devices.find((d) => String(d.index) === trimmed);
  if (byIndex) return String(byIndex.index);
  const byName = devices.find((d) => d.name === trimmed);
  if (byName) return String(byName.index);
  const lower = trimmed.toLowerCase();
  const byNameCi = devices.find((d) => d.name.toLowerCase() === lower);
  if (byNameCi) return String(byNameCi.index);
  return '0';
}

/**
 * Route the native (cpal) output device to match the user's selection.
 *
 * Resolves the selected label/deviceId against the live native device list and
 * invokes `voice_switch_output_device` with the mapped index. Any failure
 * (command unavailable on older builds, no active native session, cpal error)
 * is logged and swallowed — output routing must never break the call.
 */
export async function switchNativeOutputDevice(selected: string | null | undefined): Promise<void> {
  if (!isTauri()) return;
  const devices = await listNativeOutputDevices();
  const index = resolveNativeDeviceIndex(devices, selected);
  try {
    await tauriInvoke('voice_switch_output_device', { deviceId: index });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void clientLog(`[voice] native voice_switch_output_device failed (index=${index}): ${message}`);
  }
}
