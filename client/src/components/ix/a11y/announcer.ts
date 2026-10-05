import { create } from 'zustand';

/**
 * The Index's one polite live region, paced (docs/index-spec.md §10: "One
 * polite live region announces events at most every 2s").
 *
 * `announce(text)` queues a sentence. The region speaks at once when it has
 * been quiet for two seconds; otherwise everything queued in the meantime is
 * said together, in order, when the two seconds are up (a burst of joins is one
 * announcement, not five interruptions). The text alternates a trailing
 * no-break space so the same words twice in a row are still a change a screen
 * reader hears.
 */

export const ANNOUNCE_GAP_MS = 2_000;

interface AnnouncerState {
  /** What the region holds now. */
  text: string;
}

export const useAnnouncerStore = create<AnnouncerState>(() => ({ text: '' }));

let queue: string[] = [];
let lastSpokenAt = Number.NEGATIVE_INFINITY;
let timer: ReturnType<typeof setTimeout> | null = null;
let flip = false;

/** A clock the wall clock cannot move (a pinned or corrected Date must not stall the pacing). */
function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function speak(now: number): void {
  timer = null;
  if (queue.length === 0) return;
  const words = queue.map(sentence).join(' ');
  queue = [];
  lastSpokenAt = now;
  flip = !flip;
  useAnnouncerStore.setState({ text: flip ? words : `${words}\u00a0` });
}

/** Say something in the polite region, at most once every two seconds. */
export function announce(text: string, now: number = monotonicNow()): void {
  if (!text.trim()) return;
  queue.push(text);
  if (timer) return;
  const wait = lastSpokenAt + ANNOUNCE_GAP_MS - now;
  if (wait <= 0) {
    speak(now);
    return;
  }
  timer = setTimeout(() => speak(monotonicNow()), wait);
}

/** Tests: forget the queue, the pacing and what was said. */
export function resetAnnouncer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queue = [];
  lastSpokenAt = Number.NEGATIVE_INFINITY;
  flip = false;
  useAnnouncerStore.setState({ text: '' });
}
