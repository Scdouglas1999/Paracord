/**
 * The Stage's transport readout (docs/lantern-stage-spec.md §7.2).
 *
 * The reference artboard draws "12 ms · QUIC" in the dominant tile's top-right
 * corner. The transport half is real: the desktop/browser media engine carries
 * media over QUIC (WebTransport), and the LiveKit path carries it over WebRTC.
 *
 * **There is no round-trip figure on either path**, so this never prints one.
 * `MediaEngine` (`src/lib/media/mediaEngine.ts`) exposes capabilities, published
 * tracks and subscriptions but no RTT, and LiveKit reports a coarse
 * `ConnectionQuality` rather than a latency. The engines are WP3-immutable, and
 * inventing a plausible number would be exactly the silent-degradation the
 * project forbids — so the readout says the link state it can actually observe
 * and nothing else. The day an engine reports a real RTT, `latencyMs` below is
 * where it lands and every Stage improves at once.
 */

/** How the call's media is actually travelling. */
export type CallTransport = 'quic' | 'webrtc';

/** The coarse link health LiveKit reports. The native path reports none. */
export type LinkQuality = 'stable' | 'unstable' | 'lost';

export interface TransportReadoutInput {
  transport: CallTransport | null;
  /** Only the LiveKit path has one. */
  quality?: LinkQuality | null;
  /** A measured round trip, when a transport ever reports one. */
  latencyMs?: number | null;
}

const TRANSPORT_LABEL: Record<CallTransport, string> = {
  quic: 'QUIC',
  webrtc: 'WebRTC',
};

/**
 * "12 ms · QUIC" · "QUIC" · "WebRTC · unstable" · null when nothing is known.
 *
 * Null means the tile draws no readout — an empty corner is honest, an
 * invented number is not.
 */
export function transportReadout({
  transport,
  quality = null,
  latencyMs = null,
}: TransportReadoutInput): string | null {
  if (!transport) return null;
  const parts: string[] = [];
  if (latencyMs != null && Number.isFinite(latencyMs)) parts.push(`${Math.round(latencyMs)} ms`);
  parts.push(TRANSPORT_LABEL[transport]);
  if (quality && quality !== 'stable') parts.push(quality);
  return parts.join(' · ');
}

/** Which transport a call is on, from the two engine handles the store holds. */
export function callTransport(input: {
  hasMediaEngine: boolean;
  hasRoom: boolean;
}): CallTransport | null {
  if (input.hasMediaEngine) return 'quic';
  if (input.hasRoom) return 'webrtc';
  return null;
}
