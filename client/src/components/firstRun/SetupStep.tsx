import type { RowChip, SetupRow } from '../../stores/firstRunStore';
import { CordMark, CordSpinner } from '../brand/CordMark';
import { Chip, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';

const CHIP_LABEL: Record<RowChip, string> = {
  'show-me-how': 'Show me how',
  'try-again': 'Try again',
  'what-can-i-do': 'What can I do?',
  allow: 'Allow',
  'show-details': 'Show details',
  'retry-row': 'Try again',
};

function RowStatus({ row }: { row: SetupRow }) {
  return (
    <span className="fr-task__st" aria-hidden="true">
      {row.state === 'run' && <CordSpinner size={18} />}
      {row.state === 'ok' && <FrGlyph name="check" size={14} strokeWidth={2.4} />}
      {row.state === 'warn' && <FrGlyph name="bang" size={14} strokeWidth={2.4} />}
      {row.state === 'fail' && <FrGlyph name="cross" size={14} strokeWidth={2.4} />}
    </span>
  );
}

const STATE_WORD: Record<SetupRow['state'], string> = {
  waiting: 'waiting',
  run: 'working',
  ok: 'done',
  warn: 'needs a look',
  fail: 'failed',
};

/**
 * Setup (docs/setup-spec.md §1.7): the rows run on their own, in order. No
 * Back; Continue once nothing is waiting, running or failed. "See what's
 * protected" fades in when every row is done.
 */
export function SetupStep({
  state,
  path,
  rows,
  status,
  onChip,
  onContinue,
  onProtected,
}: {
  state: ScreenState;
  path: 'host' | 'join';
  rows: SetupRow[];
  status: 'idle' | 'running' | 'done' | 'failed';
  onChip: (row: SetupRow, chip: RowChip) => void;
  onContinue: () => void;
  onProtected: () => void;
}) {
  const running = status === 'running';
  const done = status === 'done';

  return (
    <Screen
      step="setup"
      state={state}
      title={path === 'host' ? 'Setting up your server' : 'Getting you in'}
      sub="This takes a few seconds. There's nothing you need to do."
      mark={
        <div className="fr-setmark">
          <CordMark size={56} motion={running ? 'working' : 'none'} />
        </div>
      }
      onSubmit={() => done && onContinue()}
      footer={
        <GoButton disabled={!done} data-testid="fr-setup-continue">
          Continue
        </GoButton>
      }
    >
      <ol className="fr-tasks" aria-live="polite" data-testid="fr-setup-rows">
        {rows.map((row) => (
          <li key={row.row} className="fr-task" data-state={row.state} data-row={row.row} data-code={row.code}>
            <RowStatus row={row} />
            <b>
              {row.title}
              <span className="sr-only">, {STATE_WORD[row.state]}</span>
            </b>
            <small>{row.state === 'warn' || row.state === 'fail' || row.state === 'ok' ? (row.detail ?? row.pending) : row.pending}</small>
            {row.chips && row.chips.length > 0 && (
              <div className="fr-task__fix">
                {row.chips.map((chip, i) => (
                  <Chip key={chip} variant={i === 0 ? undefined : 'ghost'} onClick={() => onChip(row, chip)}>
                    {CHIP_LABEL[chip]}
                  </Chip>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {done && (
        <button type="button" className="fr-privlink" onClick={onProtected} data-testid="fr-see-protected">
          <FrGlyph name="shield" size={16} />
          See what&rsquo;s protected
        </button>
      )}
    </Screen>
  );
}
