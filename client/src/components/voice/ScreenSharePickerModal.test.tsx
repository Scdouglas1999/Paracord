import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScreenShareSource } from '../../lib/media/mediaEngine';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';

const source = (over: Partial<ScreenShareSource> & Pick<ScreenShareSource, 'id' | 'title'>): ScreenShareSource => ({
  kind: 'window',
  appName: null,
  audioSupported: false,
  isSelf: false,
  requiresOsPicker: false,
  ...over,
});

function renderPicker(sources: ScreenShareSource[], onSelect = vi.fn()) {
  render(
    <ScreenSharePickerModal
      sources={sources}
      loading={false}
      error={null}
      onClose={vi.fn()}
      onRefresh={vi.fn()}
      onSelect={onSelect}
      loadThumbnail={vi.fn().mockResolvedValue(null)}
    />,
  );
  return onSelect;
}

describe('ScreenSharePickerModal', () => {
  it('does not render unsafe thumbnail URLs', async () => {
    render(
      <ScreenSharePickerModal
        sources={[
          {
            id: 'source-1',
            kind: 'window',
            title: 'Unsafe Window',
            appName: 'Unsafe App',
            audioSupported: false,
            isSelf: false,
            requiresOsPicker: false,
          },
        ]}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        loadThumbnail={vi.fn().mockResolvedValue('javascript:alert(1)')}
      />,
    );

    expect(await screen.findByText('Unsafe Window')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Preview unavailable')).toBeInTheDocument());
    expect(document.body.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it('chooses a tile with a check, then Share (the one cream button) starts it; nothing is shared by choosing', async () => {
    const user = userEvent.setup();
    const onSelect = renderPicker([
      source({ id: 'screen-1', kind: 'screen', title: 'Display 1' }),
      source({ id: 'win-1', title: 'Game Night - Lobby', appName: 'Steam', audioSupported: true }),
    ]);
    const share = screen.getByRole('button', { name: 'Share' });
    // Off until something is chosen.
    expect(share).toBeDisabled();
    expect(share.className).toContain('bg-accent-primary');
    const tiles = screen.getAllByRole('radio');
    expect(tiles.map((tile) => tile.getAttribute('aria-checked'))).toEqual(['false', 'false']);

    await user.click(screen.getByRole('radio', { name: /Game Night - Lobby/ }));
    expect(screen.getByRole('radio', { name: /Game Night - Lobby/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Game Night - Lobby/ })).toHaveClass('ix-hue-selected');
    expect(screen.getByRole('radio', { name: /Display 1/ })).toHaveAttribute('aria-checked', 'false');
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 'win-1' });
  });

  it('filters by kind and counts each', async () => {
    const user = userEvent.setup();
    renderPicker([
      source({ id: 'screen-1', kind: 'screen', title: 'Display 1' }),
      source({ id: 'win-1', title: 'Window one' }),
      source({ id: 'win-2', title: 'Window two' }),
    ]);
    expect(screen.getByRole('tab', { name: /All\s*3/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Windows\s*2/ }));
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: /Screens\s*1/ }));
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });

  it('warns about sharing the app’s own window in the danger ink, never a warning color', () => {
    renderPicker([source({ id: 'self', title: 'Paracord', isSelf: true })]);
    expect(screen.getByText('Paracord window')).toHaveClass('text-[var(--ix-danger-ink)]');
    expect(screen.getByText(/recursive mirror/)).toBeInTheDocument();
  });
});
