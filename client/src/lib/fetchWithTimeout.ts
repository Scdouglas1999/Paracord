type TimeoutCapableAbortSignal = typeof AbortSignal & {
  timeout?: (ms: number) => AbortSignal;
};

/**
 * Browser-compatible fetch timeout helper.
 * Falls back to AbortController when AbortSignal.timeout is unavailable.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const timeoutFactory = (AbortSignal as TimeoutCapableAbortSignal).timeout;
  if (typeof timeoutFactory === 'function') {
    return fetch(input, {
      ...init,
      signal: init.signal ?? timeoutFactory(timeoutMs),
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let removeAbortListener: (() => void) | null = null;

  if (init.signal) {
    const forwardAbort = () => controller.abort();
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener('abort', forwardAbort, { once: true });
      removeAbortListener = () => init.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
  }
}
