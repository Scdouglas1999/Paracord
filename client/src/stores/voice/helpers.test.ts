import { describe, expect, it } from 'vitest';
import { computeConnectRetryDelayMs, isTransientVoiceConnectError } from './reconnect';
import { computeSpeaking, isStallWarningInterval, smoothVolume } from './timers';
import {
  resolveNativeDeviceId,
  NATIVE_SYSTEM_DEFAULT_ID,
  type AudioDeviceInfo,
} from './nativeMediaController';
import {
  isLoopbackHostname,
  isLivekitProxyPath,
  isPrivateIpv4Hostname,
  normalizeLivekitUrlFromServerValue,
  preferDirectLivekitCandidates,
} from './livekitController';

describe('reconnect helpers', () => {
  it('flags only page-lifecycle / aborted errors as transient', () => {
    expect(isTransientVoiceConnectError('The operation was aborted')).toBe(true);
    expect(isTransientVoiceConnectError('Fetch interrupted while the page was loading')).toBe(true);
    expect(isTransientVoiceConnectError('WebSocket connection failed')).toBe(false);
    expect(isTransientVoiceConnectError('ERR_CONNECTION_REFUSED')).toBe(false);
  });

  it('computes linear backoff and clamps bad inputs', () => {
    expect(computeConnectRetryDelayMs(0, 250)).toBe(250);
    expect(computeConnectRetryDelayMs(1, 250)).toBe(500);
    expect(computeConnectRetryDelayMs(3, 400)).toBe(1600);
    expect(computeConnectRetryDelayMs(-5, 250)).toBe(250);
    expect(computeConnectRetryDelayMs(2, -1)).toBe(0);
  });
});

describe('timer helpers', () => {
  it('smooths volume with an EMA and rejects non-finite input', () => {
    expect(smoothVolume(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothVolume(0.4, 0.4, 0.55)).toBeCloseTo(0.4);
    expect(smoothVolume(Number.NaN, 0.5, 0.5)).toBeCloseTo(0.25);
  });

  it('applies hysteresis around the on/off thresholds', () => {
    const base = { onThreshold: 0.055, offThreshold: 0.03, locallyMuted: false };
    // Below on-threshold while quiet: stays quiet.
    expect(computeSpeaking({ ...base, smoothedVolume: 0.04, wasSpeaking: false })).toBe(false);
    // Crosses on-threshold: becomes speaking.
    expect(computeSpeaking({ ...base, smoothedVolume: 0.06, wasSpeaking: false })).toBe(true);
    // Between thresholds while already speaking: stays speaking.
    expect(computeSpeaking({ ...base, smoothedVolume: 0.04, wasSpeaking: true })).toBe(true);
    // Drops below off-threshold: stops.
    expect(computeSpeaking({ ...base, smoothedVolume: 0.02, wasSpeaking: true })).toBe(false);
    // Muted always wins.
    expect(
      computeSpeaking({ ...base, locallyMuted: true, smoothedVolume: 1, wasSpeaking: true })
    ).toBe(false);
  });

  it('warns only on the 2/4/6 stall intervals', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(isStallWarningInterval)).toEqual([
      false, false, true, false, true, false, true, false,
    ]);
  });
});

describe('livekit url helpers', () => {
  it('classifies loopback, private, and proxy paths', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('app.localhost')).toBe(true);
    expect(isLoopbackHostname('example.com')).toBe(false);
    expect(isPrivateIpv4Hostname('192.168.1.4')).toBe(true);
    expect(isPrivateIpv4Hostname('8.8.8.8')).toBe(false);
    expect(isLivekitProxyPath('/livekit')).toBe(true);
    expect(isLivekitProxyPath('/rtc')).toBe(false);
  });

  it('normalizes http(s) internal hosts to ws(s) proxy urls', () => {
    expect(normalizeLivekitUrlFromServerValue('https://example.com/livekit')).toBe(
      'wss://example.com/livekit'
    );
    expect(normalizeLivekitUrlFromServerValue('http://example.com/livekit/')).toBe(
      'ws://example.com/livekit'
    );
  });

  it('orders proxied candidates ahead of direct ones by default', () => {
    const ordered = preferDirectLivekitCandidates([
      'wss://example.com:7880',
      'wss://example.com/livekit',
    ]);
    expect(ordered[0]).toBe('wss://example.com/livekit');
  });
});

describe('resolveNativeDeviceId', () => {
  const devices: AudioDeviceInfo[] = [
    { id: '@default', name: 'System default', is_default: true, group: 'system-default' },
    {
      id: 'alsa_input.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__source',
      name: 'Scarlett Solo USB',
      detail: 'Direct',
      group: 'device',
    },
    { id: 'alsa_output.pci-0000_01_00.1.hdmi-stereo', name: 'Odyssey G95SC', group: 'device' },
  ];

  it('matches by stable id', () => {
    expect(resolveNativeDeviceId(devices, 'alsa_output.pci-0000_01_00.1.hdmi-stereo')).toBe(
      'alsa_output.pci-0000_01_00.1.hdmi-stereo'
    );
  });

  it('matches by exact and case-insensitive name', () => {
    expect(resolveNativeDeviceId(devices, 'Scarlett Solo USB')).toBe(
      'alsa_input.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__source'
    );
    expect(resolveNativeDeviceId(devices, 'odyssey g95sc')).toBe(
      'alsa_output.pci-0000_01_00.1.hdmi-stereo'
    );
  });

  it('returns the system default for empty/default selection', () => {
    expect(resolveNativeDeviceId(devices, null)).toBe(NATIVE_SYSTEM_DEFAULT_ID);
    expect(resolveNativeDeviceId(devices, 'default')).toBe(NATIVE_SYSTEM_DEFAULT_ID);
  });

  it('passes a legacy saved index straight through rather than guessing', () => {
    expect(resolveNativeDeviceId(devices, '2')).toBe('2');
  });

  it('falls back to the system default when nothing matches', () => {
    expect(resolveNativeDeviceId(devices, 'nonexistent-device-id')).toBe(
      NATIVE_SYSTEM_DEFAULT_ID
    );
  });
});
