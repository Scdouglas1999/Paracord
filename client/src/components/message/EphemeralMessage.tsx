import type { ReactNode } from 'react';
import { IxGlyph } from '../ix/glyphs/IxGlyph';

interface EphemeralMessageProps {
  children: ReactNode;
}

/**
 * Wraps ephemeral message content (flags & 64) with its mark
 * (docs/index-spec.md §8.4): the message in its bubble as it always is, and
 * "Only you can see this" under it, 12px in the tertiary ink with an eye.
 */
export function EphemeralMessage({ children }: EphemeralMessageProps) {
  return (
    <div className="ix-ephemeral">
      <div>{children}</div>
      <p className="ix-ephemeral__note">
        <IxGlyph name="watch" size={13} />
        Only you can see this
      </p>
    </div>
  );
}
