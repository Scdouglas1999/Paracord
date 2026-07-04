import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilePreview } from './FilePreview';

// FilePreview resolves attachment URLs asynchronously (blob URLs on desktop,
// absolute URLs on web). Return the input url verbatim so href/src assertions
// stay deterministic; the resolution logic has its own coverage in files.ts.
vi.mock('../../api/files', () => ({
  fileApi: {
    resolveAttachmentObjectUrl: vi.fn(async (url: string) => url),
  },
}));

describe('FilePreview image lightbox accessibility', () => {
  it('opens an accessible image preview dialog and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(
      <FilePreview
        url="https://example.test/image.png"
        filename="release-shot.png"
        mimeType="image/png"
        size={2048}
      />,
    );

    (await screen.findByRole('button', { name: 'Open image preview: release-shot.png' })).focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'Image preview: release-shot.png' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Close image preview' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Image preview: release-shot.png' })).not.toBeInTheDocument();
    });
  });

  it('blocks unsafe attachment links', () => {
    render(
      <FilePreview
        url="javascript:alert(1)"
        filename="unsafe.html"
        mimeType="text/html"
        size={128}
      />,
    );

    expect(screen.getByText('Attachment link blocked.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not render unsafe image MIME types as image previews', async () => {
    render(
      <FilePreview
        url="/api/v1/files/vector"
        filename="vector.svg"
        mimeType="image/svg+xml"
        size={128}
      />,
    );

    expect(await screen.findByRole('link')).toHaveAttribute('href', '/api/v1/files/vector');
    expect(screen.queryByRole('button', { name: 'Open image preview: vector.svg' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('vector.svg')).not.toBeInTheDocument();
  });
});
