import { isTauri } from './tauriEnv';

/**
 * Clipboard access (setup-spec §6.5).
 *
 * Desktop goes through `tauri-plugin-clipboard-manager` (the webview's own
 * clipboard API is unreliable under WebKitGTK and Wayland, and cannot read at
 * all without a user gesture). The browser build uses `navigator.clipboard` for
 * writes and never reads on its own. The plugin's commands are invoked by name
 * (`plugin:clipboard-manager|…`); the plugin's JS package is a thin wrapper
 * over exactly these calls, so no extra dependency is carried.
 */

async function pluginInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`plugin:clipboard-manager|${command}`, args);
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    await pluginInvoke<void>('write_text', { text });
    return;
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable.');
  }
  await navigator.clipboard.writeText(text);
}

/**
 * Read the clipboard's text. Desktop only: the browser build must never read
 * the clipboard unprompted, so calling this there is a programming error.
 */
export async function readClipboardText(): Promise<string> {
  if (!isTauri()) {
    throw new Error('The clipboard can only be read automatically in the desktop app.');
  }
  return pluginInvoke<string>('read_text');
}

async function clearClipboard(): Promise<void> {
  await pluginInvoke<void>('clear');
}

/** How long a copied secret stays on the clipboard. */
export const SECRET_CLIPBOARD_TTL_MS = 60_000;

export interface SecretCopy {
  /** True when the app will clear the clipboard itself (desktop); false in a browser. */
  autoClears: boolean;
  /** Stop the pending clear (used when the person leaves the screen on purpose). */
  cancel: () => void;
}

let pendingClear: ReturnType<typeof setTimeout> | null = null;

/**
 * Copy a secret (the recovery phrase) and clear it again after `ttlMs`.
 *
 * The clear is conditional: it reads the clipboard first and only clears when
 * it still holds the secret, so something the person copied in the meantime is
 * left alone. A failure to read or clear is thrown from the timer's promise as
 * an unhandled rejection that `main.tsx` records in the diagnostics log (never
 * the text). A browser cannot read the clipboard without a prompt, so there the
 * secret is copied but not cleared and `autoClears` is false: the caller says
 * so rather than promising a clear that will not happen.
 */
export async function copySecretToClipboard(
  secret: string,
  ttlMs: number = SECRET_CLIPBOARD_TTL_MS,
): Promise<SecretCopy> {
  await writeClipboardText(secret);
  if (pendingClear) clearTimeout(pendingClear);
  pendingClear = null;
  if (!isTauri()) return { autoClears: false, cancel: () => undefined };

  const timer = setTimeout(() => {
    if (pendingClear === timer) pendingClear = null;
    void (async () => {
      const current = await readClipboardText();
      if (current === secret) await clearClipboard();
    })();
  }, ttlMs);
  pendingClear = timer;
  return {
    autoClears: true,
    cancel: () => {
      clearTimeout(timer);
      if (pendingClear === timer) pendingClear = null;
    },
  };
}
