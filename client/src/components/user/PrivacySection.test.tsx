import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PrivacySection } from './PrivacySection';

vi.mock('../../hooks/usePrivacySettings', () => ({
  usePrivacySettings: () => ({
    loaded: true,
    linkPreviews: true,
    linkPreviewsSupported: true,
    linkPreviewsServerOff: false,
    activity: false,
    busy: {},
    errors: {},
    setLinkPreviews: vi.fn(),
    setActivity: vi.fn(),
  }),
}));

describe('Settings › Privacy, "Ask for my password when Paracord opens"', () => {
  it('says it is a choice of this computer on a one-password account (M1 owner decision)', () => {
    render(<PrivacySection askForPassword={{ on: false, onChange: vi.fn(), perDevice: true }} />);
    expect(screen.getByText('Ask for my password when Paracord opens')).toBeTruthy();
    expect(screen.getByTestId('privacy-ask-per-device').textContent).toBe('Only on this computer.');
  });

  it("doesn't on an older server, where it is still the account's setting", () => {
    render(<PrivacySection askForPassword={{ on: true, onChange: vi.fn() }} />);
    expect(screen.queryByTestId('privacy-ask-per-device')).toBeNull();
  });
});
