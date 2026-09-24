import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { isAudioCover, TogetherCover } from './TogetherCover';

describe('TogetherCover', () => {
  it('shows the thumbnail when there is one', () => {
    const { container } = render(
      <TogetherCover item={{ source: 'attachment', content_type: 'video/webm', thumbnail: 'data:image/jpeg;base64,/9j/' }} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/');
  });

  it('otherwise draws a glyph, never letters', () => {
    const { container } = render(
      <TogetherCover item={{ source: 'url', content_type: 'audio/mpeg', thumbnail: null }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toBe('');
  });

  it('uses the music note for audio files and the film for everything else', () => {
    expect(isAudioCover({ source: 'url', content_type: 'audio/ogg', thumbnail: null })).toBe(true);
    expect(isAudioCover({ source: 'attachment', content_type: 'video/mp4', thumbnail: null })).toBe(false);
    expect(isAudioCover({ source: 'youtube', content_type: null, thumbnail: null })).toBe(false);
  });
});
