// Real implementations of the connection-check adapters.
//
// These are the only place the check touches the DOM, Web Audio, WebCodecs,
// WebTransport or the API client. The step runner never imports them directly,
// which is what keeps every step outcome reproducible from a fake.

import { getApi } from '../../../api/activeClient';
import { isTauri } from '../../tauriEnv';
import type {
  CameraOutcome,
  CapabilityAdapter,
  DeviceAdapter,
  DiagnosticDevice,
  DiagnosticsAdapters,
  EnvironmentAdapter,
  MicrophoneMeasurement,
  MicrophoneRequest,
  PermissionOutcome,
  ServerAdapter,
  TestToneOutcome,
  TestToneRequest,
  TransportAdapter,
  TransportProbeOutcome,
  TransportProbeRequest,
} from './adapters';
import type { DiagnosticEnvironmentFacts, MediaTransportConfig } from './types';

/** Remove any `user:password@` embedded in a URL before it is displayed or exported. */
export function stripUrlCredentials(raw: string): string {
  if (!raw) return raw;
  // Only an absolute URL goes through the URL parser: `user:pass@host` on its
  // own parses as a scheme plus a path and would survive untouched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
      }
      return url.toString();
    } catch {
      // Fall through to the textual strip below.
    }
  }
  // A bare authority (or a malformed value): strip a leading credential pair so
  // nothing secret can ride into a displayed or exported value.
  return raw.replace(/^[^/@\s]+:[^/@\s]*@/, '');
}

function isChromiumLike(userAgent: string): boolean {
  if (/Firefox\//i.test(userAgent)) return false;
  // Safari reports "Version/x Safari" without a Chrome token.
  if (/Safari\//i.test(userAgent) && !/Chrome\/|Chromium\/|Edg\//i.test(userAgent)) return false;
  return /Chrome\/|Chromium\/|Edg\//i.test(userAgent);
}

export function createEnvironmentAdapter(): EnvironmentAdapter {
  return {
    read(): DiagnosticEnvironmentFacts {
      const nav = typeof navigator === 'undefined' ? undefined : navigator;
      const loc = typeof window === 'undefined' ? undefined : window.location;
      return {
        engine: isTauri() ? 'desktop' : 'browser',
        isSecureContext: typeof window === 'undefined' ? false : Boolean(window.isSecureContext),
        protocol: loc?.protocol ?? '',
        host: stripUrlCredentials(loc?.host ?? ''),
        userAgent: nav?.userAgent ?? '',
        language: nav?.language ?? '',
      };
    },
  };
}

export function createCapabilityAdapter(): CapabilityAdapter {
  return {
    hasWebTransport: () => typeof WebTransport !== 'undefined',
    supportsCertificatePinning: () => {
      if (typeof WebTransport === 'undefined') return false;
      // `serverCertificateHashes` cannot be feature-detected: unknown dictionary
      // members are silently ignored, so a browser without it accepts the option
      // and then rejects the certificate. Chromium is the only engine that
      // implements it, so the browser identification string is the evidence.
      return isChromiumLike(typeof navigator === 'undefined' ? '' : navigator.userAgent);
    },
    hasMediaDevices: () =>
      typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
    hasAudioWorklet: () => {
      const Ctor =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return Boolean(Ctor && 'audioWorklet' in Ctor.prototype);
    },
    supportsOpus: async () => {
      const encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
      if (!encoder || typeof encoder.isConfigSupported !== 'function') return false;
      try {
        const support = await encoder.isConfigSupported({
          codec: 'opus',
          sampleRate: 48_000,
          numberOfChannels: 1,
          bitrate: 32_000,
        });
        return Boolean(support.supported);
      } catch {
        return false;
      }
    },
    supportsVp9: async () => {
      try {
        // Loaded lazily: the decoder module performs a real functional decode,
        // which is far more trustworthy than `isConfigSupported` on WebKitGTK.
        const { isWebCodecsDecodeSupported } = await import('../video/videoDecoder');
        return await isWebCodecsDecodeSupported('vp9');
      } catch {
        return false;
      }
    },
  };
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Track already ended.
    }
  }
}

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  return (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export function createDeviceAdapter(): DeviceAdapter {
  return {
    async permission(kind): Promise<PermissionOutcome> {
      const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
      if (!permissions?.query) return 'unknown';
      try {
        const status = await permissions.query({ name: kind as PermissionName });
        if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
          return status.state;
        }
        return 'unknown';
      } catch {
        // Firefox rejects the `microphone` descriptor outright.
        return 'unknown';
      }
    },

    async enumerate(): Promise<DiagnosticDevice[]> {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(
          (device): device is MediaDeviceInfo =>
            device.kind === 'audioinput' ||
            device.kind === 'audiooutput' ||
            device.kind === 'videoinput',
        )
        .map((device) => ({
          deviceId: device.deviceId,
          kind: device.kind as DiagnosticDevice['kind'],
          label: device.label,
        }));
    },

    async measureMicrophone(request: MicrophoneRequest): Promise<MicrophoneMeasurement> {
      const constraints: MediaStreamConstraints = {
        audio: request.deviceId ? { deviceId: { exact: request.deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const Ctor = audioContextCtor();
      if (!Ctor) {
        stopStream(stream);
        throw new Error('This browser has no Web Audio support, so input level cannot be measured.');
      }
      const context = new Ctor();
      let peak = 0;
      let sumSquares = 0;
      let sampleCount = 0;
      const startedAt = Date.now();
      try {
        const source = context.createMediaStreamSource(stream);
        const analyzer = context.createAnalyser();
        analyzer.fftSize = 256;
        analyzer.smoothingTimeConstant = 0.3;
        source.connect(analyzer);
        const buffer = new Float32Array(analyzer.fftSize);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearInterval(timer);
            request.signal?.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setInterval(() => {
            analyzer.getFloatTimeDomainData(buffer);
            let framePeak = 0;
            for (const sample of buffer) {
              const magnitude = Math.abs(sample);
              if (magnitude > framePeak) framePeak = magnitude;
              sumSquares += sample * sample;
              sampleCount += 1;
            }
            if (framePeak > peak) peak = framePeak;
            request.onLevel?.(framePeak);
            if (Date.now() - startedAt >= request.durationMs) finish();
          }, 60);
          request.signal?.addEventListener('abort', finish, { once: true });
        });
        source.disconnect();
      } finally {
        stopStream(stream);
        try {
          await context.close();
        } catch {
          // Context already closed.
        }
      }
      const track = stream.getAudioTracks()[0];
      return {
        peak,
        rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
        sampledMs: Date.now() - startedAt,
        deviceLabel: track?.label || null,
      };
    },

    async playTestTone(request: TestToneRequest): Promise<TestToneOutcome> {
      const Ctor = audioContextCtor();
      if (!Ctor) throw new Error('This browser has no Web Audio support, so no test tone can play.');
      const context = new Ctor();
      let routedToSelectedDevice = false;
      try {
        const sinkTarget = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        if (request.deviceId && typeof sinkTarget.setSinkId === 'function') {
          await sinkTarget.setSinkId(request.deviceId);
          routedToSelectedDevice = true;
        }
        if (context.state === 'suspended') await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 440;
        // Fade in and out so the tone is pleasant rather than a click.
        const now = context.currentTime;
        const seconds = request.durationMs / 1000;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.2, now + 0.05);
        gain.gain.setValueAtTime(0.2, now + Math.max(0.06, seconds - 0.08));
        gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + seconds);
        await new Promise<void>((resolve) => {
          const done = () => {
            request.signal?.removeEventListener('abort', done);
            resolve();
          };
          oscillator.onended = done;
          request.signal?.addEventListener('abort', done, { once: true });
          // Guard against an implementation that never fires `onended`.
          setTimeout(done, request.durationMs + 250);
        });
      } finally {
        try {
          await context.close();
        } catch {
          // Context already closed.
        }
      }
      return { routedToSelectedDevice };
    },

    async openCamera(request): Promise<CameraOutcome> {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: request.deviceId ? { deviceId: { exact: request.deviceId } } : true,
      });
      const label = stream.getVideoTracks()[0]?.label || null;
      stopStream(stream);
      return { label };
    },
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse the server's transport-diagnostics payload, failing loudly on garbage. */
export function parseTransportConfig(payload: unknown): MediaTransportConfig {
  if (!payload || typeof payload !== 'object') {
    throw new Error('The server returned no voice transport information.');
  }
  const raw = payload as Record<string, unknown>;
  const transport = raw.transport;
  if (transport !== 'native' && transport !== 'livekit' && transport !== 'none') {
    throw new Error(
      `The server reported an unrecognized call transport (${String(transport)}). This client cannot check it.`,
    );
  }
  const candidates = Array.isArray(raw.media_endpoint_candidates)
    ? raw.media_endpoint_candidates.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const endpoint = asString(raw.media_endpoint);
  const certificateSource =
    raw.certificate_source === 'server-generated-self-signed'
      ? 'server-generated-self-signed'
      : 'none';
  return {
    transport,
    voiceAvailable: raw.voice_available === true,
    mediaEndpoint: endpoint ? stripUrlCredentials(endpoint) : null,
    mediaEndpointCandidates: candidates.map(stripUrlCredentials),
    mediaUdpPort: asNumber(raw.media_udp_port),
    certificatePinSha256: asString(raw.certificate_pin_sha256),
    certificateSource,
    livekitAvailable: raw.livekit_available === true,
    e2eeRequired: raw.e2ee_required === true,
    maxParticipants: asNumber(raw.max_participants),
  };
}

export function createServerAdapter(): ServerAdapter {
  return {
    async fetchTransportConfig(signal?: AbortSignal): Promise<MediaTransportConfig> {
      // The shared client's baseURL already carries `/api/v1`, so this path is
      // relative to it. A leading `/api/v1` here would resolve to
      // `/api/v1/api/v1/...` and 404.
      const response = await getApi().get('/voice/transport-diagnostics', {
        signal,
        timeout: 15_000,
      });
      return parseTransportConfig(response.data);
    },
  };
}

function decodeCertificatePin(pin: string): Uint8Array<ArrayBuffer> {
  const binary = atob(pin.trim());
  if (binary.length !== 32) {
    throw new Error(
      `The server's media certificate fingerprint is ${binary.length} bytes; a SHA-256 fingerprint is 32.`,
    );
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** The probe's own deadline message, matched verbatim when classifying. */
export const PROBE_TIMEOUT_MESSAGE = 'No reply from the media endpoint within';

/** Classify a WebTransport failure into one the user can act on. */
export function classifyTransportError(
  error: unknown,
  elapsedMs: number,
  timeoutMs: number,
): { failure: TransportProbeOutcome['failure']; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  // The deadline is authoritative regardless of how the clock rounded: a probe
  // that lost to its own timer is a timeout even if `elapsedMs` reads one
  // millisecond short.
  if (message.startsWith(PROBE_TIMEOUT_MESSAGE) || elapsedMs >= timeoutMs) {
    return { failure: 'timeout', detail: message };
  }
  if (/certificate|cert_|CERT_|fingerprint|pinned/i.test(message)) {
    return { failure: 'certificate-refused', detail: message };
  }
  if (/ERR_NAME_NOT_RESOLVED|resolve|DNS|ADDRESS_UNREACHABLE|NETWORK_CHANGED|unreachable/i.test(message)) {
    return { failure: 'unreachable', detail: message };
  }
  if (/handshake|ERR_QUIC|ERR_CONNECTION|refused|reset/i.test(message)) {
    return { failure: 'handshake-failed', detail: message };
  }
  return { failure: 'unknown', detail: message };
}

export function createTransportAdapter(now: () => number = () => performance.now()): TransportAdapter {
  return {
    async probe(request: TransportProbeRequest): Promise<TransportProbeOutcome> {
      if (typeof WebTransport === 'undefined') {
        return {
          ok: false,
          rttMs: null,
          streamOpened: false,
          failure: 'unsupported',
          detail: 'WebTransport is not available in this runtime.',
        };
      }
      let options: WebTransportOptions | undefined;
      if (request.certificatePinSha256) {
        try {
          options = {
            serverCertificateHashes: [
              { algorithm: 'sha-256', value: decodeCertificatePin(request.certificatePinSha256) },
            ],
          };
        } catch (error) {
          return {
            ok: false,
            rttMs: null,
            streamOpened: false,
            failure: 'certificate-refused',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const startedAt = now();
      let transport: WebTransport | null = null;
      try {
        transport = new WebTransport(request.endpoint, options);
      } catch (error) {
        const elapsed = now() - startedAt;
        const { failure, detail } = classifyTransportError(error, elapsed, request.timeoutMs);
        return { ok: false, rttMs: null, streamOpened: false, failure, detail };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${PROBE_TIMEOUT_MESSAGE} ${request.timeoutMs} ms.`)),
          request.timeoutMs,
        );
      });
      // A losing branch of a race still settles. Mark each one handled so a
      // late rejection never surfaces as an unhandled promise rejection.
      const ready = transport.ready;
      const closedEarly = transport.closed.then(
        () => {
          throw new Error('The media endpoint closed the session during the handshake.');
        },
        (reason: unknown) => {
          throw reason instanceof Error ? reason : new Error(String(reason));
        },
      );
      ready.catch(() => {});
      closedEarly.catch(() => {});
      timeout.catch(() => {});

      try {
        // `closed` settling before `ready` resolves means the peer answered on
        // UDP and then refused the session — a different problem from silence.
        await Promise.race([ready, timeout, closedEarly]);
        const rttMs = Math.round(now() - startedAt);
        let streamOpened = false;
        try {
          const stream = await Promise.race([transport.createBidirectionalStream(), timeout]);
          streamOpened = Boolean(stream);
          // The relay authenticates on this stream; the check deliberately
          // sends no token, so close it immediately rather than idling.
          try {
            await stream.writable.close();
          } catch {
            // Peer already reset the stream.
          }
        } catch {
          streamOpened = false;
        }
        return { ok: true, rttMs, streamOpened, failure: null, detail: null };
      } catch (error) {
        const elapsed = now() - startedAt;
        const { failure, detail } = classifyTransportError(error, elapsed, request.timeoutMs);
        return { ok: false, rttMs: null, streamOpened: false, failure, detail };
      } finally {
        if (timer) clearTimeout(timer);
        try {
          transport.close();
        } catch {
          // Already closed or never opened.
        }
      }
    },
  };
}

export function createBrowserAdapters(): DiagnosticsAdapters {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    environment: createEnvironmentAdapter(),
    capabilities: createCapabilityAdapter(),
    devices: createDeviceAdapter(),
    server: createServerAdapter(),
    transport: createTransportAdapter(now),
    now,
  };
}
