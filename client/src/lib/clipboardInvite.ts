import { readClipboardText } from './clipboard';
import { parseInviteLink, type InviteLink } from './inviteLinks';
import { isTauri } from './tauriEnv';

/**
 * Offer an invite that is already on the clipboard (setup-spec §6.5).
 *
 * Rules, all of them here so a screen cannot get them wrong:
 *  - Desktop only. The browser build never reads the clipboard automatically.
 *  - Read when the watching screen mounts, and again whenever the window
 *    regains focus, but only while the screen says it is showing
 *    (`isActive`) and its field is empty (`fieldIsEmpty`).
 *  - Only the parser's result leaves this module. The text itself is never
 *    logged, stored or sent; a link that does not parse is dropped on the spot.
 *  - A link is offered once per app run: after it has been offered (and taken
 *    or ignored) the same link on the clipboard is not offered again.
 *  - A clipboard with nothing readable in it (empty, an image) is "no offer";
 *    any other read failure is reported to `onError` instead of swallowed.
 */

const offered = new Set<string>();

/** Forget which links were offered (tests, and sign-out). */
export function resetClipboardInviteMemory(): void {
  offered.clear();
}

/** The plugin's "there is no text on the clipboard" refusals, which are not errors. */
const NOTHING_TO_READ = /empty|not available|no text|content type|not supported|format/i;

/**
 * Read the clipboard once and return an invite link if it holds one that has
 * not been offered yet. Marks it offered. Null on the web.
 */
export async function peekClipboardInvite(): Promise<InviteLink | null> {
  if (!isTauri()) return null;
  let text: string;
  try {
    text = await readClipboardText();
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (NOTHING_TO_READ.test(message)) return null;
    throw reason;
  }
  const link = parseInviteLink(text);
  if (!link) return null;
  const key = `${link.serverUrl}|${link.code}`;
  if (offered.has(key)) return null;
  offered.add(key);
  return link;
}

export interface ClipboardInviteWatch {
  /** Whether the watching screen is showing (Welcome or the Join step). */
  isActive: () => boolean;
  /** Whether the invite field is still empty. */
  fieldIsEmpty: () => boolean;
  onInvite: (link: InviteLink) => void;
  onError?: (reason: unknown) => void;
}

/**
 * Start watching: one read now, then one per window focus. Returns the stop
 * function. Does nothing (and returns a no-op) outside the desktop app.
 */
export function watchClipboardInvite(watch: ClipboardInviteWatch): () => void {
  if (!isTauri() || typeof window === 'undefined') return () => undefined;
  let stopped = false;
  let reading = false;

  const check = async () => {
    if (stopped || reading || !watch.isActive() || !watch.fieldIsEmpty()) return;
    reading = true;
    try {
      const link = await peekClipboardInvite();
      // The screen may have changed while the read was in flight.
      if (link && !stopped && watch.isActive() && watch.fieldIsEmpty()) watch.onInvite(link);
    } catch (reason) {
      (watch.onError ?? ((r: unknown) => console.warn('[clipboard] could not read the clipboard:', r instanceof Error ? r.message : String(r))))(reason);
    } finally {
      reading = false;
    }
  };

  const onFocus = () => void check();
  window.addEventListener('focus', onFocus);
  void check();
  return () => {
    stopped = true;
    window.removeEventListener('focus', onFocus);
  };
}
