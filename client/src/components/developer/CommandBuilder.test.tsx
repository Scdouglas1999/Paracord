import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commandApi } from '../../api/commands';
import { ApplicationCommandType, type ApplicationCommand } from '../../types/commands';
import { CommandBuilder } from './CommandBuilder';

vi.mock('../../api/commands', () => ({
  commandApi: {
    createGlobalCommand: vi.fn(),
    updateGlobalCommand: vi.fn(),
  },
}));

const existingCommand: ApplicationCommand = {
  id: 'cmd-1',
  application_id: 'app-1',
  name: 'deploy',
  description: 'Deploy the app',
  options: [],
  type: ApplicationCommandType.ChatInput,
  dm_permission: true,
  nsfw: false,
  version: 1,
};

describe('CommandBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commandApi.createGlobalCommand).mockResolvedValue({ data: existingCommand } as never);
    vi.mocked(commandApi.updateGlobalCommand).mockResolvedValue({ data: existingCommand } as never);
  });

  it('shows concrete API details when command creation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(commandApi.createGlobalCommand).mockRejectedValueOnce(
      new Error('Command name is already registered.'),
    );

    render(
      <CommandBuilder
        appId="app-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Command name' }), 'deploy');
    await user.type(screen.getByRole('textbox', { name: 'Command description' }), 'Deploy the app');
    await user.click(screen.getByRole('button', { name: 'Create Command' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to create command: Command name is already registered.',
    );
  });

  it('shows concrete API details when command updates fail', async () => {
    const user = userEvent.setup();
    vi.mocked(commandApi.updateGlobalCommand).mockRejectedValueOnce(
      new Error('Command description is too long.'),
    );

    render(
      <CommandBuilder
        appId="app-1"
        editingCommand={existingCommand}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.clear(screen.getByRole('textbox', { name: 'Command description' }));
    await user.type(screen.getByRole('textbox', { name: 'Command description' }), 'Deploy production');
    await user.click(screen.getByRole('button', { name: 'Update Command' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to update command: Command description is too long.',
    );
  });

  it('labels option expand and choice remove controls', async () => {
    const user = userEvent.setup();

    render(
      <CommandBuilder
        appId="app-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add Option' }));
    expect(screen.getByRole('button', { name: 'Collapse option 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Remove choice 1 from option 1' })).toBeInTheDocument();
  });
});
