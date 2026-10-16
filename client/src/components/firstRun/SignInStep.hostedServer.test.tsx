import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * On a computer that runs a server, the sign-in Server field starts on that
 * server. Its address is read from the host after the screen is up, so it
 * arrives late: it fills an empty field, and never replaces what the person
 * typed.
 */

vi.mock('../../lib/trustedHosts', () => ({
  isPinMismatch: () => false,
  probeServerIdentity: vi.fn(() => new Promise(() => undefined)),
}));

const { SignInStep } = await import('./SignInStep');

const HOSTED = 'https://127.0.0.1:8443';

function renderStep(initialServer: string) {
  const props = {
    state: 'on' as const,
    web: false,
    view: 'form' as const,
    busy: false,
    error: null,
    onProbed: () => undefined,
    onSubmit: () => undefined,
    onBack: () => undefined,
    onForgot: () => undefined,
  };
  const view = render(<SignInStep {...props} initialServer={initialServer} />);
  return { rerender: (next: string) => view.rerender(<SignInStep {...props} initialServer={next} />) };
}

const serverField = () => screen.getByTestId('fr-sign-in-server') as HTMLInputElement;

describe('the sign-in Server field on a computer that hosts a server', () => {
  it('fills with this computer’s server when it arrives', () => {
    const { rerender } = renderStep('');
    expect(serverField().value).toBe('');
    rerender(HOSTED);
    expect(serverField().value).toBe(HOSTED);
  });

  it('keeps what the person typed', () => {
    const { rerender } = renderStep('');
    fireEvent.change(serverField(), { target: { value: 'chat.example.com' } });
    rerender(HOSTED);
    expect(serverField().value).toBe('chat.example.com');
  });
});
