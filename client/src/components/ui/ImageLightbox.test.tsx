import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferredLightboxImage, createResolvedLightboxImage, useLightboxStore } from '../../stores/lightboxStore';
import { ImageLightbox } from './ImageLightbox';
import { resetSessionStores } from '../../stores/sessionReset';

describe('ImageLightbox', () => {
  afterEach(() => {
    act(() => {
      useLightboxStore.getState().close();
    });
  });

  it('does not render unsafe image resource URLs', () => {
    render(<ImageLightbox />);

    act(() => {
      useLightboxStore.getState().open(
        [{ src: 'javascript:alert(1)', alt: 'Unsafe image', filename: 'unsafe.png' }],
        0,
      );
    });

    expect(screen.queryByRole('dialog', { name: 'Image viewer' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('Unsafe image')).not.toBeInTheDocument();
  });

  it('renders safe same-origin image resource URLs', () => {
    render(<ImageLightbox />);

    act(() => {
      useLightboxStore.getState().open(
        [{ src: '/api/v1/files/image-1', alt: 'Safe image', filename: 'safe.png' }],
        0,
      );
    });

    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeInTheDocument();
    expect(screen.getByAltText('Safe image')).toHaveAttribute('src', '/api/v1/files/image-1');
  });

  it('renders authenticated attachment object URLs while refusing untrusted blob strings', () => {
    const src = 'blob:http://localhost/verified-attachment';
    render(<ImageLightbox />);
    act(() => useLightboxStore.getState().open([{ src, filename: 'untrusted.png', alt: 'Untrusted' }], 0));
    expect(screen.queryByRole('dialog', { name: 'Image viewer' })).not.toBeInTheDocument();
    act(() => useLightboxStore.getState().open([createResolvedLightboxImage(src, 'verified.png')], 0));
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeInTheDocument();
    expect(screen.getByAltText('verified.png')).toHaveAttribute('src', src);
  });

  it('clears the image when the account signs out', async () => {
    act(() => useLightboxStore.getState().open([createResolvedLightboxImage('blob:http://localhost/private', 'private.png')], 0));
    await act(() => resetSessionStores());
    expect(useLightboxStore.getState()).toMatchObject({ isOpen: false, images: [] });
  });

  it('fetches a deferred entry only when the viewer reaches it', async () => {
    const first = vi.fn(async () => '/api/v1/attachments/1');
    const second = vi.fn(async () => '/api/v1/attachments/2');
    render(<ImageLightbox />);
    act(() => useLightboxStore.getState().open([
      createDeferredLightboxImage(first, 'one.png'),
      createDeferredLightboxImage(second, 'two.png'),
    ], 0));
    expect(await screen.findByAltText('one.png')).toHaveAttribute('src', '/api/v1/attachments/1');
    expect(second).not.toHaveBeenCalled();
    act(() => useLightboxStore.getState().next());
    expect(await screen.findByAltText('two.png')).toHaveAttribute('src', '/api/v1/attachments/2');
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('says so when a deferred entry cannot be loaded', async () => {
    render(<ImageLightbox />);
    act(() => useLightboxStore.getState().open([
      createDeferredLightboxImage(async () => { throw new Error('gone'); }, 'lost.png'),
    ], 0));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load lost.png'));
  });
});
