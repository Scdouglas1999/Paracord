import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  STEP_ORDER,
  checkPlatform,
  checkSecureContext,
  classifyMediaError,
  runVoiceConnectionCheck,
} from './runner';
import type {
  DiagnosticsAdapters,
  DiagnosticDevice,
  MicrophoneMeasurement,
  TransportProbeOutcome,
} from './adapters';
import type { DiagnosticEnvironmentFacts, DiagnosticStepResult, MediaTransportConfig } from './types';

function env(overrides: Partial<DiagnosticEnvironmentFacts> = {}): DiagnosticEnvironmentFacts {
  return {
    engine: 'browser',
    isSecureContext: true,
    protocol: 'https:',
    host: 'chat.example.com',
    userAgent: 'Mozilla/5.0 Chrome/130.0.0.0',
    language: 'en-GB',
    ...overrides,
  };
}

function nativeConfig(overrides: Partial<MediaTransportConfig> = {}): MediaTransportConfig {
  return {
    transport: 'native',
    voiceAvailable: true,
    mediaEndpoint: 'https://chat.example.com:8443/media',
    mediaEndpointCandidates: ['https://chat.example.com:8443/media'],
    mediaUdpPort: 8443,
    // 32 zero bytes, base64.
    certificatePinSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    certificateSource: 'server-generated-self-signed',
    livekitAvailable: false,
    e2eeRequired: true,
    maxParticipants: 50,
    ...overrides,
  };
}

const DEVICES: DiagnosticDevice[] = [
  { deviceId: 'mic-1', kind: 'audioinput', label: 'Headset mic' },
  { deviceId: 'out-1', kind: 'audiooutput', label: 'Headset' },
  { deviceId: 'cam-1', kind: 'videoinput', label: 'Webcam' },
];

interface FakeOptions {
  environment?: Partial<DiagnosticEnvironmentFacts>;
  capabilities?: Partial<{
    webTransport: boolean;
    certificatePinning: boolean;
    mediaDevices: boolean;
    audioWorklet: boolean;
    opus: boolean;
    vp9: boolean;
  }>;
  permission?: 'granted' | 'denied' | 'prompt' | 'unknown';
  devices?: DiagnosticDevice[];
  measurement?: Partial<MicrophoneMeasurement> | Error;
  tone?: { routedToSelectedDevice: boolean } | Error;
  heardTone?: boolean;
  withAsk?: boolean;
  camera?: { label: string | null } | Error;
  config?: MediaTransportConfig | Error;
  probe?: Partial<TransportProbeOutcome>;
}

function fakeAdapters(options: FakeOptions = {}): DiagnosticsAdapters {
  const caps = {
    webTransport: true,
    certificatePinning: true,
    mediaDevices: true,
    audioWorklet: true,
    opus: true,
    vp9: true,
    ...options.capabilities,
  };
  let tick = 0;
  return {
    environment: { read: () => env(options.environment) },
    capabilities: {
      hasWebTransport: () => caps.webTransport,
      supportsCertificatePinning: () => caps.certificatePinning,
      hasMediaDevices: () => caps.mediaDevices,
      hasAudioWorklet: () => caps.audioWorklet,
      supportsOpus: async () => caps.opus,
      supportsVp9: async () => caps.vp9,
    },
    devices: {
      permission: async () => options.permission ?? 'granted',
      enumerate: async () => options.devices ?? DEVICES,
      measureMicrophone: async (request) => {
        if (options.measurement instanceof Error) throw options.measurement;
        request.onLevel?.(0.4);
        return {
          peak: 0.55,
          rms: 0.21,
          sampledMs: request.durationMs,
          deviceLabel: 'Headset mic',
          ...options.measurement,
        };
      },
      playTestTone: async () => {
        if (options.tone instanceof Error) throw options.tone;
        return options.tone ?? { routedToSelectedDevice: true };
      },
      openCamera: async () => {
        if (options.camera instanceof Error) throw options.camera;
        return options.camera ?? { label: 'Webcam' };
      },
    },
    server: {
      fetchTransportConfig: async () => {
        if (options.config instanceof Error) throw options.config;
        return options.config ?? nativeConfig();
      },
    },
    transport: {
      probe: async () => ({
        ok: true,
        rttMs: 23,
        streamOpened: true,
        failure: null,
        detail: null,
        ...options.probe,
      }),
    },
    now: () => (tick += 5),
    ask: options.withAsk === false ? undefined : async () => options.heardTone ?? true,
  };
}

function byId(steps: DiagnosticStepResult[], id: string): DiagnosticStepResult {
  const step = steps.find((entry) => entry.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

describe('checkSecureContext', () => {
  it('passes on a secure browser origin', () => {
    const outcome = checkSecureContext(env());
    expect(outcome.status).toBe('pass');
    expect(outcome.code).toBe('SECURE_CONTEXT_OK');
  });

  it('fails on an insecure origin and names the address', () => {
    const outcome = checkSecureContext(env({ isSecureContext: false, protocol: 'http:', host: 'box.lan:8090' }));
    expect(outcome.status).toBe('fail');
    expect(outcome.code).toBe('SECURE_CONTEXT_INSECURE');
    expect(outcome.summary).toContain('http://box.lan:8090');
    expect(outcome.remedy).toContain('https://');
  });

  it('does not require a secure web origin on the desktop app', () => {
    const outcome = checkSecureContext(env({ engine: 'desktop', isSecureContext: false }));
    expect(outcome.status).toBe('pass');
  });
});

describe('checkPlatform', () => {
  const facts = { webTransport: true, mediaDevices: true, audioWorklet: true, opus: true, vp9: true };

  it('passes when the browser has everything', () => {
    expect(checkPlatform(env(), facts).code).toBe('PLATFORM_OK');
  });

  it('fails without WebTransport', () => {
    const outcome = checkPlatform(env(), { ...facts, webTransport: false });
    expect(outcome.status).toBe('fail');
    expect(outcome.code).toBe('PLATFORM_NO_WEBTRANSPORT');
  });

  it('fails without a media device API', () => {
    expect(checkPlatform(env(), { ...facts, mediaDevices: false }).code).toBe('PLATFORM_NO_MEDIA_DEVICES');
  });

  it('fails without Opus', () => {
    expect(checkPlatform(env(), { ...facts, opus: false }).code).toBe('PLATFORM_NO_OPUS');
  });

  it('warns rather than fails without AudioWorklet', () => {
    const outcome = checkPlatform(env(), { ...facts, audioWorklet: false });
    expect(outcome.status).toBe('warn');
    expect(outcome.code).toBe('PLATFORM_NO_AUDIO_WORKLET');
  });

  it('warns rather than fails without VP9, because voice still works', () => {
    const outcome = checkPlatform(env(), { ...facts, vp9: false });
    expect(outcome.status).toBe('warn');
    expect(outcome.code).toBe('PLATFORM_NO_VP9');
  });

  it('does not judge the desktop app by browser codecs', () => {
    const outcome = checkPlatform(env({ engine: 'desktop' }), { ...facts, vp9: false, opus: false, webTransport: false });
    expect(outcome.status).toBe('pass');
  });
});

describe('classifyMediaError', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['OverconstrainedError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['AbortError', 'in-use'],
    ['WeirdError', 'failed'],
  ])('maps %s', (name, expected) => {
    const error = new Error('boom');
    error.name = name;
    expect(classifyMediaError(error)).toBe(expected);
  });
});

describe('runVoiceConnectionCheck', () => {
  it('passes every step on a healthy native server', async () => {
    const report = await runVoiceConnectionCheck({ adapters: fakeAdapters() });
    expect(report.overall).toBe('pass');
    expect(byId(report.steps, 'transport').code).toBe('TRANSPORT_OK');
    expect(byId(report.steps, 'transport').summary).toContain('23 ms');
    expect(byId(report.steps, 'certificate').code).toBe('CERTIFICATE_PINNED');
    expect(byId(report.steps, 'media-configuration').code).toBe('MEDIA_CONFIG_NATIVE');
    expect(byId(report.steps, 'camera').status).toBe('skipped');
  });

  it('reports every step in a stable order and emits progress for each', async () => {
    const progress: DiagnosticStepResult[][] = [];
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters(),
      onProgress: (steps) => progress.push(steps),
    });
    expect(report.steps.map((step) => step.id)).toEqual(STEP_ORDER);
    // One initial emit, then a running and a settled emit per step.
    expect(progress.length).toBe(1 + STEP_ORDER.length * 2);
    expect(progress[1][0].status).toBe('running');
  });

  it('reports a blocked UDP path as a transport timeout naming the port', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({
        probe: { ok: false, rttMs: null, streamOpened: false, failure: 'timeout', detail: 'No reply' },
      }),
    });
    const transport = byId(report.steps, 'transport');
    expect(report.overall).toBe('fail');
    expect(transport.status).toBe('fail');
    expect(transport.code).toBe('TRANSPORT_TIMEOUT');
    expect(transport.summary).toContain('Chat works because it uses TCP');
    expect(transport.remedy).toContain('UDP port 8443');
    expect(transport.detail.timeout_ms).toBe(DEFAULT_TRANSPORT_TIMEOUT_MS);
    // Everything before the transport still reports its own truth.
    expect(byId(report.steps, 'microphone').status).toBe('pass');
  });

  it('names the media certificate when a pinned handshake fails, not only the port', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({
        probe: { ok: false, rttMs: null, streamOpened: false, failure: 'handshake-failed', detail: 'Opening handshake failed.' },
      }),
    });
    const transport = byId(report.steps, 'transport');
    expect(transport.code).toBe('TRANSPORT_HANDSHAKE_FAILED');
    expect(transport.remedy).toContain('14 days or less');
    expect(transport.remedy).toContain('UDP port 8443');
  });

  it('does not blame a certificate when the server published no fingerprint to pin', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({
        config: nativeConfig({ certificatePinSha256: null }),
        probe: { ok: false, rttMs: null, streamOpened: false, failure: 'handshake-failed', detail: 'x' },
      }),
    });
    // With no fingerprint the certificate step already failed, so the transport
    // step never runs and cannot invent a cause.
    expect(byId(report.steps, 'transport').status).toBe('skipped');
  });

  it.each([
    ['unreachable', 'TRANSPORT_UNREACHABLE'],
    ['certificate-refused', 'TRANSPORT_CERTIFICATE_REFUSED'],
    ['handshake-failed', 'TRANSPORT_HANDSHAKE_FAILED'],
    ['closed-early', 'TRANSPORT_CLOSED_EARLY'],
    ['unknown', 'TRANSPORT_FAILED'],
  ] as const)('maps a %s transport failure to %s', async (failure, code) => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ probe: { ok: false, rttMs: null, streamOpened: false, failure, detail: 'x' } }),
    });
    const transport = byId(report.steps, 'transport');
    expect(transport.status).toBe('fail');
    expect(transport.code).toBe(code);
    expect(transport.remedy).not.toBe('');
  });

  it('explains rather than fails when the desktop app cannot probe without joining', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({
        environment: { engine: 'desktop' },
        probe: { ok: false, rttMs: null, streamOpened: false, failure: 'unsupported', detail: 'no WebTransport' },
      }),
    });
    const transport = byId(report.steps, 'transport');
    expect(transport.status).toBe('skipped');
    expect(transport.code).toBe('TRANSPORT_UNSUPPORTED');
    expect(transport.summary).toContain('native QUIC stack');
    expect(report.overall).toBe('pass');
  });

  it('stops at the secure context and skips what depends on it', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ environment: { isSecureContext: false, protocol: 'http:', host: 'box.lan:8090' } }),
      includeCamera: true,
    });
    expect(byId(report.steps, 'secure-context').status).toBe('fail');
    expect(byId(report.steps, 'microphone').status).toBe('skipped');
    expect(byId(report.steps, 'microphone').code).toBe('SKIPPED_PREREQUISITE');
    expect(byId(report.steps, 'camera').code).toBe('SKIPPED_PREREQUISITE');
    expect(byId(report.steps, 'transport').status).toBe('skipped');
    expect(report.overall).toBe('fail');
  });

  it('reports a denied microphone without prompting', async () => {
    const measure = vi.fn();
    const adapters = fakeAdapters({ permission: 'denied' });
    adapters.devices.measureMicrophone = measure;
    const report = await runVoiceConnectionCheck({ adapters });
    const mic = byId(report.steps, 'microphone');
    expect(mic.code).toBe('MIC_DENIED');
    expect(mic.remedy).toContain('allow the microphone');
    expect(measure).not.toHaveBeenCalled();
  });

  it('reports a missing microphone', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ devices: DEVICES.filter((d) => d.kind !== 'audioinput') }),
    });
    expect(byId(report.steps, 'microphone').code).toBe('MIC_NOT_FOUND');
  });

  it('reports a selected input that has been unplugged', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters(),
      selection: { inputDeviceId: 'mic-gone' },
    });
    expect(byId(report.steps, 'microphone').code).toBe('MIC_SELECTED_DEVICE_MISSING');
  });

  it('reports a microphone another application is holding', async () => {
    const busy = new Error('Device in use');
    busy.name = 'NotReadableError';
    const report = await runVoiceConnectionCheck({ adapters: fakeAdapters({ measurement: busy }) });
    expect(byId(report.steps, 'microphone').code).toBe('MIC_IN_USE');
  });

  it('warns when the microphone opens but hears nothing', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ measurement: { peak: 0.001, rms: 0.0005 } }),
    });
    const mic = byId(report.steps, 'microphone');
    expect(mic.status).toBe('warn');
    expect(mic.code).toBe('MIC_SILENT');
    expect(report.overall).toBe('warn');
  });

  it('surfaces the live input level while measuring', async () => {
    const levels: number[] = [];
    await runVoiceConnectionCheck({ adapters: fakeAdapters(), onLevel: (level) => levels.push(level) });
    expect(levels).toContain(0.4);
  });

  it('fails the speaker step when the tone was not heard', async () => {
    const report = await runVoiceConnectionCheck({ adapters: fakeAdapters({ heardTone: false }) });
    const speaker = byId(report.steps, 'speaker');
    expect(speaker.status).toBe('fail');
    expect(speaker.code).toBe('SPEAKER_NOT_HEARD');
  });

  it('warns when output routing could not honour the selected device', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ tone: { routedToSelectedDevice: false } }),
      selection: { outputDeviceId: 'out-1' },
    });
    const speaker = byId(report.steps, 'speaker');
    expect(speaker.status).toBe('warn');
    expect(speaker.code).toBe('SPEAKER_ROUTING_UNSUPPORTED');
  });

  it('reports an unplugged speaker selection', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters(),
      selection: { outputDeviceId: 'out-gone' },
    });
    expect(byId(report.steps, 'speaker').code).toBe('SPEAKER_SELECTED_DEVICE_MISSING');
  });

  it('skips the speaker step when nothing can ask the user', async () => {
    const report = await runVoiceConnectionCheck({ adapters: fakeAdapters({ withAsk: false }) });
    const speaker = byId(report.steps, 'speaker');
    expect(speaker.status).toBe('skipped');
    expect(speaker.code).toBe('SKIPPED_NOT_APPLICABLE');
  });

  it('checks the camera only when asked', async () => {
    const report = await runVoiceConnectionCheck({ adapters: fakeAdapters(), includeCamera: true });
    expect(byId(report.steps, 'camera').code).toBe('CAMERA_OK');
  });

  it('does not treat a missing camera as a voice failure', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ devices: DEVICES.filter((d) => d.kind !== 'videoinput') }),
      includeCamera: true,
    });
    const camera = byId(report.steps, 'camera');
    expect(camera.status).toBe('skipped');
    expect(report.overall).toBe('pass');
  });

  it('reports a camera held by another application', async () => {
    const busy = new Error('in use');
    busy.name = 'NotReadableError';
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ camera: busy }),
      includeCamera: true,
    });
    expect(byId(report.steps, 'camera').code).toBe('CAMERA_IN_USE');
  });

  it('reports a server with no call transport configured', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({
        config: nativeConfig({ transport: 'none', voiceAvailable: false, mediaEndpoint: null, certificatePinSha256: null }),
      }),
    });
    expect(byId(report.steps, 'media-configuration').code).toBe('MEDIA_CONFIG_NONE');
    expect(byId(report.steps, 'certificate').status).toBe('skipped');
    expect(byId(report.steps, 'transport').status).toBe('skipped');
  });

  it('does not run the QUIC checks against a LiveKit server', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({
        config: nativeConfig({ transport: 'livekit', livekitAvailable: true, mediaEndpoint: null, certificatePinSha256: null }),
      }),
    });
    expect(byId(report.steps, 'media-configuration').code).toBe('MEDIA_CONFIG_LIVEKIT');
    expect(byId(report.steps, 'certificate').code).toBe('SKIPPED_NOT_APPLICABLE');
    expect(byId(report.steps, 'transport').code).toBe('SKIPPED_NOT_APPLICABLE');
    expect(report.overall).toBe('pass');
  });

  it('reports an unreachable configuration endpoint separately from an unreachable media port', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ config: new Error('Network Error') }),
    });
    expect(byId(report.steps, 'media-configuration').code).toBe('MEDIA_CONFIG_UNREACHABLE');
    expect(byId(report.steps, 'transport').code).toBe('SKIPPED_PREREQUISITE');
  });

  it('reports a server that advertises native media without a certificate fingerprint', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ config: nativeConfig({ certificatePinSha256: null }) }),
    });
    expect(byId(report.steps, 'certificate').code).toBe('CERTIFICATE_PIN_MISSING');
    expect(byId(report.steps, 'transport').status).toBe('skipped');
  });

  it('reports a malformed certificate fingerprint', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ config: nativeConfig({ certificatePinSha256: 'AAAA' }) }),
    });
    expect(byId(report.steps, 'certificate').code).toBe('CERTIFICATE_PIN_MALFORMED');
  });

  it('tells a browser that cannot pin certificates to use one that can', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters({ capabilities: { certificatePinning: false } }),
    });
    const certificate = byId(report.steps, 'certificate');
    expect(certificate.code).toBe('CERTIFICATE_PINNING_UNSUPPORTED');
    expect(certificate.remedy).toContain('Chrome');
    expect(byId(report.steps, 'transport').status).toBe('skipped');
  });

  it('never attempts a transport probe when WebTransport is missing', async () => {
    const probe = vi.fn();
    const adapters = fakeAdapters({ capabilities: { webTransport: false } });
    adapters.transport.probe = probe;
    const report = await runVoiceConnectionCheck({ adapters });
    expect(probe).not.toHaveBeenCalled();
    expect(byId(report.steps, 'transport').code).toBe('SKIPPED_PREREQUISITE');
  });

  it('carries only the display name and never an account id into the report', async () => {
    const report = await runVoiceConnectionCheck({
      adapters: fakeAdapters(),
      accountDisplayName: 'Ada',
      serverOrigin: 'https://chat.example.com',
    });
    expect(report.account).toBe('Ada');
    expect(JSON.stringify(report)).not.toContain('user_id');
  });

  it('marks remaining steps as cancelled once the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await runVoiceConnectionCheck({ adapters: fakeAdapters(), signal: controller.signal });
    expect(report.steps.every((step) => step.code === 'CANCELLED')).toBe(true);
  });
});
