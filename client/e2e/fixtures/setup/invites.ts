import type { Page, Route } from '@playwright/test';
import { KANTO } from './scene';

/**
 * Scripted invite previews (spec 6.1) and the identity each host presents
 * (spec 7). One scenario per code; a spec opens
 * `https://kanto.home.arpa:8443/invite/<code>` and the app sees exactly what
 * the scenario says. Nothing here touches a network.
 *
 *   code           what it is
 *   Rf8kQ2         a good server, self-signed (first contact: the card shows four words)
 *   CaOk1          a good server whose certificate a public CA issued (no words)
 *   Gone404        the invite is used up or expired (404)
 *   Unreach1       the server cannot be reached (connection refused)
 *   OldSrv1        an older server: the preview has no `instance` (spec 3.12)
 *   Changed1       the same host as Rf8kQ2 but a different certificate than the one pinned
 */
export type InviteCode = 'Rf8kQ2' | 'CaOk1' | 'Gone404' | 'Unreach1' | 'OldSrv1' | 'Changed1';

export interface HostIdentity {
  /** Lowercase hex SHA-256 of the leaf certificate, as `probe_server` returns it. */
  fingerprint: string | null;
  caVerified: boolean;
}

/** Fingerprints are fixed so the four words are fixed. Two different certificates for one host: `Changed1` presents the second. */
export const FINGERPRINT = {
  kanto: 'a1f3c97e0b52d684e1a07bc39d55f2486e7013ab94c8d02f5e61b7a30c94d8e1',
  kantoReissued: '5c08de4a97b1f62033e8a94d7c1b05fe2a6d8394b07c51ee9f3a42d68b1c07a9',
  ca: '0e6d2b94a7c1385f90be4d12c6a83f57b1d09e4a62c7f385a0d41b96e8c27f53',
} as const;

export interface InviteScenario {
  code: InviteCode;
  host: string;
  /** What `GET /api/v1/invites/{code}` answers: a status and a body, or a refusal to connect. */
  answer: { status: number; body: unknown } | { refuse: true };
  identity: HostIdentity;
}

const GOOD_PREVIEW = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  guild: { id: '410000000000000001', name: KANTO.name, hue: KANTO.hue, online_count: KANTO.online, member_count: KANTO.members, icon_hash: null },
  join_gate: null,
  faces: KANTO.faces.map((f) => ({ ...f })),
  expires_at: '2026-10-19T20:30:00Z',
  instance: { name: KANTO.name, version: '3.5.0', credential_version: 2, registration_mode: 'open', require_email: false },
  ...extra,
});

export const INVITES: Record<InviteCode, InviteScenario> = {
  Rf8kQ2: { code: 'Rf8kQ2', host: 'kanto.home.arpa', answer: { status: 200, body: GOOD_PREVIEW('Rf8kQ2') }, identity: { fingerprint: FINGERPRINT.kanto, caVerified: false } },
  CaOk1: { code: 'CaOk1', host: 'kanto.example.com', answer: { status: 200, body: GOOD_PREVIEW('CaOk1') }, identity: { fingerprint: FINGERPRINT.ca, caVerified: true } },
  Gone404: { code: 'Gone404', host: 'kanto.home.arpa', answer: { status: 404, body: { code: 'invite_not_found', message: 'Invite not found' } }, identity: { fingerprint: FINGERPRINT.kanto, caVerified: false } },
  Unreach1: { code: 'Unreach1', host: 'nowhere.home.arpa', answer: { refuse: true }, identity: { fingerprint: null, caVerified: false } },
  OldSrv1: {
    code: 'OldSrv1',
    host: 'kanto.home.arpa',
    answer: { status: 200, body: (({ instance: _instance, ...rest }) => rest)(GOOD_PREVIEW('OldSrv1')) },
    identity: { fingerprint: FINGERPRINT.kanto, caVerified: false },
  },
  Changed1: { code: 'Changed1', host: 'kanto.home.arpa', answer: { status: 200, body: GOOD_PREVIEW('Changed1') }, identity: { fingerprint: FINGERPRINT.kantoReissued, caVerified: false } },
};

export const inviteUrl = (code: InviteCode, port: number = KANTO.port): string => `https://${INVITES[code].host}:${port}/invite/${code}`;
export const portableInviteUrl = (code: InviteCode): string => `paracord://invite/${INVITES[code].host}:${KANTO.port}/${code}`;

/** Which identity a host presents right now (a spec can change it mid-test: the certificate changed). */
export class Directory {
  /** Hosts a spec has re-keyed: host -> identity. */
  private readonly overrides = new Map<string, HostIdentity>();

  identityOf(host: string): HostIdentity {
    const hostOnly = host.replace(/:\d+$/, '');
    const forced = this.overrides.get(hostOnly);
    if (forced) return forced;
    const found = Object.values(INVITES).find((s) => s.host === hostOnly && s.code !== 'Changed1');
    return found?.identity ?? { fingerprint: null, caVerified: false };
  }

  /** The host's certificate changes: every later probe sees `identity`. */
  rekey(host: string, identity: HostIdentity): void {
    this.overrides.set(host.replace(/:\d+$/, ''), identity);
  }
}

/**
 * Answer `GET /api/v1/invites/{code}` (and the two calls a join makes before an
 * account exists) from the scenarios. Call before the first `page.goto`; routes
 * are last-wins, so a spec can override one.
 */
export async function installInviteRoutes(page: Page, log: (m: string, p: string) => void): Promise<void> {
  const answerInvite = async (route: Route, code: string): Promise<void> => {
    const scenario = (INVITES as Record<string, InviteScenario>)[code];
    if (!scenario) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'invite_not_found', message: 'Invite not found' }) });
    if ('refuse' in scenario.answer) return route.abort('connectionrefused');
    return route.fulfill({ status: scenario.answer.status, contentType: 'application/json', body: JSON.stringify(scenario.answer.body) });
  };
  await page.route('**/api/v1/invites/*', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      log(request.method(), new URL(request.url()).pathname);
      return route.fulfill({ status: 405, contentType: 'application/json', body: '{"code":"method_not_allowed"}' });
    }
    return answerInvite(route, new URL(request.url()).pathname.split('/').pop() ?? '');
  });
}
