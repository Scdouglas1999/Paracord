import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPreview } from './MediaPreview';

describe('local attachment captions', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:captions');
      static revokeObjectURL = vi.fn();
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function selectCaptions(text: string) {
    const file = new File([text], 'captions.vtt', { type: 'text/vtt' });
    Object.defineProperty(file, 'text', { value: async () => text });
    fireEvent.change(screen.getByLabelText('Load captions (.vtt)'), { target: { files: [file] } });
  }

  it('attaches valid captions and releases their object URL when removed', async () => {
    const { container } = render(<MediaPreview src="blob:video" filename="video.mp4" kind="video" />);
    selectCaptions('WEBVTT\n\n00:00.000 --> 00:02.000\nHello');
    await screen.findByText('captions.vtt · local only');
    expect(container.querySelector('track')).toHaveAttribute('src', 'blob:captions');
    fireEvent.click(screen.getByRole('button', { name: 'Remove captions' }));
    expect(container.querySelector('track')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:captions');
  });

  it('rejects a mislabeled caption file without creating a resource URL', async () => {
    render(<MediaPreview src="blob:video" filename="video.mp4" kind="video" />);
    selectCaptions('<html>Not a caption file</html>');
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a WebVTT');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not allocate a resource after the preview unmounts while reading', async () => {
    let finish!: (text: string) => void;
    const file = new File([], 'captions.vtt');
    Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { finish = resolve; }) });
    const { unmount } = render(<MediaPreview src="blob:video" filename="video.mp4" kind="video" />);
    fireEvent.change(screen.getByLabelText('Load captions (.vtt)'), { target: { files: [file] } });
    unmount();
    finish('WEBVTT\n');
    await waitFor(() => expect(URL.createObjectURL).not.toHaveBeenCalled());
  });
});
