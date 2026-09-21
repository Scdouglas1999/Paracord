import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingWizard } from './OnboardingWizard';

describe('the connect introduction', () => {
  beforeEach(() => localStorage.clear());

  it('does not promise a screen its own counter denies', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} />);

    await user.click(screen.getByRole('button', { name: /^Next/ }));

    // The last step used to read "2 of 2" and, underneath it, "You'll enter
    // your server address on the next screen" — an uncounted third step.
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.queryByText(/next screen/i)).not.toBeInTheDocument();

    // The button names where it goes instead.
    const go = screen.getByRole('button', { name: 'Paste my invite link' });
    await user.click(go);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
