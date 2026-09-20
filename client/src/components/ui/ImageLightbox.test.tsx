import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createResolvedLightboxImage, useLightboxStore } from '../../stores/lightboxStore';
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
});
