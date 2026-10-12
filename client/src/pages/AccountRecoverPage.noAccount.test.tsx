import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { CredentialError, NO_ACCOUNT_FOR_PHRASE_MESSAGE } from '../lib/credential/errors';

// The first run's "Forgot your password?" (SignInStep → /recover) is where a
// recovery phrase reaches a server from the first run. M1: a phrase no account
// on that server uses is refused, and the page says so in the server's words.
const recoverWithPhrase = vi.hoisted(() => vi.fn());

vi.mock('../lib/oneCredential', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/oneCredential')>();
  return {
    ...actual,
    useCredentialMode: () => 'one-password',
    newPasswordProblem: vi.fn(async () => null),
    recoverWithPhrase,
  };
});

vi.mock('../stores/accountStore', () => ({
  useAccountStore: Object.assign((selector: (state: { recover: () => void }) => unknown) => selector({ recover: vi.fn() }), {
    getState: () => ({ recover: vi.fn() }),
  }),
}));

const PHRASE = Array.from({ length: 24 }, () => 'abandon').join(' ');

describe('recovery with a phrase no account uses', () => {
  it('shows the server refusal and makes nothing', async () => {
    recoverWithPhrase.mockRejectedValueOnce(new CredentialError('no_account', NO_ACCOUNT_FOR_PHRASE_MESSAGE));
    const { AccountRecoverPage } = await import('./AccountRecoverPage');
    render(
      <MemoryRouter initialEntries={['/recover']}>
        <Routes>
          <Route path="/recover" element={<AccountRecoverPage />} />
          <Route path="/app" element={<div>App shell</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText(/24 words/), { target: { value: PHRASE } });
    fireEvent.change(screen.getByPlaceholderText('ada'), { target: { value: 'sam' } });
    fireEvent.submit(screen.getByPlaceholderText('ada').closest('form')!);
    const passwords = await screen.findAllByLabelText(/password/i);
    for (const field of passwords) fireEvent.change(field, { target: { value: 'paper lantern orbit' } });
    fireEvent.submit(passwords[0].closest('form')!);
    expect(await screen.findByText(NO_ACCOUNT_FOR_PHRASE_MESSAGE)).toBeTruthy();
    expect(recoverWithPhrase).toHaveBeenCalledWith(PHRASE, 'sam');
    expect(screen.queryByText('App shell')).toBeNull();
  });
});
