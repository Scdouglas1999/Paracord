import { useRef, useState } from 'react';
import { Check, Copy, Eye, ShieldAlert } from 'lucide-react';
import { copySecretToClipboard, type SecretCopy } from '../lib/clipboard';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/Feedback';
import { AUTH_FORM, AuthCanvas, AuthCard, AuthHeading, AuthScroll } from './authScaffold';

/**
 * "Save your recovery phrase" (docs/setup-spec.md §1.8) for the account pages
 * outside the first run: after sign-up on `/register`, after a v1 account
 * moves with a brand-new identity, and after a sign-in or unlock while the
 * account's phrase is still unconfirmed. The words are held in memory only;
 * they are blurred until shown, and the box records the confirmation on the
 * server (`onConfirm`) so no device shows them again.
 */
export function RecoveryPhraseCard({
  phrase,
  onConfirm,
  continueLabel = 'Continue',
}: {
  phrase: string;
  onConfirm: () => Promise<void>;
  continueLabel?: string;
}) {
  const [shown, setShown] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'clears' | 'kept' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingCopy = useRef<SecretCopy | null>(null);
  // Leaving the screen does not cancel a pending clear: the phrase should not
  // sit on the clipboard just because the person moved on.
  const words = phrase.split(' ');

  const copy = async () => {
    setShown(true);
    try {
      pendingCopy.current = await copySecretToClipboard(phrase);
      setCopied(pendingCopy.current.autoClears ? 'clears' : 'kept');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Paracord couldn't copy the words.");
    }
  };

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Paracord couldn't save that you kept the words. Try again.");
      setBusy(false);
    }
  };

  return (
    <AuthCanvas>
      <AuthCard>
        <div className={AUTH_FORM}>
          <AuthHeading
            dense
            title="Save your recovery phrase"
            subtitle="If you forget your password or lose this computer, these 24 words get your account back. Nobody can reset them for you, so keep them somewhere safe."
          />

          <div className="pc-well flex items-start gap-2.5 px-4 py-3 text-[14px] font-medium text-[var(--ix-ink)]">
            <ShieldAlert size={16} className="mt-px shrink-0" />
            <span className="leading-relaxed">Never share these words. Anyone who has them can take over your account.</span>
          </div>

          {error && <ErrorBanner multiline message={error} />}

          <AuthScroll>
            <div className="relative">
              <ol
                aria-label="Recovery phrase"
                data-testid="recovery-phrase"
                className="pc-well grid grid-cols-2 gap-1.5 p-3 sm:grid-cols-4"
                style={shown ? undefined : { filter: 'blur(7px)', userSelect: 'none' }}
                aria-hidden={!shown}
              >
                {words.map((word, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-[8px] bg-[var(--ix-fill)] px-2.5 py-1">
                    <span className="text-[12px] tabular-nums text-[var(--ix-ink-3)]">{String(i + 1).padStart(2, '0')}</span>
                    <span className="pc-mono text-[13.5px] text-[var(--ix-ink)]">{word}</span>
                  </li>
                ))}
              </ol>
              {!shown && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Button variant="secondary" onClick={() => setShown(true)}>
                    <Eye size={15} aria-hidden />
                    Show words
                  </Button>
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void copy()}>
                {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              {copied === 'clears' && (
                <span role="status" className="text-[13px] text-[var(--ix-ink-3)]">Cleared from the clipboard in a minute.</span>
              )}
              {copied === 'kept' && (
                <span role="status" className="text-[13px] text-[var(--ix-ink-3)]">Paste it somewhere safe, then copy something else over it.</span>
              )}
            </div>
          </AuthScroll>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-[12px] bg-[var(--ix-fill-card)] px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--ix-line)] transition-colors duration-[40ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-card-hover)]">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="pc-checkbox mt-0.5"
            />
            <span className="text-[13.5px] leading-relaxed text-[var(--ix-ink-2)]">I saved my recovery phrase somewhere safe</span>
          </label>

          <Button size="lg" className="w-full" disabled={!saved || busy} loading={busy} onClick={() => void finish()}>
            {continueLabel}
          </Button>
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
