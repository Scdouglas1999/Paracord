/**
 * Shared audio/video device label cleanup for settings and in-call pickers.
 *
 * Desktop (cpal via Pulse/PipeWire/WASAPI) and browser `enumerateDevices()` both
 * surface noisy names: ALSA-style ids, "Monitor of …" loopbacks, null sinks,
 * duplicate endpoints, and browser pseudo-devices (`default` / `communications`).
 * This module turns those into a short, confident picker list while preserving
 * the original `deviceId` so saved settings keep working.
 */

export type MediaDeviceKindLike = 'audioinput' | 'audiooutput' | 'videoinput';

/** Minimal device shape accepted by the picker helpers. */
export interface RawMediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKindLike;
  groupId?: string;
  /** OS/browser default endpoint, when the enumerator reports it. */
  isDefault?: boolean;
}

/** One row ready to render in a `<select>` / menu. */
export interface DevicePickerOption {
  deviceId: string;
  /** Friendly label shown to the user. */
  label: string;
  /** Raw OS/browser label (for advanced views / debugging). */
  rawLabel: string;
  isSystemDefault: boolean;
  /** Hidden unless the user opts into "Show all devices". */
  isAdvanced: boolean;
}

export interface BuildDevicePickerOptionsArgs {
  /** Include virtual/monitor/null endpoints that are filtered by default. */
  showAll?: boolean;
  /**
   * Currently selected device id. Always kept in the list (even when advanced)
   * so a saved preference never disappears from the control.
   */
  selectedDeviceId?: string | null;
  /** Fallback noun when a device has no usable label (`Microphone`, etc.). */
  fallbackNoun?: string;
}

const BROWSER_PSEUDO_IDS = new Set(['default', 'communications', '']);

/** Suffixes Pulse/PipeWire append that rarely help users choose. */
const FRIENDLY_SUFFIXES = [
  /\s+analog stereo$/i,
  /\s+analog surround(?: \d\.\d)?$/i,
  /\s+digital stereo(?:\s*\([^)]*\))?$/i,
  /\s+iec958(?:\s*\([^)]*\))?$/i,
  /\s+pro$/i,
];

const ADVANCED_LABEL_PATTERNS: RegExp[] = [
  /\bmonitor of\b/i,
  /\bnull(\s+output|\s+sink|\s+input)?\b/i,
  /\bauto[_-]?null\b/i,
  /\beasy\s*effects?\b/i,
  /\bjames\s*dsp\b/i,
  /\bnoise\s*torch\b/i,
  /\bvirtual\b/i,
  /\bloopback\b/i,
  /\bremapped?\b/i,
  /\bdummy\b/i,
  /\bspeech[- ]?dispatcher\b/i,
];

const ADVANCED_ID_PATTERNS: RegExp[] = [
  /^auto_null$/i,
  /\.monitor$/i,
  /^null$/i,
  /loopback/i,
  /easyeffects/i,
  /jamesdsp/i,
  /noisetorch/i,
  /speech-dispatcher/i,
];

function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const KNOWN_ACRONYMS = new Set(['usb', 'hdmi', 'dac', 'hda', 'spdif', 'iec958', 'aux', 'mic']);

function titleCaseWords(value: string): string {
  return value
    .split(' ')
    .map((word) => {
      if (!word) return word;
      const lower = word.toLowerCase();
      if (KNOWN_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (/^[A-Z0-9]{2,}$/.test(word)) return word; // already-acronym tokens
      if (/^\d/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Turn ALSA/Pulse-style node ids into something a human can read.
 * e.g. `alsa_output.usb-Focusrite_Scarlett_Solo_USB-00.analog-stereo`
 *   → `Focusrite Scarlett Solo USB`
 */
function humanizeTechnicalId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^(alsa|bluez)_(output|input)\./i.test(trimmed) && !/^hdmi[_-]/i.test(trimmed)) {
    return null;
  }

  const isPci = /\.pci-/i.test(trimmed) || /^pci-/i.test(trimmed);
  const isHdmi = /hdmi/i.test(trimmed);
  const isBluez = /^bluez_/i.test(trimmed);

  let rest = trimmed
    .replace(/^(alsa|bluez)_(output|input)\./i, '')
    .replace(/^usb-/i, '')
    .replace(/^pci-/i, '')
    .replace(/^hdmi[_-]?/i, 'HDMI ');

  // Drop trailing profile / channel layout segments.
  rest = rest.replace(
    /\.(?:analog-stereo|analog-surround(?:-\d-\d)?|iec958(?:-[a-z0-9-]+)?|hdmi(?:-[a-z0-9-]+)?|pro)$/i,
    ''
  );
  // Drop trailing USB interface index (`-00`).
  rest = rest.replace(/-[0-9a-f]{2}$/i, '');
  // PCI bus addresses are not useful in a picker.
  rest = rest.replace(/^[0-9a-f]+_[0-9a-f]+_[0-9a-f]+(?:\.[0-9a-f]+)?\.?/i, '');

  rest = rest.replace(/[._]+/g, ' ');
  rest = collapseWs(rest);

  // Bare PCI endpoints have no product string — give a stable generic name.
  if (!rest || /^[0-9a-f.\s]+$/i.test(rest)) {
    if (isHdmi) return 'HDMI Audio';
    if (isPci) return 'Built-in Audio';
    if (isBluez) return 'Bluetooth Audio';
    return null;
  }
  return titleCaseWords(rest);
}

function stripFriendlySuffixes(label: string): string {
  let next = label;
  for (const pattern of FRIENDLY_SUFFIXES) {
    next = next.replace(pattern, '');
  }
  return collapseWs(next) || label;
}

/** Whether this id is a browser-only pseudo device (covered by "System default"). */
export function isBrowserPseudoDeviceId(deviceId: string): boolean {
  return BROWSER_PSEUDO_IDS.has(deviceId.trim().toLowerCase());
}

/**
 * Produce a short, human-readable label from a raw OS/browser device name.
 * Does not change the underlying device id.
 */
export function friendlyDeviceLabel(
  rawLabel: string,
  kind: MediaDeviceKindLike,
  deviceId = ''
): string {
  const raw = collapseWs(rawLabel);
  if (!raw || /^default$/i.test(raw) || /^communications$/i.test(raw)) {
    if (kind === 'audioinput') return 'System default microphone';
    if (kind === 'audiooutput') return 'System default speaker';
    return 'System default camera';
  }

  const fromId = humanizeTechnicalId(raw);
  let label = fromId ?? raw;

  // Keep monitors distinguishable from the real device so they don't collapse
  // during dedupe — still marked advanced by `isAdvancedMediaDevice`.
  const isMonitor = /^monitor of\s+/i.test(label);
  if (isMonitor) {
    const base = stripFriendlySuffixes(label.replace(/^monitor of\s+/i, ''));
    label = `${base || 'Device'} (monitor)`;
  } else if (!fromId) {
    label = stripFriendlySuffixes(label);
  }

  // Browser sometimes returns empty labels until permission is granted.
  if (!label) {
    const short = deviceId.slice(0, 6);
    if (kind === 'audioinput') return short ? `Microphone ${short}` : 'Microphone';
    if (kind === 'audiooutput') return short ? `Speaker ${short}` : 'Speaker';
    return short ? `Camera ${short}` : 'Camera';
  }

  return label;
}

/** True when the device is usually noise in a consumer picker (virtual/monitor/null). */
export function isAdvancedMediaDevice(device: RawMediaDevice): boolean {
  const id = device.deviceId.trim();
  const label = device.label.trim();
  if (isBrowserPseudoDeviceId(id)) return false;

  if (ADVANCED_ID_PATTERNS.some((re) => re.test(id) || re.test(label))) {
    return true;
  }
  if (ADVANCED_LABEL_PATTERNS.some((re) => re.test(label))) {
    return true;
  }
  // Technical ALSA ids that still look like monitor/null after humanize stay advanced
  // via the patterns above; plain hardware ids are not advanced.
  return false;
}

function normalizeDedupKey(label: string): string {
  return collapseWs(label)
    .toLowerCase()
    .replace(/[()[\]]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Build the options list for a device `<select>`.
 *
 * - Drops browser pseudo-ids (`default` / `communications`) — use an empty-value
 *   "System default" option in the UI instead.
 * - Prefers friendly labels; dedupes equivalent names (keeps OS default, else first).
 * - Marks virtual/monitor/null devices as advanced (hidden unless `showAll`).
 * - Always retains `selectedDeviceId` so saved settings remain selectable.
 */
export function buildDevicePickerOptions(
  devices: RawMediaDevice[],
  args: BuildDevicePickerOptionsArgs = {}
): DevicePickerOption[] {
  const showAll = Boolean(args.showAll);
  const selected = (args.selectedDeviceId ?? '').trim();
  const fallbackNoun = args.fallbackNoun ?? 'Device';

  const prepared: DevicePickerOption[] = [];
  for (const device of devices) {
    if (isBrowserPseudoDeviceId(device.deviceId)) continue;

    const rawLabel = collapseWs(device.label) || `${fallbackNoun} ${device.deviceId.slice(0, 6)}`;
    const label = friendlyDeviceLabel(rawLabel, device.kind, device.deviceId);
    const isAdvanced = isAdvancedMediaDevice(device);
    prepared.push({
      deviceId: device.deviceId,
      label,
      rawLabel,
      isSystemDefault: Boolean(device.isDefault),
      isAdvanced,
    });
  }

  // Deduplicate by friendly label. Prefer the OS default, then the currently
  // selected id, then the first occurrence — never drop the selection.
  const byKey = new Map<string, DevicePickerOption>();
  for (const option of prepared) {
    const key = normalizeDedupKey(option.label);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, option);
      continue;
    }
    const preferNew =
      (option.isSystemDefault && !existing.isSystemDefault) ||
      (option.deviceId === selected && existing.deviceId !== selected) ||
      (!existing.isSystemDefault && !option.isAdvanced && existing.isAdvanced);
    if (preferNew) {
      byKey.set(key, option);
    }
  }

  let options = Array.from(byKey.values());

  // Stable order: system default first, then alpha by label.
  options.sort((a, b) => {
    if (a.isSystemDefault !== b.isSystemDefault) return a.isSystemDefault ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });

  if (!showAll) {
    const selectedOption = options.find((o) => o.deviceId === selected);
    options = options.filter((o) => !o.isAdvanced || o.deviceId === selected);
    // If the selection was filtered out of `byKey` somehow, re-attach it.
    if (selected && selectedOption && !options.some((o) => o.deviceId === selected)) {
      options.push(selectedOption);
    }
  }

  // Ensure a saved selection that lost the dedup race still appears.
  if (selected && !isBrowserPseudoDeviceId(selected) && !options.some((o) => o.deviceId === selected)) {
    const raw = prepared.find((o) => o.deviceId === selected);
    if (raw) {
      options.push(raw);
    } else {
      const match = devices.find((d) => d.deviceId === selected);
      if (match) {
        options.push({
          deviceId: match.deviceId,
          label: friendlyDeviceLabel(match.label, match.kind, match.deviceId),
          rawLabel: match.label,
          isSystemDefault: Boolean(match.isDefault),
          isAdvanced: isAdvancedMediaDevice(match),
        });
      }
    }
  }

  return options;
}

/** Label for the empty-value "follow the OS" row. */
export function systemDefaultOptionLabel(kind: MediaDeviceKindLike): string {
  if (kind === 'audioinput') return 'System default';
  if (kind === 'audiooutput') return 'System default';
  return 'System default';
}
