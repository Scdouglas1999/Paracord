import { useState } from 'react';
import { useStore } from 'zustand';
import type { AccountMessagingRuntime } from '../../lib/messages/accountMessagingRuntime';

/** Account storage readiness and Signal readiness are separate user decisions. */
export function MessagingRecoveryNotice({ runtime, encryptedConversation, channelId }: { runtime: AccountMessagingRuntime; encryptedConversation: boolean; channelId: string }) {
  const state = useStore(runtime.store);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = state.storage === 'review';
  const failed = state.storage === 'error';
  const legacy = encryptedConversation && (state.encryptionRecovery?.kind === 'legacy-prekeys' || (state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId === channelId));
  const otherSession = state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId !== channelId;
  const encryption = encryptedConversation && (state.encryption === 'recovery' || legacy || (Boolean(state.encryptionError) && !otherSession));
  if (!review && !failed && !encryption && state.storage !== 'awaiting-handshake') return null;
  async function recover() {
    setBusy(true); setError(null);
    try {
      if (review) await runtime.preservePreviousHistoryForReview();
      else if (failed) await runtime.startLocal();
      else if (state.encryptionRecovery?.kind === 'legacy-prekeys') await runtime.enroll(true);
      else if (state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId === channelId) await runtime.reviewLegacySession(channelId);
      else await runtime.enroll();
    } catch (error) { setError(error instanceof Error ? error.message : 'Recovery could not finish.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Messaging recovery" className="min-w-0 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
    <p className="text-sm font-medium">{review ? 'Review messages from the previous server history' : failed ? 'Encrypted draft storage is unavailable' : encryption ? 'Encryption needs recovery' : 'Waiting for this server’s authenticated connection'}</p>
    <p className="mt-1 break-words text-sm text-[var(--text-muted)]">{review
      ? 'Preserve saved requests and open composer text as recovery drafts before starting fresh messages. Nothing from the previous history will send automatically.'
      : (encryption ? state.encryptionError : state.error) ?? 'Your first drafts stay on this device until the server confirms its history.'}</p>
    {legacy && <p className="mt-2 break-words text-xs text-[var(--text-muted)]">Older keys are retained because their server ownership cannot be verified. Starting new encryption does not recover historical messages. Restore the original account backup if you need those keys; continue only to start a new session for this account.</p>}
    {(review || failed) && <p className="mt-2 break-words text-xs text-[var(--text-muted)]">Drafts use a device-bound encryption key. Recovery words alone cannot restore them; recovering this storage requires the complete device profile. Device encryption does not protect messages from code running in this app’s origin.</p>}
    {state.storage !== 'awaiting-handshake' && <button className="btn-ghost mt-2" disabled={busy} onClick={() => void recover()}>
      {busy ? 'Working…' : review ? 'Preserve old drafts and start fresh' : failed ? 'Retry encrypted storage' : legacy ? 'Keep old keys and start new encryption' : 'Retry encryption recovery'}
    </button>}
    {error && <p role="alert" className="mt-2 break-words text-sm text-[var(--text-danger)]">{error}</p>}
  </section>;
}
