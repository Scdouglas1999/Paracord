import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { botStoreApi } from '../api/botStore';
import { botApi } from '../api/bots';
import { writeClipboardText } from '../lib/clipboard';
import { confirm } from '../stores/confirmStore';
import { DeveloperPage } from './DeveloperPage';

vi.mock('../api/bots', () => ({
  botApi: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    regenerateToken: vi.fn(),
    listInstalls: vi.fn(),
  },
}));

vi.mock('../api/botStore', () => ({
  botStoreApi: {
    getDeveloperMetrics: vi.fn(),
  },
}));

vi.mock('../api/commands', () => ({
  commandApi: {
    listGlobalCommands: vi.fn(),
    deleteGlobalCommand: vi.fn(),
  },
}));

vi.mock('../stores/confirmStore', () => ({
  confirm: vi.fn(),
}));

vi.mock('../lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}));

describe('DeveloperPage metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeClipboardText).mockResolvedValue(undefined);
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(botApi.list).mockResolvedValue({
      data: [
        {
          id: 'app-1',
          name: 'Release Helper',
          description: 'Automates release checks.',
          owner_id: 'owner-1',
          bot_user_id: 'bot-user-1',
          redirect_uri: null,
          permissions: '8',
          intents: 0,
          created_at: '2026-05-17T00:00:00Z',
          updated_at: '2026-05-17T00:00:00Z',
        },
      ],
    } as never);
    vi.mocked(botApi.create).mockResolvedValue({
      data: {
        id: 'app-2',
        name: 'Build Bot',
        description: 'Runs release checks.',
        owner_id: 'owner-1',
        bot_user_id: 'bot-user-2',
        redirect_uri: null,
        permissions: '0',
        intents: 0,
        token: 'bot-token',
        created_at: '2026-05-17T00:00:00Z',
        updated_at: '2026-05-17T00:00:00Z',
      },
    } as never);
    vi.mocked(botApi.regenerateToken).mockResolvedValue({
      data: {
        token: 'regenerated-token',
      },
    } as never);
  });

  it('labels and trims the create-bot form', async () => {
    const user = userEvent.setup();

    render(<DeveloperPage />);

    expect(await screen.findByText('Release Helper')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Bot name' }), '  Build Bot  ');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), '  Runs release checks.  ');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(botApi.create).toHaveBeenCalledWith({
        name: 'Build Bot',
        description: 'Runs release checks.',
      });
    });
  });

  it('preserves create-bot API error details', async () => {
    const user = userEvent.setup();
    vi.mocked(botApi.create).mockRejectedValueOnce(new Error('Name is already reserved'));

    render(<DeveloperPage />);

    expect(await screen.findByText('Release Helper')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Bot name' }), 'Release Helper');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Failed to create bot application: Name is already reserved')).toBeInTheDocument();
  });

  it('loads and renders developer bot-store metrics', async () => {
    const user = userEvent.setup();
    vi.mocked(botStoreApi.getDeveloperMetrics).mockResolvedValue({
      data: {
        application_id: 'app-1',
        install_count: 12,
        active_guild_count: 7,
        review_count: 3,
        average_rating: 4.7,
        metrics_30d: [
          { event_type: 'install', count: 4 },
          { event_type: 'review', count: 2 },
        ],
      },
    } as never);

    render(<DeveloperPage />);

    expect(await screen.findByText('Release Helper')).toBeInTheDocument();
    expect(screen.getByText('No metrics loaded yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh Metrics' }));

    await waitFor(() => {
      expect(botStoreApi.getDeveloperMetrics).toHaveBeenCalledWith('app-1');
    });
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4.7 (3 reviews)')).toBeInTheDocument();
    expect(screen.getByText('install: 4')).toBeInTheDocument();
    expect(screen.getByText('review: 2')).toBeInTheDocument();
  });

  it('keeps the developer page usable when metrics loading fails', async () => {
    const user = userEvent.setup();
    vi.mocked(botStoreApi.getDeveloperMetrics).mockRejectedValue(new Error('metrics unavailable'));

    render(<DeveloperPage />);

    expect(await screen.findByText('Release Helper')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh Metrics' }));

    await waitFor(() => {
      expect(botStoreApi.getDeveloperMetrics).toHaveBeenCalledWith('app-1');
    });
    expect(screen.getByText('No metrics loaded yet.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load bot applications')).not.toBeInTheDocument();
  });

  it('shows clipboard error details when token copy fails', async () => {
    const user = userEvent.setup();
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));

    render(<DeveloperPage />);

    expect(await screen.findByText('Release Helper')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Regen Token' }));
    expect(await screen.findByText('regenerated-token')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('regenerated-token');
      expect(screen.getByText('Could not copy token to clipboard: Clipboard permission denied.')).toBeInTheDocument();
    });
  });
});
