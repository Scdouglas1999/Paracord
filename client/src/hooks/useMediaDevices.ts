import { useState, useEffect, useCallback } from 'react';
import { isTauri } from '../lib/tauriEnv';
import {
  listNativeInputDeviceList,
  listNativeOutputDeviceList,
  type AudioDeviceInfo,
  type NativeDeviceList,
} from '../stores/voice/nativeMediaController';

export interface ListedMediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId: string;
  /** OS/browser default endpoint when the enumerator reports it. */
  isDefault?: boolean;
  /**
   * The label already came from the sound server and is a real device name —
   * the picker must show it verbatim rather than running the ALSA/browser
   * label cleanup over it (which would eat parts like "Digital Stereo (HDMI)").
   */
  labelIsFriendly?: boolean;
}

interface MediaDeviceState {
  audioInputDevices: ListedMediaDevice[];
  audioOutputDevices: ListedMediaDevice[];
  videoInputDevices: ListedMediaDevice[];
  selectedAudioInput: string | null;
  selectedAudioOutput: string | null;
  selectedVideoInput: string | null;
  /** What "System default" currently resolves to, when the OS will say. */
  defaultAudioInputLabel: string | null;
  defaultAudioOutputLabel: string | null;
  /**
   * Set when the device names are degraded (no sound server answered, so these
   * are raw driver names). Shown to the user — never silently degraded.
   */
  deviceNamingWarning: string | null;
}

/**
 * Adapt a native device into the picker-facing device shape.
 *
 * The backend's **stable id** (a sound-server node name) becomes the
 * `deviceId`, so the selection that gets persisted survives a re-plug and an
 * enumeration-order change. The label is the device name the sound server
 * already knows — the thing the WebView hides behind an empty
 * `navigator.mediaDevices` label — with the profile appended when there is one.
 */
function nativeToListedDevice(
  device: AudioDeviceInfo,
  kind: MediaDeviceKind
): ListedMediaDevice {
  return {
    deviceId: device.id,
    kind,
    label: device.detail ? `${device.name} — ${device.detail}` : device.name,
    groupId: '',
    isDefault: Boolean(device.is_default),
    labelIsFriendly: true,
  };
}

/** The "System default" row is rendered by the picker itself, not as a device. */
function nativeSelectableDevices(
  list: NativeDeviceList,
  kind: MediaDeviceKind
): ListedMediaDevice[] {
  return list.devices
    .filter((device) => device.group !== 'system-default')
    .map((device) => nativeToListedDevice(device, kind));
}

function nativeDefaultLabel(list: NativeDeviceList): string | null {
  const row = list.devices.find((device) => device.group === 'system-default');
  if (!row) return null;
  // The backend spells this "Currently: <device>".
  const detail = row.detail?.replace(/^currently:\s*/i, '').trim();
  return detail || null;
}

function fromBrowserDevice(device: MediaDeviceInfo): ListedMediaDevice {
  const idLower = device.deviceId.trim().toLowerCase();
  return {
    deviceId: device.deviceId,
    kind: device.kind,
    label: device.label,
    groupId: device.groupId,
    // Chromium exposes a pseudo "default" entry; treat it as the OS default.
    isDefault: idLower === 'default' || idLower === 'communications',
  };
}

export function useMediaDevices() {
  const [state, setState] = useState<MediaDeviceState>({
    audioInputDevices: [],
    audioOutputDevices: [],
    videoInputDevices: [],
    selectedAudioInput: null,
    selectedAudioOutput: null,
    selectedVideoInput: null,
    defaultAudioInputLabel: null,
    defaultAudioOutputLabel: null,
    deviceNamingWarning: null,
  });

  const enumerate = useCallback(async () => {
    // On the desktop client the WebView frequently returns only a single
    // unlabeled "default" audio device, so prefer the native cpal enumeration
    // for real device names. Video and the web build keep using the browser
    // enumeration path.
    if (isTauri()) {
      const [nativeInputs, nativeOutputs] = await Promise.all([
        listNativeInputDeviceList(),
        listNativeOutputDeviceList(),
      ]);
      if (nativeInputs.devices.length > 0 || nativeOutputs.devices.length > 0) {
        let videoInputDevices: ListedMediaDevice[] = [];
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          videoInputDevices = devices
            .filter((d) => d.kind === 'videoinput')
            .map(fromBrowserDevice);
        } catch {
          /* video enumeration unavailable — leave empty */
        }
        setState((s) => ({
          ...s,
          audioInputDevices: nativeSelectableDevices(nativeInputs, 'audioinput'),
          audioOutputDevices: nativeSelectableDevices(nativeOutputs, 'audiooutput'),
          videoInputDevices,
          defaultAudioInputLabel: nativeDefaultLabel(nativeInputs),
          defaultAudioOutputLabel: nativeDefaultLabel(nativeOutputs),
          deviceNamingWarning: nativeInputs.warning ?? nativeOutputs.warning ?? null,
        }));
        return;
      }
      // Native commands unavailable (older desktop build) — fall through to
      // browser enumeration so device selection still works.
    }

    try {
      // On non-secure origins (plain HTTP), browsers hide device labels
      // and may only return "default" until mic permission is granted.
      // Request a temporary stream to trigger the permission prompt,
      // then immediately stop it before enumerating.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* user denied or already granted — either way, enumerate next */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setState((s) => ({
        ...s,
        audioInputDevices: devices.filter((d) => d.kind === 'audioinput').map(fromBrowserDevice),
        audioOutputDevices: devices.filter((d) => d.kind === 'audiooutput').map(fromBrowserDevice),
        videoInputDevices: devices.filter((d) => d.kind === 'videoinput').map(fromBrowserDevice),
      }));
    } catch {
      /* permission denied or unsupported */
    }
  }, []);

  useEffect(() => {
    enumerate();
    navigator.mediaDevices?.addEventListener('devicechange', enumerate);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', enumerate);
    };
  }, [enumerate]);

  const selectAudioInput = useCallback((deviceId: string) => {
    setState((s) => ({ ...s, selectedAudioInput: deviceId }));
  }, []);

  const selectAudioOutput = useCallback((deviceId: string) => {
    setState((s) => ({ ...s, selectedAudioOutput: deviceId }));
  }, []);

  const selectVideoInput = useCallback((deviceId: string) => {
    setState((s) => ({ ...s, selectedVideoInput: deviceId }));
  }, []);

  return {
    ...state,
    enumerate,
    selectAudioInput,
    selectAudioOutput,
    selectVideoInput,
  };
}
