import { useState } from 'react';
import { useStore } from 'zustand';
import type { AccountMessagingRuntime } from '../../lib/messages/accountMessagingRuntime';
import { Button } from '../ui';

/**
 * Storage and encryption readiness, above the composer
 * (docs/lantern-stage-spec.md §7.4, §7.6).
 *
 * Account storage readiness and Signal readiness are separate user decisions,
 * so this is a raised row that states which one is unresolved and offers the
 * one action that resolves it. The copy is unchanged — only the surface is.
 */
export function MessagingRecoveryNotice({ runtime, encryptedConversation, channelId }: { runtime: AccountMessagingRuntime; encryptedConversation: boolean; channelId: string }) {
  const state = useStore(runtime.store);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = state.storage === 'review';
  const failed = state.storage === 'error';
  const legacy = encryptedConversation && (state.encryptionRecovery?.kind === 'legacy-prekeys' || (state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId === channelId));
  // A device that proved this account's identity (a recovery-phrase restore)
  // but holds none of the private halves of the published bundle. The identity
  // key is the root of trust and prekeys are per device, so this device may
  // publish a fresh bundle — but it is destructive, so the user decides.
  const reenroll = encryptedConversation && state.encryptionRecovery?.kind === 'device-reenrollment';
  const otherSession = state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId !== channelId;
  const encryption = encryptedConversation && (state.encryption === 'recovery' || legacy || reenroll || (Boolean(state.encryptionError) && !otherSession));
  if (!review && !failed && !encryption && state.storage !== 'awaiting-handshake') return null;
  async function recover() {
    setBusy(true); setError(null);
    try {
      if (review) await runtime.preservePreviousHistoryForReview();
      else if (failed) await runtime.startLocal();
      else if (state.encryptionRecovery?.kind === 'legacy-prekeys') await runtime.enroll({ initializeWithUnownedLegacy: true });
      else if (state.encryptionRecovery?.kind === 'device-reenrollment') await runtime.enroll({ replacePublishedBundle: true });
      else if (state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId === channelId) await runtime.reviewLegacySession(channelId);
      else await runtime.enroll();
    } catch (error) { setError(error instanceof Error ? error.message : 'Recovery could not finish.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Messaging recovery" className="min-w-0 rounded-[var(--radius-well)] bg-bg-raised p-3 shadow-[var(--shadow-raised)]">
    <p className="pc-display text-name text-text-primary">{review ? 'Review messages from the previous server history' : failed ? 'Encrypted draft storage is unavailable' : reenroll ? 'Set up encryption keys on this device' : encryption ? 'Encryption needs recovery' : 'Waiting for this server’s authenticated connection'}</p>
    <p className="mt-1 break-words text-body text-text-body">{review
      ? 'Preserve saved requests and open composer text as recovery drafts before starting fresh messages. Nothing from the previous history will send automatically.'
      : (encryption ? state.encryptionError : state.error) ?? 'Your first drafts stay on this device until the server confirms its history.'}</p>
    {reenroll && <p className="mt-2 break-words text-meta text-text-faint">Your recovery phrase restored the identity this account is enrolled under, and that identity is what everyone you talk to verifies. This device can publish fresh keys under it, and your contacts pick them up on their next message. Messages sent before now stay unreadable here: import the account’s encrypted backup from Settings › Identity portability if you need them. Any other device still signed in to this account stops receiving new conversations until it sets up again.</p>}
    {legacy && <p className="mt-2 break-words text-meta text-text-faint">Older keys are retained because their server ownership cannot be verified. Starting new encryption does not recover historical messages. Restore the original account backup if you need those keys; continue only to start a new session for this account.</p>}
    {(review || failed) && <p className="mt-2 break-words text-meta text-text-faint">Drafts use a device-bound encryption key. Recovery words alone cannot restore them; recovering this storage requires the complete device profile. Device encryption does not protect messages from code running in this app’s origin.</p>}
    {state.storage !== 'awaiting-handshake' && <Button variant="ghost" size="sm" className="mt-2" disabled={busy} onClick={() => void recover()}>
      {busy ? 'Working…' : review ? 'Preserve old drafts and start fresh' : failed ? 'Retry encrypted storage' : reenroll ? 'Publish new keys for this device' : legacy ? 'Keep old keys and start new encryption' : 'Retry encryption recovery'}
    </Button>}
    {error && <p role="alert" className="mt-2 break-words text-meta text-accent-danger">{error}</p>}
  </section>;
}
