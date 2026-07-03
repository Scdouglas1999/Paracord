import { useState, useEffect, useCallback } from 'react';
import { isTauri } from '../lib/tauriEnv';
import {
  listNativeInputDevices,
  listNativeOutputDevices,
  type AudioDeviceInfo,
} from '../stores/voice/nativeMediaController';

interface MediaDeviceState {
  audioInputDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  videoInputDevices: MediaDeviceInfo[];
  selectedAudioInput: string | null;
  selectedAudioOutput: string | null;
  selectedVideoInput: string | null;
}

/**
 * Adapt a native cpal device into the browser-facing `MediaDeviceInfo` shape.
 * The cpal host index becomes the `deviceId` so selection callbacks can hand it
 * straight back to the native switch commands, while the real OS name (which
 * the WebView often hides for `navigator.mediaDevices`) surfaces as the label.
 */
function nativeToMediaDeviceInfo(
  device: AudioDeviceInfo,
  kind: MediaDeviceKind
): MediaDeviceInfo {
  const deviceId = String(device.index);
  return {
    deviceId,
    kind,
    label: device.name,
    groupId: '',
    toJSON() {
      return { deviceId, kind, label: device.name, groupId: '' };
    },
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
        let videoInputDevices: MediaDeviceInfo[] = [];
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          videoInputDevices = devices.filter((d) => d.kind === 'videoinput');
        } catch {
          /* video enumeration unavailable — leave empty */
        }
        setState((s) => ({
          ...s,
          audioInputDevices: nativeInputs.map((d) => nativeToMediaDeviceInfo(d, 'audioinput')),
          audioOutputDevices: nativeOutputs.map((d) => nativeToMediaDeviceInfo(d, 'audiooutput')),
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
      // Always request mic permission first so browsers on non-secure
      // origins (plain HTTP) expose full device list with labels.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* user denied or already granted — either way, enumerate next */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setState((s) => ({
        ...s,
        audioInputDevices: devices.filter((d) => d.kind === 'audioinput'),
        audioOutputDevices: devices.filter((d) => d.kind === 'audiooutput'),
        videoInputDevices: devices.filter((d) => d.kind === 'videoinput'),
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
