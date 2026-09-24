/** The Daily word add-on's mark: a row of tiles, one in place, one in the word, one still empty. */
export function DailyWordMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <rect x="1" y="9.5" width="8" height="9" rx="1.5" fill="var(--word-correct)" />
      <rect x="10" y="9.5" width="8" height="9" rx="1.5" fill="var(--word-present)" />
      <rect x="19.6" y="10.1" width="6.8" height="7.8" rx="1.2" fill="none" stroke="var(--word-tile-edge-filled)" strokeWidth="1.2" />
    </svg>
  );
}
