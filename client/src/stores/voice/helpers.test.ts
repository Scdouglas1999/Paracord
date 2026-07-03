import { describe, expect, it } from 'vitest';
import { computeConnectRetryDelayMs, isTransientVoiceConnectError } from './reconnect';
import { computeSpeaking, isStallWarningInterval, smoothVolume } from './timers';
import { resolveNativeDeviceIndex, type AudioDeviceInfo } from './nativeMediaController';
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

describe('resolveNativeDeviceIndex', () => {
  const devices: AudioDeviceInfo[] = [
    { index: 0, name: 'Built-in Output', is_default: true },
    { index: 1, name: 'USB Headset' },
    { index: 2, name: 'HDMI Audio' },
  ];

  it('matches by native index string', () => {
    expect(resolveNativeDeviceIndex(devices, '2')).toBe('2');
  });

  it('matches by exact and case-insensitive name', () => {
    expect(resolveNativeDeviceIndex(devices, 'USB Headset')).toBe('1');
    expect(resolveNativeDeviceIndex(devices, 'hdmi audio')).toBe('2');
  });

  it('returns the default device for empty/default selection', () => {
    expect(resolveNativeDeviceIndex(devices, null)).toBe('0');
    expect(resolveNativeDeviceIndex(devices, 'default')).toBe('0');
  });

  it('falls back to index 0 when nothing matches', () => {
    expect(resolveNativeDeviceIndex(devices, 'nonexistent-device-id')).toBe('0');
  });
});
