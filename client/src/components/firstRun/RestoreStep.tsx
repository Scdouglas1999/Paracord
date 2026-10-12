import { useId } from 'react';

import { describeBackup, phraseWords, RESTORE_COPY } from '../../pages/firstRun/restore';
import { useFirstRunStore } from '../../stores/firstRunStore';
import { BackButton, Chip, Field, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';

/**
 * Restore › Backup (docs/setup-spec.md §1.4, §4.8): the backup file and the
 * owner's recovery phrase. Both are checked here before anything runs: the
 * file must carry the key escrow, and the phrase must be the one of the
 * account that owns it. Not in the prototype; drawn with the same frame,
 * fields, cards and notes.
 */
export function RestoreStep({
  state,
  busy,
  onPick,
  onContinue,
  onBack,
}: {
  state: ScreenState;
  busy: boolean;
  onPick: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const restore = useFirstRunStore((s) => s.restore);
  const setRestore = useFirstRunStore((s) => s.setRestore);
  const ids = { phrase: useId(), phraseHelp: useId(), fileErr: useId() };
  const { file, errors } = restore;
  const words = phraseWords(restore.phrase).length;
  const canContinue = Boolean(file) && !errors.file && words === 24 && !busy;

  return (
    <Screen
      step="backup"
      state={state}
      title={RESTORE_COPY.title}
      sub={RESTORE_COPY.sub}
      onSubmit={() => canContinue && onContinue()}
      footer={
        <>
          <BackButton onClick={onBack} />
          <GoButton disabled={!canContinue} data-testid="fr-restore-continue">
            Restore
          </GoButton>
          {busy && <span className="fr-foot__hint">Checking your phrase…</span>}
        </>
      }
    >
      <div className="fr-fl">
        <span className="fr-label">Backup</span>
        {file ? (
          <div className="fr-backup" data-invalid={errors.file ? '' : undefined} data-testid="fr-backup-file">
            <FrGlyph name="clock" size={20} />
            <div>
              <b>{file.file_name}</b>
              <small>{describeBackup(file)}</small>
            </div>
            <Chip variant="ghost" onClick={onPick} disabled={restore.picking}>
              Choose another
            </Chip>
          </div>
        ) : (
          <button
            type="button"
            className="fr-pick"
            onClick={onPick}
            disabled={restore.picking}
            aria-label={restore.picking ? 'Choosing…' : RESTORE_COPY.pick}
            aria-describedby={errors.file ? ids.fileErr : undefined}
            data-testid="fr-pick-backup"
          >
            <FrGlyph name="download" size={20} />
            <span>
              <b>{restore.picking ? 'Choosing…' : RESTORE_COPY.pick}</b>
              <small>{RESTORE_COPY.pickHelp}</small>
            </span>
          </button>
        )}
        {errors.file && (
          <div className="fr-err" id={ids.fileErr} role="alert" data-testid="fr-backup-error">
            {errors.file}
          </div>
        )}
      </div>

      <Field
        label={RESTORE_COPY.phraseLabel}
        htmlFor={ids.phrase}
        error={errors.phrase}
        errorId={ids.phraseHelp}
        help={
          <div className="fr-help" id={ids.phraseHelp}>
            {words > 0 && words !== 24 ? `${words} of 24 words.` : RESTORE_COPY.phraseHelp}
          </div>
        }
      >
        <textarea
          id={ids.phrase}
          className="fr-inp fr-inp--area"
          value={restore.phrase}
          onChange={(event) => setRestore({ phrase: event.target.value })}
          onKeyDown={(event) => {
            // Enter submits, as on every step; the words wrap on their own.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canContinue) onContinue();
            }
          }}
          rows={4}
          placeholder="24 words, in order"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={errors.phrase ? true : undefined}
          aria-describedby={ids.phraseHelp}
          data-testid="fr-restore-phrase"
        />
      </Field>
    </Screen>
  );
}
