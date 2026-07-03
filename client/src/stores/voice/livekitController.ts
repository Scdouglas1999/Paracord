import { isTauri } from '../../lib/tauriEnv';
import { getStoredServerUrl, resolveApiBaseUrl } from '../../lib/apiBaseUrl';
import { useServerListStore } from '../serverListStore';

/**
 * LiveKit connection URL resolution.
 *
 * These helpers are pure with respect to the voice store: they translate the
 * server-provided signaling URL / candidate list into a prioritized list of
 * ws(s):// URLs the LiveKit room should try, factoring in the client's own
 * server connection, dev-proxy quirks, loopback rewrites, and Tauri behavior.
 * They are decomposed out of voiceStore.ts so the ordering logic can be unit
 * tested in isolation.
 */

const TAURI_FAST_CONNECT = isTauri();

const INTERNAL_LIVEKIT_HOSTS = new Set([
  'host.docker.internal',
  'livekit',
  'docker-livekit-1',
  '0.0.0.0',
  '::',
]);

function resolveClientRtcHostname(): string {
  if (typeof window === 'undefined') {
    return 'localhost';
  }
  const host = window.location.hostname;
  if (!host) {
    return 'localhost';
  }
  // Tauri and local dev hosts should map to loopback for local LiveKit.
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host.endsWith('.localhost')
  ) {
    return 'localhost';
  }
  return host;
}

function getApiDerivedServerBaseUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const apiBaseUrl = resolveApiBaseUrl();
    const parsed = new URL(apiBaseUrl, window.location.origin);
    if (!/^https?:$/.test(parsed.protocol)) {
      return null;
    }
    // Vite's WS proxy cannot carry LiveKit signaling, so in dev mode point
    // directly at the backend server (bypassing Vite).
    if (!import.meta.env.PROD && /:(5173|1420)\b/.test(parsed.host)) {
      return import.meta.env.VITE_DEV_PROXY_TARGET || 'https://localhost:8443';
    }
    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (
      pathname === '/api' ||
      pathname === '/api/v1' ||
      pathname === '/health' ||
      pathname === '/api/v1/health'
    ) {
      pathname = '';
    }
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return null;
  }
}

function getPreferredServerBaseUrl(): string | null {
  const apiDerivedBase = getApiDerivedServerBaseUrl();
  if (apiDerivedBase) {
    return apiDerivedBase;
  }
  const serverState = useServerListStore.getState();
  const activeServer = serverState.getActiveServer();
  if (activeServer?.url) {
    return activeServer.url;
  }
  const anyConnectedServer = serverState.servers.find((s) => s.connected);
  if (anyConnectedServer?.url) {
    return anyConnectedServer.url;
  }
  return getStoredServerUrl();
}

function toLivekitProxyUrlFromHttpBase(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${parsed.host}/livekit`;
  } catch {
    return null;
  }
}

function getWindowOriginLivekitUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  // In Tauri, window.location.origin is "https://tauri.localhost" which has
  // nothing to do with the actual Paracord server. Attempting to connect to
  // wss://tauri.localhost/livekit stalls for 30+ seconds on Windows DNS
  // resolution (mDNS/LLMNR) and is never valid. Skip it entirely.
  if (isTauri()) {
    return null;
  }
  const host = window.location.host;
  if (!host) {
    return null;
  }
  // Skip the window-origin candidate when running on a Vite dev server.
  // Vite's WebSocket proxy cannot handle LiveKit's signaling protocol,
  // so attempting it always fails and just delays the real connection.
  if (!import.meta.env.PROD && /:(5173|1420)\b/.test(host)) {
    return null;
  }
  const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsScheme}//${host}/livekit`;
}

function getEnvDirectLivekitUrl(): string | null {
  const raw = import.meta.env.VITE_LIVEKIT_DIRECT_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function allowDirectLivekitFallback(): boolean {
  const raw = import.meta.env.VITE_ENABLE_LIVEKIT_DIRECT_FALLBACK;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function allowNativeToLivekitFallback(): boolean {
  const raw = import.meta.env.VITE_ENABLE_NATIVE_TO_LIVEKIT_FALLBACK;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isLivekitProxyPath(pathname: string): boolean {
  const normalized = pathname.trim().replace(/\/+$/, '');
  return normalized === '/livekit' || normalized.startsWith('/livekit/');
}

export function parseUrlSafe(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isPrivateIpv4Hostname(hostname: string): boolean {
  const parts = hostname.trim().split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT range, often used by residential gateways.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  );
}

function allowLoopbackLivekitFallback(): boolean {
  const raw = import.meta.env.VITE_ENABLE_LIVEKIT_LOOPBACK_FALLBACK;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  // Keep this opt-in only. Rewriting remote candidates to localhost can break
  // desktop clients that are connected to a server on another machine.
  return false;
}

function buildLoopbackLivekitProxyVariants(candidate: string): string[] {
  if (typeof window === 'undefined') return [];
  if (!allowLoopbackLivekitFallback()) return [];
  if (!isLoopbackHostname(window.location.hostname)) return [];
  const parsed = parseUrlSafe(candidate);
  if (!parsed) return [];
  if (!isLivekitProxyPath(parsed.pathname)) return [];
  if (isLoopbackHostname(parsed.hostname)) return [];

  const port = parsed.port ? `:${parsed.port}` : '';
  const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return [`${parsed.protocol}//localhost${port}${suffix}`, `${parsed.protocol}//127.0.0.1${port}${suffix}`];
}

function expandLivekitCandidateVariants(candidate: string): string[] {
  const normalized = normalizeLivekitUrlFromServerValue(candidate);
  // When the client runs on loopback (desktop app/local dev), trying the
  // same /livekit endpoint on localhost first avoids unstable hairpin NAT
  // paths through the host's public IP.
  return [...buildLoopbackLivekitProxyVariants(normalized), normalized];
}

export function preferDirectLivekitCandidates(candidates: string[]): string[] {
  const direct: string[] = [];
  const proxied: string[] = [];
  const unknown: string[] = [];
  for (const candidate of candidates) {
    const parsed = parseUrlSafe(candidate);
    if (!parsed) {
      unknown.push(candidate);
      continue;
    }
    if (isLivekitProxyPath(parsed.pathname)) {
      proxied.push(candidate);
    } else {
      direct.push(candidate);
    }
  }

  // In Tauri, window.location.hostname is "tauri.localhost" which triggers
  // loopback detection, but the user may be connecting to a remote server.
  // Don't reorder candidates — the server already returns them in priority
  // order (public IP first). Reordering pushes the working URL behind
  // localhost URLs that fail due to TLS cert mismatch in WebView2.
  const runningOnLoopbackClient =
    typeof window !== 'undefined' && !isTauri() && isLoopbackHostname(window.location.hostname);
  if (runningOnLoopbackClient) {
    const proxiedLoopback: string[] = [];
    const proxiedPrivateLan: string[] = [];
    const proxiedPublic: string[] = [];
    for (const candidate of proxied) {
      const parsed = parseUrlSafe(candidate);
      if (!parsed) {
        proxiedPublic.push(candidate);
        continue;
      }
      if (isLoopbackHostname(parsed.hostname)) {
        proxiedLoopback.push(candidate);
      } else if (isPrivateIpv4Hostname(parsed.hostname)) {
        proxiedPrivateLan.push(candidate);
      } else {
        proxiedPublic.push(candidate);
      }
    }
    return [...proxiedLoopback, ...proxiedPrivateLan, ...proxiedPublic, ...direct, ...unknown];
  }

  // In production, /livekit proxy is the safest default. Direct endpoints
  // are optional fallbacks for deployments that explicitly expose LiveKit.
  return [...proxied, ...direct, ...unknown];
}

export function buildLivekitConnectCandidates(
  serverReturnedUrl: string,
  serverProvidedCandidates?: string[]
): string[] {
  const preferredBase = getPreferredServerBaseUrl();
  const preferredUrl = preferredBase ? toLivekitProxyUrlFromHttpBase(preferredBase) : null;
  const envDirectUrl = getEnvDirectLivekitUrl();
  const provided = Array.isArray(serverProvidedCandidates)
    ? serverProvidedCandidates.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const expandedCandidates = [
    ...provided,
    envDirectUrl,
    getWindowOriginLivekitUrl(),
    preferredUrl,
    serverReturnedUrl,
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => expandLivekitCandidateVariants(value));

  const deduped = Array.from(new Set(expandedCandidates));
  const ordered = preferDirectLivekitCandidates(deduped);
  if (allowDirectLivekitFallback()) {
    return ordered;
  }

  // In Tauri, prefer proxy URLs but keep direct URLs as a last-resort
  // fallback. Direct LiveKit ports (e.g. :7880) are usually not exposed
  // externally and fail with ERR_CONNECTION_REFUSED, wasting time.
  if (TAURI_FAST_CONNECT) {
    const proxiedOnly = ordered.filter((candidate) => {
      const parsed = parseUrlSafe(candidate);
      return parsed ? isLivekitProxyPath(parsed.pathname) : false;
    });
    return proxiedOnly.length > 0 ? proxiedOnly : ordered;
  }

  const proxiedOnly = ordered.filter((candidate) => {
    const parsed = parseUrlSafe(candidate);
    return parsed ? isLivekitProxyPath(parsed.pathname) : false;
  });
  return proxiedOnly.length > 0 ? proxiedOnly : ordered;
}

/**
 * Build the LiveKit proxy URL from the client's own server connection.
 *
 * Instead of relying on the server-returned URL (which may have the wrong
 * ws/wss protocol or hostname), we derive the WebSocket URL from the stored
 * server URL that the client already uses for API calls. This guarantees:
 *   - Correct protocol: https -> wss, http -> ws
 *   - Correct host:port (same as what the client is connected to)
 *   - The /livekit proxy path
 */
export function normalizeLivekitUrl(serverReturnedUrl: string, serverProvidedCandidates?: string[]): string {
  const candidates = buildLivekitConnectCandidates(serverReturnedUrl, serverProvidedCandidates);
  return candidates[0] ?? normalizeLivekitUrlFromServerValue(serverReturnedUrl);
}

export function normalizeLivekitUrlFromServerValue(serverReturnedUrl: string): string {
  // Legacy normalization for dev mode, Docker, and other setups.
  try {
    const parsed = new URL(serverReturnedUrl);
    if (INTERNAL_LIVEKIT_HOSTS.has(parsed.hostname)) {
      parsed.hostname = resolveClientRtcHostname();
    }
    // Ensure the URL uses a WebSocket protocol. LiveKit needs ws:// or wss://.
    let protocol = parsed.protocol;
    if (protocol === 'http:') protocol = 'ws:';
    else if (protocol === 'https:') protocol = 'wss:';
    // livekit-client can fail on URLs normalized to "...//rtc" when base path is "/".
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return serverReturnedUrl
      .replace('host.docker.internal', 'localhost')
      .replace('livekit', 'localhost')
      .replace('0.0.0.0', 'localhost')
      .replace('[::]', 'localhost')
      .replace('::', 'localhost')
      .replace(/\/+$/, '');
  }
}

/**
 * Probe a LiveKit candidate URL for reachability with a quick no-cors fetch.
 * - TLS failures (WebView2 rejecting self-signed certs) cause immediate rejection
 * - Reachable servers return an opaque response which we treat as success
 * Returns the original ws/wss URL on success.
 */
async function probeLivekitCandidate(url: string, timeoutMs: number): Promise<string> {
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(httpUrl, { mode: 'no-cors', signal: controller.signal });
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race all LiveKit candidates in parallel. Returns the first reachable URL.
 * Falls back to the first candidate in the list if every probe fails.
 */
export async function findReachableLivekitUrl(candidates: string[], timeoutMs = 3_000): Promise<string> {
  if (candidates.length <= 1) return candidates[0] ?? '';
  try {
    return await Promise.any(candidates.map((c) => probeLivekitCandidate(c, timeoutMs)));
  } catch {
    // All probes failed — fall back to first candidate and let room.connect()
    // produce the real error for diagnostics.
    return candidates[0]!;
  }
}
