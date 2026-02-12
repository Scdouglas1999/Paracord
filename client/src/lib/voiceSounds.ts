/**
 * Voice channel join/leave sound effects using the Web Audio API.
 *
 * Generates short two-tone beeps similar to Discord:
 *   - Join: ascending tone (lower pitch -> higher pitch)
 *   - Leave: descending tone (higher pitch -> lower pitch)
 *
 * No external audio files are needed; everything is synthesized at runtime.
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Play a two-tone beep.
 *
 * @param freq1 - Frequency of the first tone in Hz
 * @param freq2 - Frequency of the second tone in Hz
 * @param toneDuration - Duration of each individual tone in seconds
 * @param volume - Gain level (0 to 1)
 */
function playTwoTone(
  freq1: number,
  freq2: number,
  toneDuration: number,
  volume: number,
): void {
  try {
    const ctx = getAudioContext();

    // Resume context if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const now = ctx.currentTime;

    // --- First tone ---
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq1, now);
    gain1.gain.setValueAtTime(volume, now);
    // Quick fade-out to avoid click
    gain1.gain.exponentialRampToValueAtTime(0.001, now + toneDuration);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + toneDuration);

    // --- Second tone ---
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq2, now + toneDuration);
    gain2.gain.setValueAtTime(volume, now + toneDuration);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + toneDuration * 2);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + toneDuration);
    osc2.stop(now + toneDuration * 2);
  } catch {
    // Silently ignore audio errors -- sound effects are non-critical
  }
}

/**
 * Play the voice channel join sound (ascending two-tone beep).
 */
export function playVoiceJoinSound(): void {
  // Ascending: 440 Hz (A4) -> 580 Hz (~D5)
  playTwoTone(440, 580, 0.12, 0.15);
}

/**
 * Play the voice channel leave sound (descending two-tone beep).
 */
export function playVoiceLeaveSound(): void {
  // Descending: 580 Hz (~D5) -> 440 Hz (A4)
  playTwoTone(580, 440, 0.12, 0.15);
}
