import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { botStoreApi } from '../api/botStore';
import { botApi } from '../api/bots';
import { guildApi } from '../api/guilds';
import { BotAuthorizePage } from './BotAuthorizePage';

vi.mock('../api/client', () => ({
  extractApiError: vi.fn((err: { response?: { data?: { error?: string; message?: string } } }) =>
    err?.response?.data?.message || err?.response?.data?.error || 'request failed',
  ),
}));

vi.mock('../api/bots', () => ({
  botApi: {
    getPublic: vi.fn(),
    addBotToGuild: vi.fn(),
  },
}));

vi.mock('../api/guilds', () => ({
  guildApi: {
    getAll: vi.fn(),
  },
}));

vi.mock('../api/botStore', () => ({
  botStoreApi: {
    listReviews: vi.fn(),
    upsertMyReview: vi.fn(),
  },
}));

function renderPage(initialEntry = '/oauth2/authorize?client_id=app-1&permissions=8') {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/oauth2/authorize" element={<BotAuthorizePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BotAuthorizePage review flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(botApi.getPublic).mockResolvedValue({
      data: {
        id: 'app-1',
        name: 'Deploy Helper',
        description: 'Automates release chores.',
        bot_user_id: 'bot-user-1',
        permissions: '0',
        redirect_uri: null,
        created_at: '2026-05-17T00:00:00Z',
        updated_at: '2026-05-17T00:00:00Z',
        bot_user: null,
      },
    } as never);
    vi.mocked(guildApi.getAll).mockResolvedValue({
      data: [
        {
          id: 'g1',
          name: 'Release Server',
          owner_id: 'u1',
          member_count: 3,
          features: [],
          created_at: '2026-05-17T00:00:00Z',
        },
      ],
    } as never);
    vi.mocked(botStoreApi.listReviews).mockResolvedValue({
      data: {
        reviews: [
          {
            id: 'review-1',
            bot_app_id: 'app-1',
            user_id: 'u2',
            rating: 4,
            body: 'Useful in staging.',
            created_at: '2026-05-17T00:00:00Z',
            updated_at: '2026-05-17T00:00:00Z',
          },
        ],
        summary: { review_count: 1, average_rating: 4 },
      },
    } as never);
    vi.mocked(botStoreApi.upsertMyReview).mockResolvedValue({
      data: {
        reviews: [],
        summary: { review_count: 2, average_rating: 4.5 },
      },
    } as never);
    vi.mocked(botApi.addBotToGuild).mockResolvedValue({ data: {} } as never);
  });

  it('loads review summary, submits a review, refreshes reviews, and authorizes the bot', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Deploy Helper')).toBeInTheDocument();
    expect(screen.getByText('4.0 average (1 reviews)')).toBeInTheDocument();
    expect(screen.getByText('Useful in staging.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Review rating'), '5');
    await user.type(screen.getByLabelText('Review body'), 'Solid bot for launch rehearsals.');
    await user.click(screen.getByRole('button', { name: 'Submit Review' }));

    await waitFor(() => {
      expect(botStoreApi.upsertMyReview).toHaveBeenCalledWith('app-1', {
        rating: 5,
        body: 'Solid bot for launch rehearsals.',
      });
    });
    expect(botStoreApi.listReviews).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Review body')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Authorize' }));

    await waitFor(() => {
      expect(botApi.addBotToGuild).toHaveBeenCalledWith('g1', {
        application_id: 'app-1',
        permissions: '8',
        redirect_uri: undefined,
        state: undefined,
      });
    });
    expect(await screen.findByText('Bot authorized successfully for server ID g1.')).toBeInTheDocument();
  });

  it('shows a user-visible error when review submission fails', async () => {
    const user = userEvent.setup();
    vi.mocked(botStoreApi.upsertMyReview).mockRejectedValue({
      response: { data: { message: 'Reviews are temporarily unavailable.' } },
    });

    renderPage();

    await screen.findByText('Deploy Helper');
    await user.click(screen.getByRole('button', { name: 'Submit Review' }));

    expect(
      await screen.findByText('Failed to submit review: Reviews are temporarily unavailable.'),
    ).toBeInTheDocument();
  });

  it('shows API details when authorization details fail to load', async () => {
    vi.mocked(botApi.getPublic).mockRejectedValueOnce({
      response: { data: { message: 'Bot application is private.' } },
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load authorization details: Bot application is private.',
    );
  });

  it('shows API details when authorization fails', async () => {
    const user = userEvent.setup();
    vi.mocked(botApi.addBotToGuild).mockRejectedValueOnce({
      response: { data: { message: 'Missing Manage Guild permission.' } },
    });

    renderPage();

    expect(await screen.findByText('Deploy Helper')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Authorize' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Authorization failed: Missing Manage Guild permission.',
    );
  });

  it('blocks redirect URLs that contain userinfo', async () => {
    const user = userEvent.setup();
    renderPage('/oauth2/authorize?client_id=app-1&permissions=8&redirect_uri=https%3A%2F%2Fuser%3Apass%40example.com%2Fcb');

    expect(await screen.findByText('Deploy Helper')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Authorize' }));

    expect(await screen.findByText('Bot authorized successfully for server ID g1.')).toBeInTheDocument();
    expect(screen.getByText(/Redirect URL was blocked/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Continue to App/i })).toBeNull();
  });
});
