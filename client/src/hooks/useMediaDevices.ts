import { useState, useEffect, useCallback } from 'react';
import { isTauri } from '../lib/tauriEnv';
import {
  listNativeInputDevices,
  listNativeOutputDevices,
  type AudioDeviceInfo,
} from '../stores/voice/nativeMediaController';

export interface ListedMediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId: string;
  /** OS/browser default endpoint when the enumerator reports it. */
  isDefault?: boolean;
}

interface MediaDeviceState {
  audioInputDevices: ListedMediaDevice[];
  audioOutputDevices: ListedMediaDevice[];
  videoInputDevices: ListedMediaDevice[];
  selectedAudioInput: string | null;
  selectedAudioOutput: string | null;
  selectedVideoInput: string | null;
}

/**
 * Adapt a native cpal device into the picker-facing device shape.
 * The cpal host index becomes the `deviceId` so selection callbacks can hand it
 * straight back to the native switch commands, while the real OS name (which
 * the WebView often hides for `navigator.mediaDevices`) surfaces as the label.
 */
function nativeToListedDevice(
  device: AudioDeviceInfo,
  kind: MediaDeviceKind
): ListedMediaDevice {
  return {
    deviceId: String(device.index),
    kind,
    label: device.name,
    groupId: '',
    isDefault: Boolean(device.is_default),
  };
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
  });

  const enumerate = useCallback(async () => {
    // On the desktop client the WebView frequently returns only a single
    // unlabeled "default" audio device, so prefer the native cpal enumeration
    // for real device names. Video and the web build keep using the browser
    // enumeration path.
    if (isTauri()) {
      const [nativeInputs, nativeOutputs] = await Promise.all([
        listNativeInputDevices(),
        listNativeOutputDevices(),
      ]);
      if (nativeInputs.length > 0 || nativeOutputs.length > 0) {
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
          audioInputDevices: nativeInputs.map((d) => nativeToListedDevice(d, 'audioinput')),
          audioOutputDevices: nativeOutputs.map((d) => nativeToListedDevice(d, 'audiooutput')),
          videoInputDevices,
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
