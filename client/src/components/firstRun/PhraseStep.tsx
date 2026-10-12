import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { copySecretToClipboard, type SecretCopy } from '../../lib/clipboard';
import { useFirstRunStore } from '../../stores/firstRunStore';
import { BackButton, Chip, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';

export const PHRASE_FILE_NAME = 'Paracord recovery phrase.txt';

/** The file and the printout: a header, the numbered words, the account and server, one instruction. */
export function phraseDocument(words: string[], username: string, server: string): string {
  return [
    'Paracord recovery phrase',
    '',
    ...words.map((word, i) => `${String(i + 1).padStart(2, ' ')}. ${word}`),
    '',
    `Account: @${username}`,
    `Server: ${server}`,
    '',
    'Keep this somewhere safe. With these 24 words and your username you can get your account back if you forget your password or lose this device.',
    '',
  ].join('\n');
}

function saveFile(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = PHRASE_FILE_NAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Save your recovery phrase (docs/setup-spec.md §1.8): the 24 words, blurred
 * until asked for. Copy (cleared from the clipboard a minute later on the
 * desktop), save as a file, print (only the words, the username and the
 * server). The words live in memory only; nothing here writes them to storage.
 */
export function PhraseStep({
  state,
  primary,
  username,
  server,
  busy,
  error,
  onContinue,
  onBack,
}: {
  state: ScreenState;
  /** "Continue" on the host path, "Open {server}" on the join path. */
  primary: string;
  username: string;
  server: string;
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  onBack?: () => void;
}) {
  const words = useFirstRunStore((s) => s.phrase) ?? [];
  const revealed = useFirstRunStore((s) => s.phraseRevealed);
  const saved = useFirstRunStore((s) => s.phraseSaved);
  const reveal = useFirstRunStore((s) => s.revealPhrase);
  const setSaved = useFirstRunStore((s) => s.setPhraseSaved);
  const [note, setNote] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const copy = useRef<SecretCopy | null>(null);

  useEffect(() => () => copy.current?.cancel(), []);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const frame = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  const text = words.join(' ');
  const doc = phraseDocument(words, username, server);

  return (
    <Screen
      step="phrase"
      state={state}
      title="Save your recovery phrase"
      sub="If you forget your password or lose this computer, these 24 words get your account back. Nobody can reset them for you, so keep them somewhere safe."
      onSubmit={() => saved && !busy && onContinue()}
      footer={
        <>
          {onBack && <BackButton onClick={onBack} />}
          <GoButton disabled={!saved || busy} data-testid="fr-phrase-continue">
            {primary}
          </GoButton>
        </>
      }
    >
      <div className="fr-words" data-hidden={revealed ? undefined : ''} data-testid="fr-words">
        <ol aria-label="Recovery phrase" aria-hidden={revealed ? undefined : true}>
          {words.map((word, i) => (
            <li key={i}>{word}</li>
          ))}
        </ol>
        {!revealed && (
          <div className="fr-words__reveal">
            <button type="button" onClick={reveal} data-testid="fr-show-words">
              <FrGlyph name="eye" size={18} />
              Show words
            </button>
          </div>
        )}
      </div>
      <div className="fr-wordacts">
        <Chip
          glyph="copy"
          onClick={async () => {
            reveal();
            try {
              copy.current = await copySecretToClipboard(text);
              setNote(copy.current.autoClears ? 'Copied. Paracord clears it from the clipboard in a minute.' : 'Copied.');
            } catch (err) {
              setNote(`Couldn't copy (${err instanceof Error ? err.message : String(err)}).`);
            }
          }}
        >
          Copy
        </Chip>
        <Chip
          glyph="download"
          onClick={() => {
            reveal();
            saveFile(doc);
            setNote(`Saved as “${PHRASE_FILE_NAME}”.`);
          }}
        >
          Save as file
        </Chip>
        <Chip
          variant="ghost"
          glyph="print"
          onClick={() => {
            reveal();
            setPrinting(true);
          }}
        >
          Print
        </Chip>
      </div>
      {note && (
        <div className="fr-status" role="status">
          {note}
        </div>
      )}
      <label className="fr-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="fr-phrase-saved" />I saved my recovery phrase somewhere safe
      </label>
      {error && (
        <div className="fr-fielderr" role="alert">
          {error}
        </div>
      )}
      {printing && createPortal(<pre className="fr-print">{doc}</pre>, document.body)}
    </Screen>
  );
}
