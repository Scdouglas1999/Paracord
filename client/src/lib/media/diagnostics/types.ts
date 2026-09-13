// Shared vocabulary for the guided voice connection check.
//
// The check exists because native QUIC/WebTransport media fails independently
// of HTTP chat: a server whose text channels work perfectly can still be
// unreachable for voice because UDP is not forwarded, because the browser will
// not pin the media certificate, or because the microphone was never granted.
// Every step below isolates exactly one of those causes so the answer is never
// "voice didn't work".
//
// Nothing in this module touches the user's active call. The runner only reads
// state; it never joins, leaves, mutes or reconfigures a session.

/** One of the isolated causes the check separates. */
export type DiagnosticStepId =
  | 'secure-context'
  | 'platform'
  | 'microphone'
  | 'speaker'
  | 'camera'
  | 'media-configuration'
  | 'certificate'
  | 'transport';

export type DiagnosticStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail' | 'skipped';

/**
 * Stable machine codes. These are the only identifiers safe to quote in a bug
 * report or paste into a support thread, so they must not change casually.
 */
export type DiagnosticCode =
  // secure context
  | 'SECURE_CONTEXT_OK'
  | 'SECURE_CONTEXT_INSECURE'
  // platform capability
  | 'PLATFORM_OK'
  | 'PLATFORM_NO_WEBTRANSPORT'
  | 'PLATFORM_NO_MEDIA_DEVICES'
  | 'PLATFORM_NO_AUDIO_WORKLET'
  | 'PLATFORM_NO_OPUS'
  | 'PLATFORM_NO_VP9'
  // microphone
  | 'MIC_OK'
  | 'MIC_SILENT'
  | 'MIC_DENIED'
  | 'MIC_NOT_FOUND'
  | 'MIC_IN_USE'
  | 'MIC_SELECTED_DEVICE_MISSING'
  | 'MIC_FAILED'
  // speaker
  | 'SPEAKER_OK'
  | 'SPEAKER_NOT_HEARD'
  | 'SPEAKER_ROUTING_UNSUPPORTED'
  | 'SPEAKER_SELECTED_DEVICE_MISSING'
  | 'SPEAKER_FAILED'
  // camera
  | 'CAMERA_OK'
  | 'CAMERA_DENIED'
  | 'CAMERA_NOT_FOUND'
  | 'CAMERA_IN_USE'
  | 'CAMERA_FAILED'
  // server media configuration
  | 'MEDIA_CONFIG_NATIVE'
  | 'MEDIA_CONFIG_LIVEKIT'
  | 'MEDIA_CONFIG_NONE'
  | 'MEDIA_CONFIG_UNREACHABLE'
  | 'MEDIA_CONFIG_INVALID'
  // certificate
  | 'CERTIFICATE_PINNED'
  | 'CERTIFICATE_PIN_MISSING'
  | 'CERTIFICATE_PIN_MALFORMED'
  | 'CERTIFICATE_PINNING_UNSUPPORTED'
  // transport
  | 'TRANSPORT_OK'
  | 'TRANSPORT_UNREACHABLE'
  | 'TRANSPORT_TIMEOUT'
  | 'TRANSPORT_CERTIFICATE_REFUSED'
  | 'TRANSPORT_HANDSHAKE_FAILED'
  | 'TRANSPORT_CLOSED_EARLY'
  | 'TRANSPORT_UNSUPPORTED'
  | 'TRANSPORT_FAILED'
  // shared
  | 'SKIPPED_PREREQUISITE'
  | 'SKIPPED_NOT_APPLICABLE'
  | 'CANCELLED';

/** A fact worth exporting. Values are primitives only so redaction is total. */
export type DiagnosticDetail = Record<string, string | number | boolean | null>;

export interface DiagnosticStepResult {
  id: DiagnosticStepId;
  /** Short heading shown in the step list. */
  title: string;
  status: DiagnosticStatus;
  code: DiagnosticCode | null;
  /** One sentence, plain language, describing what happened. */
  summary: string;
  /** What the user or their operator should do next. Empty when nothing to do. */
  remedy: string;
  detail: DiagnosticDetail;
  durationMs: number;
}

export interface DiagnosticEnvironmentFacts {
  /** 'browser' or 'desktop' — which media engine would actually be used. */
  engine: 'browser' | 'desktop';
  isSecureContext: boolean;
  protocol: string;
  /** Host with any embedded credentials removed. */
  host: string;
  userAgent: string;
  language: string;
}

/** The server's answer from `GET /api/v1/voice/transport-diagnostics`. */
export interface MediaTransportConfig {
  transport: 'native' | 'livekit' | 'none';
  voiceAvailable: boolean;
  mediaEndpoint: string | null;
  mediaEndpointCandidates: string[];
  mediaUdpPort: number | null;
  certificatePinSha256: string | null;
  certificateSource: 'server-generated-self-signed' | 'none';
  livekitAvailable: boolean;
  e2eeRequired: boolean;
  maxParticipants: number | null;
}

export interface DiagnosticReport {
  /** Report schema version, bumped when the exported shape changes. */
  version: 1;
  startedAt: string;
  finishedAt: string;
  /** Display name of the signed-in account. Never an account id. */
  account: string | null;
  /** Server origin with credentials stripped. */
  serverOrigin: string | null;
  environment: DiagnosticEnvironmentFacts;
  transportConfig: MediaTransportConfig | null;
  steps: DiagnosticStepResult[];
  /** Worst status across the steps: what the user is told at the top. */
  overall: 'pass' | 'warn' | 'fail';
}
