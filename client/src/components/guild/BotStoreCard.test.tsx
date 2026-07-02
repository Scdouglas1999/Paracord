import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BotStoreCard } from './BotStoreCard';
import type { StoreBot } from '../../api/botStore';

const publicBot: StoreBot = {
  id: 'bot-1',
  name: 'Deploy Helper',
  description: 'Automates release chores.',
  category: 'tools',
  tags: ['deploy', 'ci', 'release', 'extra'],
  icon_hash: 'data:image/png;base64,iVBORw0KGgo=',
  install_count: 12,
  bot_user_id: 'bot-user-1',
  permissions: '8',
  verified_developer: true,
  review_count: 4,
  average_rating: 4.75,
};

describe('BotStoreCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders public store metadata and adds the bot', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();

    render(<BotStoreCard bot={publicBot} onAdd={onAdd} canManage />);

    expect(screen.getByRole('heading', { name: 'Deploy Helper' })).toBeInTheDocument();
    expect(screen.getByText('Automates release chores.')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('tools')).toBeInTheDocument();
    expect(screen.getByText('deploy')).toBeInTheDocument();
    expect(screen.getByText('ci')).toBeInTheDocument();
    expect(screen.getByText('release')).toBeInTheDocument();
    expect(screen.queryByText('extra')).not.toBeInTheDocument();
    expect(screen.getByText('12 servers')).toBeInTheDocument();
    expect(screen.getByText('4.8 (4)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add to Server/ }));

    expect(onAdd).toHaveBeenCalledWith(publicBot);
  });

  it('disables add when the user cannot manage bots or an add is in progress', () => {
    const { rerender } = render(<BotStoreCard bot={publicBot} onAdd={vi.fn()} canManage={false} />);
    expect(screen.getByRole('button', { name: /Add to Server/ })).toBeDisabled();

    rerender(<BotStoreCard bot={publicBot} onAdd={vi.fn()} canManage adding />);
    expect(screen.getByRole('button', { name: 'Adding...' })).toBeDisabled();
  });

  it('falls back to the generic bot icon when the configured icon fails', () => {
    render(<BotStoreCard bot={publicBot} onAdd={vi.fn()} canManage />);

    const image = screen.getByRole('img', { name: 'Deploy Helper' });
    fireEvent.error(image);

    expect(screen.queryByRole('img', { name: 'Deploy Helper' })).not.toBeInTheDocument();
  });

  it('does not request unresolved icon hashes', () => {
    render(
      <BotStoreCard
        bot={{ ...publicBot, icon_hash: 'icon-hash' }}
        onAdd={vi.fn()}
        canManage
      />,
    );

    expect(screen.queryByRole('img', { name: 'Deploy Helper' })).not.toBeInTheDocument();
  });
});
