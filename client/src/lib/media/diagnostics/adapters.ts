// Adapter surface for the voice connection check.
//
// Every environment-touching capability the check needs is expressed here as a
// narrow interface so the step runner itself stays pure and is unit-testable
// with fakes. The real browser implementations live in `browserAdapters.ts`.

import type {
  DiagnosticEnvironmentFacts,
  MediaTransportConfig,
} from './types';

export interface DiagnosticDevice {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput' | 'videoinput';
  label: string;
}

export type PermissionOutcome = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface MicrophoneMeasurement {
  /** Highest absolute sample seen, 0..1. */
  peak: number;
  /** Root-mean-square level over the whole window, 0..1. */
  rms: number;
  sampledMs: number;
  /** Label of the track that actually opened, which may differ from the request. */
  deviceLabel: string | null;
}

export interface MicrophoneRequest {
  deviceId?: string | null;
  durationMs: number;
  onLevel?: (level: number) => void;
  signal?: AbortSignal;
}

export interface TestToneRequest {
  deviceId?: string | null;
  durationMs: number;
  signal?: AbortSignal;
}

export interface TestToneOutcome {
  /**
   * Whether the tone was actually routed to the selected output device. False
   * when the platform cannot steer audio output, which is reported rather than
   * silently pretending the selection was honored.
   */
  routedToSelectedDevice: boolean;
}

export interface CameraOutcome {
  label: string | null;
}

export interface TransportProbeRequest {
  endpoint: string;
  certificatePinSha256: string | null;
  timeoutMs: number;
}

export type TransportFailure =
  | 'timeout'
  | 'unreachable'
  | 'certificate-refused'
  | 'handshake-failed'
  | 'closed-early'
  | 'unsupported'
  | 'unknown';

export interface TransportProbeOutcome {
  /** A QUIC/WebTransport session reached the media endpoint and became ready. */
  ok: boolean;
  /** Milliseconds from dialing to session ready. */
  rttMs: number | null;
  /** The peer accepted a stream on the established session. */
  streamOpened: boolean;
  failure: TransportFailure | null;
  /** Raw platform error text, kept for the export after redaction. */
  detail: string | null;
}

export interface EnvironmentAdapter {
  read(): DiagnosticEnvironmentFacts;
}

export interface CapabilityAdapter {
  hasWebTransport(): boolean;
  /** Whether the platform can pin a self-signed media certificate by hash. */
  supportsCertificatePinning(): boolean;
  hasMediaDevices(): boolean;
  hasAudioWorklet(): boolean;
  supportsOpus(): Promise<boolean>;
  supportsVp9(): Promise<boolean>;
}

export interface DeviceAdapter {
  permission(kind: 'microphone' | 'camera'): Promise<PermissionOutcome>;
  enumerate(): Promise<DiagnosticDevice[]>;
  measureMicrophone(request: MicrophoneRequest): Promise<MicrophoneMeasurement>;
  playTestTone(request: TestToneRequest): Promise<TestToneOutcome>;
  openCamera(request: { deviceId?: string | null; signal?: AbortSignal }): Promise<CameraOutcome>;
}

export interface ServerAdapter {
  fetchTransportConfig(signal?: AbortSignal): Promise<MediaTransportConfig>;
}

export interface TransportAdapter {
  probe(request: TransportProbeRequest): Promise<TransportProbeOutcome>;
}

export interface DiagnosticsAdapters {
  environment: EnvironmentAdapter;
  capabilities: CapabilityAdapter;
  devices: DeviceAdapter;
  server: ServerAdapter;
  transport: TransportAdapter;
  /** Monotonic milliseconds. Injected so timings are deterministic in tests. */
  now: () => number;
  /**
   * Ask the person running the check a yes/no question (the speaker test needs
   * one). When absent the speaker step reports that it could not be confirmed
   * rather than assuming success.
   */
  ask?: (question: string) => Promise<boolean>;
}
