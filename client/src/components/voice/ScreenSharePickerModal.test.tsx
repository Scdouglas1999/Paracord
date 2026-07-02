import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';

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
});
