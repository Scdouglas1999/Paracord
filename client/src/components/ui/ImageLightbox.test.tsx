import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLightboxStore } from '../../stores/lightboxStore';
import { ImageLightbox } from './ImageLightbox';

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
});
