// Redacted export of a connection-check report.
//
// The report is meant to be pasted into a support thread or sent to a server
// operator, so it must never carry anything that could impersonate the user.
// By construction the check collects no tokens, cookies or account ids; this
// module is the second line of defense — every value also passes through the
// shared diagnostic redactor, and every URL has any embedded credentials and
// query secrets removed before it is written out.

import { redactDiagnosticValue } from '../../desktopDiagnostics';
import { stripUrlCredentials } from './browserAdapters';
import type { DiagnosticReport, DiagnosticStepResult } from './types';

/** Values whose presence in an export would be a defect, used by the tests. */
export const FORBIDDEN_EXPORT_KEYS = [
  'token',
  'media_token',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'password',
  'secret',
  'jwt',
  'session_id',
  'user_id',
  'account_id',
];

/**
 * Remove a `//user:password@` credential pair wherever it appears inside free
 * text. Step summaries quote the endpoint they tried, so scrubbing only the
 * structured URL fields would leave a credential in a human-readable sentence.
 */
export function stripEmbeddedCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s:]+:[^/@\s]*@/g, '//');
}

function deepStripCredentials(value: unknown): unknown {
  if (typeof value === 'string') return stripEmbeddedCredentials(value);
  if (Array.isArray(value)) return value.map(deepStripCredentials);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        deepStripCredentials(entry),
      ]),
    );
  }
  return value;
}

function scrubUrl(value: string | null): string | null {
  if (!value) return value;
  const stripped = stripUrlCredentials(value);
  // Query strings never belong in a media endpoint; drop them wholesale rather
  // than trying to decide which parameters are safe.
  const query = stripped.indexOf('?');
  return query === -1 ? stripped : stripped.slice(0, query);
}

/**
 * Produce the exact object written to the export file: redacted, credential
 * free and free of account identifiers beyond the signed-in display name.
 */
export function buildRedactedReport(report: DiagnosticReport): Record<string, unknown> {
  const scrubbed: DiagnosticReport = {
    ...report,
    serverOrigin: scrubUrl(report.serverOrigin),
    environment: {
      ...report.environment,
      host: stripUrlCredentials(report.environment.host),
    },
    transportConfig: report.transportConfig
      ? {
          ...report.transportConfig,
          mediaEndpoint: scrubUrl(report.transportConfig.mediaEndpoint),
          mediaEndpointCandidates: report.transportConfig.mediaEndpointCandidates
            .map((entry) => scrubUrl(entry))
            .filter((entry): entry is string => entry !== null),
          // The fingerprint identifies the server, not the user, but the full
          // value adds nothing to a bug report — a prefix is enough to compare.
          certificatePinSha256: report.transportConfig.certificatePinSha256
            ? `${report.transportConfig.certificatePinSha256.slice(0, 12)}…`
            : null,
        }
      : null,
    steps: report.steps.map((step) => ({
      ...step,
      detail: Object.fromEntries(
        Object.entries(step.detail).map(([key, value]) => [
          key,
          typeof value === 'string' ? scrubUrl(value) ?? value : value,
        ]),
      ),
    })) as DiagnosticStepResult[],
  };
  return deepStripCredentials(redactDiagnosticValue(scrubbed)) as Record<string, unknown>;
}

export function diagnosticsExportFilename(report: DiagnosticReport): string {
  const account = (report.account ?? 'account').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
  const day = report.finishedAt.slice(0, 10);
  return `paracord-voice-check-${account || 'account'}-${day}.json`;
}

export function diagnosticsExportJson(report: DiagnosticReport): string {
  return JSON.stringify(buildRedactedReport(report), null, 2);
}

const STATUS_MARK: Record<DiagnosticStepResult['status'], string> = {
  pending: '·',
  running: '…',
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skipped: 'SKIP',
};

/** A plain-text rendering for pasting into chat or an issue. */
export function diagnosticsExportText(report: DiagnosticReport): string {
  const redacted = buildRedactedReport(report) as unknown as DiagnosticReport;
  const lines: string[] = [
    'Paracord voice connection check',
    `Result: ${redacted.overall.toUpperCase()}`,
    `Finished: ${redacted.finishedAt}`,
    `Account: ${redacted.account ?? '(not signed in)'}`,
    `Server: ${redacted.serverOrigin ?? '(unknown)'}`,
    `Client: ${redacted.environment.engine} · ${redacted.environment.userAgent}`,
    '',
  ];
  for (const step of redacted.steps) {
    lines.push(`[${STATUS_MARK[step.status]}] ${step.title} (${step.durationMs} ms)`);
    if (step.code) lines.push(`       code: ${step.code}`);
    if (step.summary) lines.push(`       ${step.summary}`);
    if (step.remedy) lines.push(`       fix: ${step.remedy}`);
    const detail = Object.entries(step.detail);
    if (detail.length > 0) {
      lines.push(`       detail: ${detail.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Write the redacted report to a file the user can attach to a support thread. */
export function downloadDiagnostics(
  report: DiagnosticReport,
  doc: Document = document,
): void {
  const blob = new Blob([diagnosticsExportJson(report)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = diagnosticsExportFilename(report);
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
