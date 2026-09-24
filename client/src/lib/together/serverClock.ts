/**
 * An estimate of each server's clock.
 *
 * Every sample is a round trip whose far end stamped `server_time_ms`: the
 * gateway heartbeat ACK and every Together REST answer. Assuming the stamp was
 * taken halfway through, `offset = server - (sent + rtt / 2)`, and the error is
 * at most rtt / 2 — so the estimate is the sample with the shortest round trip
 * among recent ones.
 */

interface ClockSample {
  offsetMs: number;
  rttMs: number;
  takenAtMs: number;
}

const MAX_SAMPLES = 8;
/** Clocks drift and networks change; forget samples older than this. */
const SAMPLE_TTL_MS = 10 * 60 * 1000;

const samples = new Map<string, ClockSample[]>();

/**
 * Record one round trip. `sentAtMs`/`receivedAtMs` are this device's wall clock
 * (`Date.now()`) around the request; `serverTimeMs` is what the server stamped.
 */
export function recordClockSample(
  serverId: string,
  sentAtMs: number,
  receivedAtMs: number,
  serverTimeMs: number,
): void {
  if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return;
  const rttMs = Math.max(0, receivedAtMs - sentAtMs);
  const sample: ClockSample = {
    offsetMs: serverTimeMs - (sentAtMs + rttMs / 2),
    rttMs,
    takenAtMs: receivedAtMs,
  };
  const list = (samples.get(serverId) ?? []).filter((s) => receivedAtMs - s.takenAtMs < SAMPLE_TTL_MS);
  list.push(sample);
  while (list.length > MAX_SAMPLES) list.shift();
  samples.set(serverId, list);
}

/** Best current offset (server − local) in ms, or null before any sample. */
export function clockOffsetMs(serverId: string, nowMs = Date.now()): number | null {
  const list = (samples.get(serverId) ?? []).filter((s) => nowMs - s.takenAtMs < SAMPLE_TTL_MS);
  if (list.length === 0) return null;
  let best = list[0];
  for (const sample of list) if (sample.rttMs < best.rttMs) best = sample;
  return best.offsetMs;
}

/** The server's clock right now, as well as this device can tell. */
export function serverNowMs(serverId: string, nowMs = Date.now()): number {
  return nowMs + (clockOffsetMs(serverId, nowMs) ?? 0);
}

/** Tests only. */
export function resetServerClocks(): void {
  samples.clear();
}
