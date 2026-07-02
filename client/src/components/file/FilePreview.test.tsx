import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FilePreview } from './FilePreview';

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

    screen.getByRole('button', { name: 'Open image preview: release-shot.png' }).focus();
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

  it('does not render unsafe image MIME types as image previews', () => {
    render(
      <FilePreview
        url="/api/v1/files/vector"
        filename="vector.svg"
        mimeType="image/svg+xml"
        size={128}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open image preview: vector.svg' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('vector.svg')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/v1/files/vector');
  });
});
