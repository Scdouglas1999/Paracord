// The guided voice connection check.
//
// Native QUIC/WebTransport media fails independently of HTTP chat, so "voice
// didn't work" has at least eight distinct causes. This runner walks them in
// dependency order and reports each one separately: a secure context, the
// platform's media capabilities, the microphone, the speaker, an optional
// camera, what the server actually configured, whether this client can trust
// the media certificate, and finally a real transport attempt.
//
// The runner is pure with respect to the app: it reads nothing from stores and
// touches no call. Everything environmental arrives through adapters, so every
// outcome below is reproducible from a fake.

import type { DiagnosticsAdapters, TransportProbeOutcome } from './adapters';
import type {
  DiagnosticCode,
  DiagnosticDetail,
  DiagnosticEnvironmentFacts,
  DiagnosticReport,
  DiagnosticStatus,
  DiagnosticStepId,
  DiagnosticStepResult,
  MediaTransportConfig,
} from './types';

export const DEFAULT_TRANSPORT_TIMEOUT_MS = 8_000;
export const DEFAULT_MIC_SAMPLE_MS = 2_500;
export const DEFAULT_TONE_MS = 1_200;
/** Peak level below which the microphone is treated as having heard nothing. */
export const SILENCE_PEAK_THRESHOLD = 0.02;

export const STEP_ORDER: DiagnosticStepId[] = [
  'secure-context',
  'platform',
  'microphone',
  'speaker',
  'camera',
  'media-configuration',
  'certificate',
  'transport',
];

export const STEP_TITLES: Record<DiagnosticStepId, string> = {
  'secure-context': 'Secure connection',
  platform: 'Browser and codec support',
  microphone: 'Microphone',
  speaker: 'Speaker',
  camera: 'Camera',
  'media-configuration': 'Server call settings',
  certificate: 'Media certificate',
  transport: 'Voice connection',
};

export interface DeviceSelection {
  inputDeviceId?: string | null;
  outputDeviceId?: string | null;
  cameraDeviceId?: string | null;
}

export interface ConnectionCheckOptions {
  adapters: DiagnosticsAdapters;
  selection?: DeviceSelection;
  includeCamera?: boolean;
  /** Display name only — never an account id. */
  accountDisplayName?: string | null;
  serverOrigin?: string | null;
  transportTimeoutMs?: number;
  micSampleMs?: number;
  toneMs?: number;
  onProgress?: (steps: DiagnosticStepResult[]) => void;
  onLevel?: (level: number) => void;
  signal?: AbortSignal;
}

interface StepOutcome {
  status: DiagnosticStatus;
  code: DiagnosticCode;
  summary: string;
  remedy?: string;
  detail?: DiagnosticDetail;
}

interface RunState {
  env: DiagnosticEnvironmentFacts;
  config: MediaTransportConfig | null;
  secureContextOk: boolean;
  webTransportOk: boolean;
  certificateOk: boolean;
}

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/** Map a `getUserMedia` rejection onto the cause the user can act on. */
export function classifyMediaError(error: unknown): 'denied' | 'not-found' | 'in-use' | 'failed' {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied/i.test(message)) {
    return 'denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'not-found';
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return 'in-use';
  }
  return 'failed';
}

function skipped(code: DiagnosticCode, summary: string, remedy = ''): StepOutcome {
  return { status: 'skipped', code, summary, remedy };
}

// ── Individual steps ────────────────────────────────────────────────────────

export function checkSecureContext(env: DiagnosticEnvironmentFacts): StepOutcome {
  if (env.engine === 'desktop') {
    return {
      status: 'pass',
      code: 'SECURE_CONTEXT_OK',
      summary:
        'The desktop app runs its media stack outside the browser sandbox, so it does not need a secure web origin.',
      detail: { engine: 'desktop' },
    };
  }
  if (env.isSecureContext) {
    return {
      status: 'pass',
      code: 'SECURE_CONTEXT_OK',
      summary: `Paracord is open on ${env.protocol}//${env.host}, which browsers treat as a secure origin.`,
      detail: { protocol: env.protocol, host: env.host },
    };
  }
  return {
    status: 'fail',
    code: 'SECURE_CONTEXT_INSECURE',
    summary: `Paracord is open on ${env.protocol}//${env.host}, which this browser treats as insecure.`,
    remedy:
      'Open Paracord over https://, or over http://localhost on the same machine as the server. Browsers block microphone access and QUIC media on insecure origins, so no call can start from this address.',
    detail: { protocol: env.protocol, host: env.host },
  };
}

export interface PlatformFacts {
  webTransport: boolean;
  mediaDevices: boolean;
  audioWorklet: boolean;
  opus: boolean;
  vp9: boolean;
}

export function checkPlatform(env: DiagnosticEnvironmentFacts, facts: PlatformFacts): StepOutcome {
  const detail: DiagnosticDetail = {
    engine: env.engine,
    web_transport: facts.webTransport,
    media_devices: facts.mediaDevices,
    audio_worklet: facts.audioWorklet,
    opus_encode: facts.opus,
    vp9_decode: facts.vp9,
  };

  if (env.engine === 'desktop') {
    return {
      status: 'pass',
      code: 'PLATFORM_OK',
      summary:
        'The desktop app encodes Opus and VP9 in its own native media stack, so it does not depend on the browser codecs listed here.',
      detail,
    };
  }

  if (!facts.webTransport) {
    return {
      status: 'fail',
      code: 'PLATFORM_NO_WEBTRANSPORT',
      summary: 'This browser cannot open a WebTransport connection, which Paracord uses to carry voice and video.',
      remedy:
        'Use Chrome or Edge (or the Paracord desktop app) for calls. Safari has no WebTransport support, and Firefox does not yet support the certificate pinning a self-hosted server needs.',
      detail,
    };
  }
  if (!facts.mediaDevices) {
    return {
      status: 'fail',
      code: 'PLATFORM_NO_MEDIA_DEVICES',
      summary: 'This browser exposes no microphone or camera API, so Paracord cannot capture audio here.',
      remedy:
        'Update the browser, and check that a policy or extension is not blocking media capture on this site.',
      detail,
    };
  }
  if (!facts.opus) {
    return {
      status: 'fail',
      code: 'PLATFORM_NO_OPUS',
      summary: 'This browser cannot encode Opus audio, which every Paracord call uses.',
      remedy: 'Use Chrome or Edge (or the Paracord desktop app) for calls on this server.',
      detail,
    };
  }
  if (!facts.audioWorklet) {
    return {
      status: 'warn',
      code: 'PLATFORM_NO_AUDIO_WORKLET',
      summary:
        'This browser has no AudioWorklet support, so calls will work but noise suppression and echo handling will not.',
      remedy: 'Update the browser to get the full audio processing chain.',
      detail,
    };
  }
  if (!facts.vp9) {
    return {
      status: 'warn',
      code: 'PLATFORM_NO_VP9',
      summary: 'This browser cannot decode VP9 video, so voice will work but other people’s video and screen shares will not appear.',
      remedy: 'Use Chrome or Edge (or the Paracord desktop app) to see video and screen shares.',
      detail,
    };
  }
  return {
    status: 'pass',
    code: 'PLATFORM_OK',
    summary: 'This browser supports WebTransport, Opus audio, VP9 video and the audio processing chain.',
    detail,
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

function transportOutcomeToStep(
  env: DiagnosticEnvironmentFacts,
  config: MediaTransportConfig,
  outcome: TransportProbeOutcome,
  timeoutMs: number,
): StepOutcome {
  const port = config.mediaUdpPort;
  const endpoint = config.mediaEndpoint ?? '';
  const portText = port === null ? 'the media UDP port' : `UDP port ${port}`;
  const detail: DiagnosticDetail = {
    endpoint,
    udp_port: port,
    rtt_ms: outcome.rttMs,
    stream_opened: outcome.streamOpened,
    timeout_ms: timeoutMs,
    error: outcome.detail,
    // A diagnostic session deliberately carries no call token, so the relay
    // never acknowledges it. Reaching "ready" already proves the UDP path, the
    // QUIC handshake and the certificate; authentication is a separate concern
    // that only a real join can exercise.
    relay_authentication: 'not attempted (a diagnostic session carries no call token)',
  };

  if (outcome.ok) {
    return {
      status: 'pass',
      code: 'TRANSPORT_OK',
      summary: `Opened a media connection to ${endpoint} in ${outcome.rttMs} ms. Voice traffic can reach this server from this network.`,
      detail,
    };
  }

  switch (outcome.failure) {
    case 'timeout':
      return {
        status: 'fail',
        code: 'TRANSPORT_TIMEOUT',
        summary: `Nothing answered at ${endpoint} within ${timeoutMs} ms. Chat works because it uses TCP, but voice needs UDP and the UDP path is silent.`,
        remedy: `Your server's ${portText} is not reachable from this network. Ask the operator to forward ${portText} to the server host, and check that a firewall, VPN or guest network here is not dropping QUIC.`,
        detail,
      };
    case 'unreachable':
      return {
        status: 'fail',
        code: 'TRANSPORT_UNREACHABLE',
        summary: `This device could not reach ${endpoint} at all — the address did not resolve or the network refused it.`,
        remedy: `Check that the server's media hostname resolves from this network, and ask the operator to confirm ${portText} is published on the same host that serves chat.`,
        detail,
      };
    case 'certificate-refused':
      return {
        status: 'fail',
        code: 'TRANSPORT_CERTIFICATE_REFUSED',
        summary: `The media port answered, but this browser refused the certificate it presented.`,
        remedy:
          'The media port presents a certificate the server generates for itself, and this check pinned the fingerprint the server published moments ago. If that fingerprint was refused, this browser cannot pin a self-signed WebTransport certificate at all — Firefox and Safari cannot — so use a Chromium-based browser or the Paracord desktop app. If you are already in Chrome or Edge, re-run the check: the server rotates its media certificate, and a fingerprint read before a rotation is refused until it is read again.',
        detail,
      };
    case 'handshake-failed':
      return {
        status: 'fail',
        code: 'TRANSPORT_HANDSHAKE_FAILED',
        // Browsers report a refused route and a dropped one with the same
        // opaque handshake error, so the text must not claim which it was. The
        // server's own certificate is no longer a plausible cause: it is issued
        // for 13 days and rotated, which is inside the window browsers accept.
        summary: `The QUIC handshake with ${endpoint} did not complete, so no voice traffic can flow.`,
        remedy: config.certificatePinSha256
          ? `The route is the likely cause: ${portText} must be published on the same host that serves chat and reach the Paracord instance itself rather than another service, and nothing between this device and the instance may drop UDP. If the instance is on this machine or your own network, re-run this check first — the instance rotates its media certificate, and a fingerprint read before a rotation is refused until it is read again.`
          : `Ask the operator to confirm ${portText} is published on the same host that serves chat and reaches the Paracord instance itself rather than another service, and that the instance's media listener started without errors. If it is, something between this device and the instance is dropping UDP.`,
        detail,
      };
    case 'closed-early':
      return {
        status: 'fail',
        code: 'TRANSPORT_CLOSED_EARLY',
        summary: 'The server accepted the connection and then closed it immediately.',
        remedy:
          'Ask the operator to check the server log around the time of this check; the media listener rejected the session before it was usable.',
        detail,
      };
    case 'unsupported':
      if (env.engine === 'desktop') {
        return skipped(
          'TRANSPORT_UNSUPPORTED',
          'The desktop app opens its media connection from its own native QUIC stack, which this check cannot exercise without joining a call.',
          `Run this check in a browser against the same server to test the UDP path, or ask the operator to confirm ${portText} is forwarded.`,
        );
      }
      return {
        status: 'fail',
        code: 'TRANSPORT_UNSUPPORTED',
        summary: 'This runtime has no WebTransport support, so no media connection can be attempted.',
        remedy: 'Use Chrome or Edge, or the Paracord desktop app.',
        detail,
      };
    default:
      return {
        status: 'fail',
        code: 'TRANSPORT_FAILED',
        summary: `The media connection to ${endpoint} failed for a reason this check could not classify.`,
        remedy:
          'Export the diagnostics below and send them to your server operator; the raw error is included in the report.',
        detail,
      };
  }
}

export async function runVoiceConnectionCheck(
  options: ConnectionCheckOptions,
): Promise<DiagnosticReport> {
  const { adapters } = options;
  const selection = options.selection ?? {};
  const transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
  const micSampleMs = options.micSampleMs ?? DEFAULT_MIC_SAMPLE_MS;
  const toneMs = options.toneMs ?? DEFAULT_TONE_MS;
  const startedAt = new Date().toISOString();

  const env = adapters.environment.read();
  const state: RunState = {
    env,
    config: null,
    secureContextOk: false,
    webTransportOk: false,
    certificateOk: false,
  };

  const results: DiagnosticStepResult[] = STEP_ORDER.map((id) => ({
    id,
    title: STEP_TITLES[id],
    status: 'pending',
    code: null,
    summary: '',
    remedy: '',
    detail: {},
    durationMs: 0,
  }));
  const emit = () => options.onProgress?.(results.map((entry) => ({ ...entry })));
  emit();

  const run = async (id: DiagnosticStepId, body: () => Promise<StepOutcome>): Promise<StepOutcome> => {
    const index = STEP_ORDER.indexOf(id);
    const startedTick = adapters.now();
    results[index] = { ...results[index], status: 'running' };
    emit();
    let outcome: StepOutcome;
    if (options.signal?.aborted) {
      outcome = skipped('CANCELLED', 'The check was stopped before this step ran.');
    } else {
      try {
        outcome = await body();
      } catch (error) {
        outcome = {
          status: 'fail',
          code: 'TRANSPORT_FAILED',
          summary: 'This step could not complete.',
          remedy: 'Run the check again; if it keeps failing, export the diagnostics for your operator.',
          detail: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    results[index] = {
      id,
      title: STEP_TITLES[id],
      status: outcome.status,
      code: outcome.code,
      summary: outcome.summary,
      remedy: outcome.remedy ?? '',
      detail: outcome.detail ?? {},
      durationMs: Math.max(0, Math.round(adapters.now() - startedTick)),
    };
    emit();
    return outcome;
  };

  // 1. Secure context.
  const secure = await run('secure-context', async () => checkSecureContext(env));
  state.secureContextOk = secure.status !== 'fail';

  // 2. Platform capability.
  const platform = await run('platform', async () => {
    const [opus, vp9] = await Promise.all([
      adapters.capabilities.supportsOpus(),
      adapters.capabilities.supportsVp9(),
    ]);
    return checkPlatform(env, {
      webTransport: adapters.capabilities.hasWebTransport(),
      mediaDevices: adapters.capabilities.hasMediaDevices(),
      audioWorklet: adapters.capabilities.hasAudioWorklet(),
      opus,
      vp9,
    });
  });
  state.webTransportOk =
    env.engine === 'desktop' ||
    (platform.code !== 'PLATFORM_NO_WEBTRANSPORT' && platform.status !== 'fail');

  // 3. Microphone.
  await run('microphone', async () => {
    if (!state.secureContextOk) {
      return skipped(
        'SKIPPED_PREREQUISITE',
        'Skipped: a browser will not grant microphone access on an insecure address.',
      );
    }
    const permission = await adapters.devices.permission('microphone');
    if (permission === 'denied') {
      return {
        status: 'fail',
        code: 'MIC_DENIED',
        summary: 'Microphone access is blocked for this site.',
        remedy:
          'Open the padlock (or site settings) in the address bar, allow the microphone, then reload Paracord and run the check again.',
        detail: { permission },
      };
    }
    const devices = await adapters.devices.enumerate();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    if (inputs.length === 0) {
      return {
        status: 'fail',
        code: 'MIC_NOT_FOUND',
        summary: 'No microphone is available to this device.',
        remedy: 'Connect a microphone or headset, then run the check again.',
        detail: { permission, input_count: 0 },
      };
    }
    if (selection.inputDeviceId && !inputs.some((d) => d.deviceId === selection.inputDeviceId)) {
      return {
        status: 'fail',
        code: 'MIC_SELECTED_DEVICE_MISSING',
        summary: 'The microphone chosen in Voice & video is no longer connected.',
        remedy: 'Open Voice & video and choose an input that is plugged in, then run the check again.',
        detail: { permission, input_count: inputs.length },
      };
    }

    try {
      const measurement = await adapters.devices.measureMicrophone({
        deviceId: selection.inputDeviceId ?? null,
        durationMs: micSampleMs,
        onLevel: options.onLevel,
        signal: options.signal,
      });
      const detail: DiagnosticDetail = {
        permission,
        input_count: inputs.length,
        peak_percent: percent(measurement.peak),
        rms_percent: percent(measurement.rms),
        sampled_ms: measurement.sampledMs,
        device_label: measurement.deviceLabel,
      };
      if (measurement.peak < SILENCE_PEAK_THRESHOLD) {
        return {
          status: 'warn',
          code: 'MIC_SILENT',
          summary: `The microphone opened, but no sound reached it while the check listened for ${Math.round(measurement.sampledMs / 100) / 10} seconds.`,
          remedy:
            'Check that the right input is selected in Voice & video and that it is not muted in your operating system, then run the check again and speak while it listens.',
          detail,
        };
      }
      return {
        status: 'pass',
        code: 'MIC_OK',
        summary: `Your microphone is working — input peaked at ${percent(measurement.peak)}%.`,
        detail,
      };
    } catch (error) {
      const cause = classifyMediaError(error);
      const detail: DiagnosticDetail = {
        permission,
        input_count: inputs.length,
        error: error instanceof Error ? error.message : String(error),
      };
      if (cause === 'denied') {
        return {
          status: 'fail',
          code: 'MIC_DENIED',
          summary: 'You declined the microphone prompt, so the check could not listen.',
          remedy: 'Run the check again and choose Allow when the browser asks for the microphone.',
          detail,
        };
      }
      if (cause === 'not-found') {
        return {
          status: 'fail',
          code: 'MIC_NOT_FOUND',
          summary: 'The selected microphone could not be opened because it is no longer present.',
          remedy: 'Choose a different input in Voice & video, then run the check again.',
          detail,
        };
      }
      if (cause === 'in-use') {
        return {
          status: 'fail',
          code: 'MIC_IN_USE',
          summary: 'Another application is holding the microphone, so Paracord could not open it.',
          remedy: 'Close the other app using the microphone (or end its call), then run the check again.',
          detail,
        };
      }
      return {
        status: 'fail',
        code: 'MIC_FAILED',
        summary: 'The microphone could not be opened.',
        remedy: 'Run the check again; if it keeps failing, export the diagnostics for your operator.',
        detail,
      };
    }
  });

  // 4. Speaker.
  await run('speaker', async () => {
    if (!adapters.ask) {
      return skipped(
        'SKIPPED_NOT_APPLICABLE',
        'Skipped: a test tone needs someone to confirm they heard it, and this run had no way to ask.',
      );
    }
    const devices = await adapters.devices.enumerate();
    const outputs = devices.filter((device) => device.kind === 'audiooutput');
    if (selection.outputDeviceId && !outputs.some((d) => d.deviceId === selection.outputDeviceId)) {
      return {
        status: 'fail',
        code: 'SPEAKER_SELECTED_DEVICE_MISSING',
        summary: 'The speaker or headset chosen in Voice & video is no longer connected.',
        remedy: 'Open Voice & video and choose an output that is plugged in, then run the check again.',
        detail: { output_count: outputs.length },
      };
    }
    try {
      const tone = await adapters.devices.playTestTone({
        deviceId: selection.outputDeviceId ?? null,
        durationMs: toneMs,
        signal: options.signal,
      });
      const heard = await adapters.ask('Did you hear the test tone?');
      const detail: DiagnosticDetail = {
        output_count: outputs.length,
        routed_to_selected_device: tone.routedToSelectedDevice,
      };
      if (!heard) {
        return {
          status: 'fail',
          code: 'SPEAKER_NOT_HEARD',
          summary: 'You did not hear the test tone, so you would not hear anyone in a call either.',
          remedy:
            'Raise the system volume, check that the right output is chosen in Voice & video, and confirm this browser is not muted in your operating system’s volume mixer.',
          detail,
        };
      }
      if (selection.outputDeviceId && !tone.routedToSelectedDevice) {
        return {
          status: 'warn',
          code: 'SPEAKER_ROUTING_UNSUPPORTED',
          summary:
            'You heard the tone, but this browser cannot send audio to a specific output, so it played on the system default device.',
          remedy:
            'Choose your preferred device as the system default output, or use the Paracord desktop app, which switches outputs directly.',
          detail,
        };
      }
      return {
        status: 'pass',
        code: 'SPEAKER_OK',
        summary: 'You heard the test tone, so call audio will reach your ears.',
        detail,
      };
    } catch (error) {
      return {
        status: 'fail',
        code: 'SPEAKER_FAILED',
        summary: 'The test tone could not be played.',
        remedy: 'Run the check again; if it keeps failing, export the diagnostics for your operator.',
        detail: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  });

  // 5. Camera (optional).
  await run('camera', async () => {
    if (!options.includeCamera) {
      return skipped(
        'SKIPPED_NOT_APPLICABLE',
        'Skipped: the camera was not included in this check. Voice calls do not need it.',
      );
    }
    if (!state.secureContextOk) {
      return skipped(
        'SKIPPED_PREREQUISITE',
        'Skipped: a browser will not grant camera access on an insecure address.',
      );
    }
    const permission = await adapters.devices.permission('camera');
    if (permission === 'denied') {
      return {
        status: 'fail',
        code: 'CAMERA_DENIED',
        summary: 'Camera access is blocked for this site.',
        remedy: 'Allow the camera in this site’s browser settings, then run the check again.',
        detail: { permission },
      };
    }
    const devices = await adapters.devices.enumerate();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    if (cameras.length === 0) {
      return skipped(
        'CAMERA_NOT_FOUND',
        'No camera is attached. Voice calls are unaffected; only video calls need one.',
      );
    }
    try {
      const camera = await adapters.devices.openCamera({
        deviceId: selection.cameraDeviceId ?? null,
        signal: options.signal,
      });
      return {
        status: 'pass',
        code: 'CAMERA_OK',
        summary: 'Your camera opened successfully.',
        detail: { permission, camera_count: cameras.length, device_label: camera.label },
      };
    } catch (error) {
      const cause = classifyMediaError(error);
      const detail: DiagnosticDetail = {
        permission,
        camera_count: cameras.length,
        error: error instanceof Error ? error.message : String(error),
      };
      if (cause === 'denied') {
        return {
          status: 'fail',
          code: 'CAMERA_DENIED',
          summary: 'You declined the camera prompt.',
          remedy: 'Run the check again and choose Allow when the browser asks for the camera.',
          detail,
        };
      }
      if (cause === 'in-use') {
        return {
          status: 'fail',
          code: 'CAMERA_IN_USE',
          summary: 'Another application is holding the camera.',
          remedy: 'Close the other app using the camera, then run the check again.',
          detail,
        };
      }
      if (cause === 'not-found') {
        return {
          status: 'fail',
          code: 'CAMERA_NOT_FOUND',
          summary: 'The selected camera could not be opened because it is no longer present.',
          remedy: 'Choose a different camera in Voice & video, then run the check again.',
          detail,
        };
      }
      return {
        status: 'fail',
        code: 'CAMERA_FAILED',
        summary: 'The camera could not be opened.',
        remedy: 'Run the check again; if it keeps failing, export the diagnostics for your operator.',
        detail,
      };
    }
  });

  // 6. What the server actually configured.
  await run('media-configuration', async () => {
    try {
      const config = await adapters.server.fetchTransportConfig(options.signal);
      state.config = config;
      const detail: DiagnosticDetail = {
        transport: config.transport,
        media_endpoint: config.mediaEndpoint,
        udp_port: config.mediaUdpPort,
        livekit_available: config.livekitAvailable,
        e2ee_required: config.e2eeRequired,
        max_participants: config.maxParticipants,
      };
      if (config.transport === 'none') {
        return {
          status: 'fail',
          code: 'MEDIA_CONFIG_NONE',
          summary: 'This server has no call transport configured, so voice and video cannot work for anyone on it.',
          remedy:
            'Ask the operator to enable native media ([voice] native_media = true in paracord.toml, the default) or configure LiveKit, then restart the server.',
          detail,
        };
      }
      if (config.transport === 'livekit') {
        return {
          status: 'pass',
          code: 'MEDIA_CONFIG_LIVEKIT',
          summary: 'This server routes calls through LiveKit over WebRTC rather than Paracord’s native QUIC path.',
          detail,
        };
      }
      return {
        status: 'pass',
        code: 'MEDIA_CONFIG_NATIVE',
        summary: `This server carries calls over its own QUIC media endpoint at ${config.mediaEndpoint}.`,
        detail,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invalid = /transport|no voice transport/i.test(message);
      return {
        status: 'fail',
        code: invalid ? 'MEDIA_CONFIG_INVALID' : 'MEDIA_CONFIG_UNREACHABLE',
        summary: invalid
          ? 'The server answered with call settings this client does not understand.'
          : 'Paracord could not ask the server which call transport it uses.',
        remedy: invalid
          ? 'The server and this client are running incompatible versions. Ask the operator which version is deployed.'
          : 'Check that you are still signed in and that the server is reachable, then run the check again.',
        detail: { error: message },
      };
    }
  });

  // 7. Certificate acceptance.
  await run('certificate', async () => {
    const config = state.config;
    if (!config || config.transport !== 'native') {
      return skipped(
        'SKIPPED_NOT_APPLICABLE',
        'Skipped: this server does not use Paracord’s own QUIC media endpoint, so there is no media certificate to pin.',
      );
    }
    const pin = config.certificatePinSha256;
    if (!pin) {
      return {
        status: 'fail',
        code: 'CERTIFICATE_PIN_MISSING',
        summary:
          'The server says it uses native QUIC media but published no fingerprint for its media certificate, so this client has nothing to trust.',
        remedy:
          'Ask the operator to restart the server and check the start-up log: the media fingerprint is created when the media listener binds.',
        detail: { certificate_source: config.certificateSource },
      };
    }
    let pinBytes = 0;
    try {
      pinBytes = atob(pin.trim()).length;
    } catch {
      pinBytes = -1;
    }
    if (pinBytes !== 32) {
      return {
        status: 'fail',
        code: 'CERTIFICATE_PIN_MALFORMED',
        summary: 'The server published a media certificate fingerprint this client cannot read.',
        remedy:
          'The fingerprint must be a base64 SHA-256 digest. Ask the operator which Paracord version the server runs; this is a server-side defect, not a network problem.',
        detail: { certificate_source: config.certificateSource, fingerprint_bytes: pinBytes },
      };
    }
    if (env.engine === 'browser' && !adapters.capabilities.supportsCertificatePinning()) {
      return {
        status: 'fail',
        code: 'CERTIFICATE_PINNING_UNSUPPORTED',
        summary:
          'Paracord’s media port presents a certificate the server generates for itself, and this browser cannot trust a certificate by fingerprint.',
        remedy:
          'Use Chrome or Edge, or the Paracord desktop app, for calls on this server. Firefox and Safari do not implement the certificate pinning a self-hosted media endpoint needs.',
        detail: { certificate_source: config.certificateSource },
      };
    }
    state.certificateOk = true;
    return {
      status: 'pass',
      code: 'CERTIFICATE_PINNED',
      summary: 'This client can pin the server’s media certificate by fingerprint.',
      detail: {
        certificate_source: config.certificateSource,
        // A public fingerprint prefix, enough to compare two servers without
        // reproducing the whole value in a shared report.
        fingerprint_prefix: pin.trim().slice(0, 12),
      },
    };
  });

  // 8. The real transport attempt.
  await run('transport', async () => {
    const config = state.config;
    if (!config) {
      return skipped(
        'SKIPPED_PREREQUISITE',
        'Skipped: the server’s call settings could not be read, so there was no endpoint to try.',
      );
    }
    if (config.transport !== 'native') {
      return skipped(
        'SKIPPED_NOT_APPLICABLE',
        'Skipped: this server uses LiveKit, whose connection is established when a call starts rather than by this check.',
      );
    }
    if (!state.secureContextOk) {
      return skipped(
        'SKIPPED_PREREQUISITE',
        'Skipped: a browser will not open a QUIC media session from an insecure address.',
      );
    }
    if (!state.webTransportOk) {
      return skipped(
        'SKIPPED_PREREQUISITE',
        'Skipped: this browser has no WebTransport support, so there is nothing to connect with.',
      );
    }
    if (!state.certificateOk) {
      return skipped(
        'SKIPPED_PREREQUISITE',
        'Skipped: this client cannot trust the server’s media certificate, so the connection would be refused before it started.',
      );
    }
    if (!config.mediaEndpoint) {
      return {
        status: 'fail',
        code: 'MEDIA_CONFIG_INVALID',
        summary: 'The server reported native media but gave no endpoint to connect to.',
        remedy: 'Ask the operator to check the [voice] section of paracord.toml and restart the server.',
        detail: { transport: config.transport },
      };
    }
    const outcome = await adapters.transport.probe({
      endpoint: config.mediaEndpoint,
      certificatePinSha256: config.certificatePinSha256,
      timeoutMs: transportTimeoutMs,
    });
    return transportOutcomeToStep(env, config, outcome, transportTimeoutMs);
  });

  const overall: DiagnosticReport['overall'] = results.some((step) => step.status === 'fail')
    ? 'fail'
    : results.some((step) => step.status === 'warn')
      ? 'warn'
      : 'pass';

  return {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    account: options.accountDisplayName ?? null,
    serverOrigin: options.serverOrigin ?? null,
    environment: env,
    transportConfig: state.config,
    steps: results.map((step) => ({ ...step })),
    overall,
  };
}
