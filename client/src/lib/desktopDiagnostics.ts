let invokeLoader: Promise<((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null> | null =
  null;
let flushInFlight = false;
const pendingLines: string[] = [];
const MAX_BUFFERED_LINES = 400;
const MAX_REDACTION_DEPTH = 6;
const REDACTED = '[redacted]';
const SENSITIVE_KEY_RE =
  /(authorization|csrf|jwt|password|passcode|secret|token|refresh|session_id|media_token|webhook|private[_-]?key|signing[_-]?key)/i;
const SENSITIVE_QUERY_RE =
  /([?&](?:token|access_token|refresh_token|media_token|session_id|csrf|secret|password|webhook_token)=)[^&#\s]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function getGlobalInvoke():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
  };
  if (typeof win.__TAURI_INTERNALS__?.invoke === 'function') {
    return win.__TAURI_INTERNALS__.invoke;
  }
  if (typeof win.__TAURI__?.core?.invoke === 'function') {
    return win.__TAURI__.core.invoke;
  }
  return null;
}

async function getInvoke() {
  const globalInvoke = getGlobalInvoke();
  if (globalInvoke) return globalInvoke;
  if (!invokeLoader) {
    invokeLoader = import('@tauri-apps/api/core')
      .then((mod) => mod.invoke)
      .catch(() => null);
  }
  return invokeLoader;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(JWT_RE, REDACTED)
    .replace(SENSITIVE_QUERY_RE, `$1${REDACTED}`);
}

export function redactDiagnosticValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_REDACTION_DEPTH) return '[truncated]';

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_KEY_RE.test(key)
      ? REDACTED
      : redactDiagnosticValue(entry, depth + 1, seen);
  }
  return redacted;
}

function safeSerialize(value: unknown): string {
  if (value == null) return '';
  const redacted = redactDiagnosticValue(value);
  if (typeof redacted === 'string') return redacted;
  try {
    return JSON.stringify(redacted);
  } catch {
    return redactString(String(value));
  }
}

async function flushClientDiagnostics() {
  if (flushInFlight) return;
  flushInFlight = true;
  try {
    const invoke = await getInvoke();
    if (!invoke) {
      pendingLines.length = 0;
      return;
    }
    while (pendingLines.length > 0) {
      const line = pendingLines.shift();
      if (!line) continue;
      try {
        await invoke('append_client_log', { line });
      } catch {
        // Keep logging non-fatal.
      }
    }
  } finally {
    flushInFlight = false;
  }
}

export async function getDesktopDiagnosticsLogPath(): Promise<string | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    const path = await invoke('get_client_log_path');
    return typeof path === 'string' ? path : null;
  } catch {
    return null;
  }
}

export function logVoiceDiagnostic(message: string, extra?: unknown) {
  const timestamp = new Date().toISOString();
  const serializedExtra = safeSerialize(extra);
  const line = serializedExtra.length > 0 ? `${timestamp} ${message} ${serializedExtra}` : `${timestamp} ${message}`;
  pendingLines.push(line);
  if (pendingLines.length > MAX_BUFFERED_LINES) {
    pendingLines.splice(0, pendingLines.length - MAX_BUFFERED_LINES);
  }
  void flushClientDiagnostics();
}

logVoiceDiagnostic('[voice] desktop diagnostics initialized');
