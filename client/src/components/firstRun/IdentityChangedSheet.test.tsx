import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useIdentityChangeStore } from '../../lib/trustedHosts';
import { IdentityChangedSheet } from './IdentityChangedSheet';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../lib/tauriEnv', () => ({ isTauri: () => true }));

const OLD = '00'.repeat(32);
const NEW = 'ff'.repeat(32);
const URL = 'https://kanto.example:8443';

function renderSheet(overrides: Partial<Parameters<typeof IdentityChangedSheet>[0]> = {}) {
  const props = {
    open: true,
    serverName: 'Kanto',
    serverUrl: URL,
    onClose: vi.fn(),
    onTrusted: vi.fn(),
    ...overrides,
  };
  render(<IdentityChangedSheet {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useIdentityChangeStore.setState({
    changes: { 'kanto.example': { host: 'kanto.example', pinnedFp: OLD, presentedFp: NEW } },
  });
});

describe('IdentityChangedSheet (docs/setup-spec.md §7.4)', () => {
  it('shows the old and new words in the spec copy, with Stay disconnected focused', async () => {
    renderSheet();
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Kanto has a new identity');
    await waitFor(() => expect(screen.getByTestId('identity-old-words')).toHaveTextContent('injury · burden · fortune · boil'));
    expect(screen.getByTestId('identity-new-words')).toHaveTextContent('student · deposit · glance · slight');
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'This server’s words used to be injury · burden · fortune · boil. Now they’re student · deposit · glance · slight. ' +
        'That happens when the person who runs it reinstalls Paracord or replaces its certificate. It also happens when ' +
        'someone is trying to listen in. Ask them whether they changed something before you continue.',
    );
    expect(screen.getByRole('button', { name: 'Stay disconnected' })).toHaveFocus();
  });

  it('Stay disconnected changes nothing', async () => {
    const props = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Stay disconnected' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('trusts exactly the recorded certificate', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const props = renderSheet();
    const trust = screen.getByRole('button', { name: 'Trust the new identity' });
    await waitFor(() => expect(trust).toBeEnabled());
    fireEvent.click(trust);
    await waitFor(() => expect(props.onTrusted).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('accept_changed_identity', { host: 'kanto.example', presentedFp: NEW });
    expect(useIdentityChangeStore.getState().changes['kanto.example']).toBeUndefined();
  });

  it('shows the shell refusal when the server changed again', async () => {
    vi.mocked(invoke).mockRejectedValue("This server's identity changed again while you were looking at it. Review it again before you trust it.");
    const props = renderSheet();
    const trust = screen.getByRole('button', { name: 'Trust the new identity' });
    await waitFor(() => expect(trust).toBeEnabled());
    fireEvent.click(trust);
    expect(await screen.findByRole('alert')).toHaveTextContent('changed again');
    expect(props.onTrusted).not.toHaveBeenCalled();
  });

  it('reads the shell record after a reload, and says so when there is none', async () => {
    useIdentityChangeStore.setState({ changes: {} });
    vi.mocked(invoke).mockResolvedValueOnce(null);
    renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent('Paracord has no record of a new identity for Kanto.');
    expect(invoke).toHaveBeenCalledWith('pending_identity_change', { host: 'kanto.example' });
    expect(screen.getByRole('button', { name: 'Trust the new identity' })).toBeDisabled();
  });
});
