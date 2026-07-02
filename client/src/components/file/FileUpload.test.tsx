import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileUpload } from './FileUpload';

describe('FileUpload', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('exposes named upload and remove controls for staged files', async () => {
    const user = userEvent.setup();
    const onRemoveFile = vi.fn();
    const image = new File(['png'], 'release.png', { type: 'image/png' });

    render(
      <FileUpload
        onFilesSelected={vi.fn()}
        stagedFiles={[image]}
        onRemoveFile={onRemoveFile}
      />,
    );

    expect(screen.getByRole('button', { name: 'Select files to upload' })).toBeInTheDocument();
    expect(screen.getByAltText('release.png')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove release.png' }));

    expect(onRemoveFile).toHaveBeenCalledWith(0);
  });

  it('passes selected files through the hidden file input', async () => {
    const user = userEvent.setup();
    const onFilesSelected = vi.fn();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const { container } = render(
      <FileUpload
        onFilesSelected={onFilesSelected}
        stagedFiles={[]}
        onRemoveFile={vi.fn()}
      />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, file);

    expect(onFilesSelected).toHaveBeenCalledWith([file]);
    expect(input).toHaveValue('');
  });

  it('does not render unsafe image MIME types as image previews', () => {
    const svg = new File(['<svg></svg>'], 'vector.svg', { type: 'image/svg+xml' });

    render(
      <FileUpload
        onFilesSelected={vi.fn()}
        stagedFiles={[svg]}
        onRemoveFile={vi.fn()}
      />,
    );

    expect(screen.queryByAltText('vector.svg')).not.toBeInTheDocument();
    expect(screen.getByText('vector.svg')).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
