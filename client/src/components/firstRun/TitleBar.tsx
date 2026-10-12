import { CordMark } from '../brand/CordMark';

/**
 * The first run's title bar (docs/setup-spec.md §1.1): the mark and "Paracord"
 * on the left, the progress segments centered, "Sign in instead" on the right.
 * On the desktop it is also the window's drag region.
 */
export function TitleBar({
  segments,
  filled,
  onSignIn,
  showSignIn,
}: {
  segments: number;
  filled: number;
  onSignIn: () => void;
  showSignIn: boolean;
}) {
  return (
    <header className="fr-tb" data-tauri-drag-region="">
      <div className="fr-brand" data-tauri-drag-region="">
        <CordMark size={24} />
        Paracord
      </div>
      {segments > 0 && (
        <div className="fr-prog" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={segments} aria-valuenow={filled}>
          {Array.from({ length: segments }, (_, k) => (
            <i key={k} data-done={k < filled ? '' : undefined} />
          ))}
        </div>
      )}
      {showSignIn && (
        <button type="button" className="fr-tb__alt" onClick={onSignIn}>
          Sign in instead
        </button>
      )}
    </header>
  );
}
