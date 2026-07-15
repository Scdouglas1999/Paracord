import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenorApi } from '../../api/tenor';
import { GifPicker } from './GifPicker';

vi.mock('../../api/tenor', () => ({
  tenorApi: {
    search: vi.fn(),
    trending: vi.fn(),
  },
}));

const trending = vi.mocked(tenorApi.trending);
const search = vi.mocked(tenorApi.search);
const tenorResponse = (results: unknown[]) =>
  ({ data: { results } }) as Awaited<ReturnType<typeof tenorApi.trending>>;

describe('GifPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search.mockResolvedValue(tenorResponse([]));
  });

  it('renders and selects only safe GIF URLs', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    trending.mockResolvedValue(
      tenorResponse([
        {
          id: 'safe',
          title: 'Safe',
          media_formats: {
            gif: { url: 'https://media.example.com/safe.gif', dims: [100, 50] },
            tinygif: { url: 'https://media.example.com/safe-tiny.gif', dims: [50, 25] },
          },
        },
        {
          id: 'unsafe',
          title: 'Unsafe',
          media_formats: {
            gif: { url: 'javascript:alert(1)', dims: [100, 50] },
            tinygif: { url: 'javascript:alert(1)', dims: [50, 25] },
          },
        },
      ]),
    );

    const { container } = render(<GifPicker onSelect={onSelect} onClose={vi.fn()} />);

    expect(container.firstElementChild).toHaveClass(
      'w-[min(25rem,calc(100vw-1rem))]',
      'max-h-[min(28.75rem,calc(100dvh-1rem))]',
    );
    await user.click(await screen.findByRole('button', { name: 'Select GIF Safe' }));

    expect(onSelect).toHaveBeenCalledWith('https://media.example.com/safe.gif');
    expect(screen.queryByRole('button', { name: 'Select GIF Unsafe' })).toBeNull();
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it('does not render GIFs with invalid dimensions', async () => {
    trending.mockResolvedValue(
      tenorResponse([
        {
          id: 'zero-height',
          title: 'Zero Height',
          media_formats: {
            gif: { url: 'https://media.example.com/zero.gif', dims: [100, 0] },
          },
        },
      ]),
    );

    render(<GifPicker onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText('No GIFs found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select GIF Zero Height' })).toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    trending.mockResolvedValue(tenorResponse([]));
    render(<GifPicker onSelect={vi.fn()} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
