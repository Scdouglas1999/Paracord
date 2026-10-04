import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EphemeralMessage } from './EphemeralMessage';

describe('EphemeralMessage', () => {
  it('shows the message as it is, and says under it that only you can see it', () => {
    const { container } = render(
      <EphemeralMessage>
        <span>Reminder set for 9 PM.</span>
      </EphemeralMessage>,
    );
    expect(screen.getByText('Reminder set for 9 PM.')).toBeInTheDocument();
    const note = screen.getByText('Only you can see this');
    expect(note).toHaveClass('ix-ephemeral__note');
    // The message comes first, the line after it.
    const body = container.querySelector('.ix-ephemeral')!;
    expect(body.firstElementChild).toHaveTextContent('Reminder set for 9 PM.');
    expect(body.lastElementChild).toBe(note);
    // The eye is decoration for the same words.
    expect(note.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
