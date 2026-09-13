import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/activeClient', () => ({ getApi: () => ({ get: vi.fn() }) }));

import {
  FORBIDDEN_EXPORT_KEYS,
  buildRedactedReport,
  diagnosticsExportFilename,
  diagnosticsExportJson,
  diagnosticsExportText,
  downloadDiagnostics,
} from './export';
import type { DiagnosticReport } from './types';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEyMzQ1Njc4OTAsInJvb20iOiIxOjIifQ.c2lnbmF0dXJlLXZhbHVl';

function report(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    version: 1,
    startedAt: '2026-09-12T10:00:00.000Z',
    finishedAt: '2026-09-12T10:00:12.000Z',
    account: 'Ada Lovelace',
    serverOrigin: 'https://ada:hunter2@chat.example.com',
    environment: {
      engine: 'browser',
      isSecureContext: true,
      protocol: 'https:',
      host: 'ada:hunter2@chat.example.com',
      userAgent: 'Mozilla/5.0 Chrome/130.0.0.0',
      language: 'en-GB',
    },
    transportConfig: {
      transport: 'native',
      voiceAvailable: true,
      mediaEndpoint: 'https://chat.example.com:8443/media?media_token=' + JWT,
      mediaEndpointCandidates: ['https://ada:hunter2@10.0.0.4:8443/media'],
      mediaUdpPort: 8443,
      certificatePinSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      certificateSource: 'server-generated-self-signed',
      livekitAvailable: false,
      e2eeRequired: true,
      maxParticipants: 50,
    },
    steps: [
      {
        id: 'transport',
        title: 'Voice connection',
        status: 'fail',
        code: 'TRANSPORT_TIMEOUT',
        summary: 'Nothing answered at the media endpoint.',
        remedy: 'Ask the operator to forward UDP port 8443.',
        detail: {
          endpoint: 'https://chat.example.com:8443/media',
          udp_port: 8443,
          rtt_ms: null,
          // A raw platform error that happens to contain a bearer credential.
          error: `Authorization: Bearer ${JWT} refused`,
        },
        durationMs: 8000,
      },
    ],
    overall: 'fail',
    ...overrides,
  };
}

describe('buildRedactedReport', () => {
  it('removes credentials embedded in every URL it carries', () => {
    const redacted = JSON.stringify(buildRedactedReport(report()));
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('https://chat.example.com');
    expect(redacted).toContain('https://10.0.0.4:8443/media');
  });

  it('drops query strings from media endpoints rather than judging each parameter', () => {
    const redacted = JSON.stringify(buildRedactedReport(report()));
    expect(redacted).not.toContain('media_token=');
  });

  it('redacts a JWT that leaked into a raw platform error', () => {
    const redacted = JSON.stringify(buildRedactedReport(report()));
    expect(redacted).not.toContain(JWT);
    expect(redacted).not.toMatch(/Bearer\s+ey/);
  });

  it('shortens the certificate fingerprint to a comparable prefix', () => {
    const redacted = buildRedactedReport(report()) as {
      transportConfig: { certificatePinSha256: string };
    };
    expect(redacted.transportConfig.certificatePinSha256).toBe('AAAAAAAAAAAA…');
  });

  it('carries the display name and no account identifier', () => {
    const redacted = JSON.stringify(buildRedactedReport(report()));
    expect(redacted).toContain('Ada Lovelace');
    for (const key of FORBIDDEN_EXPORT_KEYS) {
      expect(redacted.toLowerCase()).not.toContain(`"${key}":`);
    }
  });

  it('keeps the evidence an operator needs', () => {
    const redacted = JSON.stringify(buildRedactedReport(report()));
    expect(redacted).toContain('TRANSPORT_TIMEOUT');
    expect(redacted).toContain('8443');
    expect(redacted).toContain('Chrome/130.0.0.0');
    expect(redacted).toContain('forward UDP port 8443');
  });
});

describe('diagnosticsExportJson', () => {
  it('is valid JSON with the schema version', () => {
    const parsed = JSON.parse(diagnosticsExportJson(report())) as { version: number };
    expect(parsed.version).toBe(1);
  });
});

describe('diagnosticsExportText', () => {
  it('renders a readable, redacted summary', () => {
    const text = diagnosticsExportText(report());
    expect(text).toContain('Paracord voice connection check');
    expect(text).toContain('Result: FAIL');
    expect(text).toContain('[FAIL] Voice connection');
    expect(text).toContain('code: TRANSPORT_TIMEOUT');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(JWT);
  });
});

describe('diagnosticsExportFilename', () => {
  it('follows the existing export naming convention', () => {
    expect(diagnosticsExportFilename(report())).toBe('paracord-voice-check-Ada-Lovelace-2026-09-12.json');
  });

  it('copes with an account that has no display name', () => {
    expect(diagnosticsExportFilename(report({ account: null }))).toBe(
      'paracord-voice-check-account-2026-09-12.json',
    );
  });
});

describe('downloadDiagnostics', () => {
  it('writes a single file and cleans up the object URL', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:fake');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.fn();
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement;
    const doc = {
      createElement: vi.fn().mockReturnValue(anchor),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    } as unknown as Document;

    downloadDiagnostics(report(), doc);

    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('paracord-voice-check-Ada-Lovelace-2026-09-12.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    vi.unstubAllGlobals();
  });
});
