import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPreview } from '../../../components/file/MediaPreview';
import { ClipAttachment, isClipAttachment } from './ClipAttachment';
import { clipFilename, formatClipDuration, parseClipFilename, screenSourceName } from './clipFilename';

const resolveAttachmentObjectUrl = vi.hoisted(() => vi.fn(async () => 'blob:resolved'));
vi.mock('../../../api/files', () => ({ fileApi: { resolveAttachmentObjectUrl } }));

describe('clip file names', () => {
  it('name the clip by its length and source, and read back', () => {
    const name = clipFilename(30_400, screenSourceName('Vincent'), 'webm');
    expect(name).toBe("Clip 0m30s from Vincent's screen.webm");
    expect(parseClipFilename(name)).toEqual({ seconds: 30, source: "Vincent's screen", label: "0:30 from Vincent's screen" });
    expect(parseClipFilename(clipFilename(65_000, "Chris' screen", 'mp4'))?.label).toBe("1:05 from Chris' screen");
    expect(screenSourceName('Chris')).toBe("Chris' screen");
  });

  it('keep a name that is safe on every system', () => {
    expect(clipFilename(30_000, 'a/b:c*?"<>|\u0007 screen', 'webm')).toBe('Clip 0m30s from abc screen.webm');
  });

  it('do not take an ordinary video for a clip', () => {
    expect(parseClipFilename('holiday.webm')).toBeNull();
    expect(parseClipFilename("Clip 0m30s from Vincent's screen.mov")).toBeNull();
    expect(isClipAttachment("Clip 0m30s from Vincent's screen.mp4")).toBe(true);
    expect(formatClipDuration(9)).toBe('0:09');
  });
});

describe('the clip bubble (MediaPreview)', () => {
  beforeEach(() => {
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  });

  it('shows a play button and "0:30 from Vincent\'s screen" until it plays', async () => {
    render(<MediaPreview src="blob:clip" filename="Clip 0m30s from Vincent's screen.webm" kind="video" />);
    const video = document.querySelector('video')!;
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).not.toHaveAttribute('controls');
    expect(screen.getByText("0:30 from Vincent's screen")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Play clip, 0:30 from Vincent's screen" }));
    });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(video).toHaveAttribute('controls');
    expect(screen.queryByText("0:30 from Vincent's screen")).toBeNull();
    fireEvent.ended(video);
    expect(screen.getByRole('button', { name: /Play clip/ })).toBeInTheDocument();
  });

  it('leaves other videos, and the lightbox, to the ordinary player', () => {
    const { unmount } = render(<MediaPreview src="blob:x" filename="holiday.webm" kind="video" />);
    expect(screen.queryByRole('button', { name: /Play clip/ })).toBeNull();
    unmount();
    render(<MediaPreview src="blob:x" filename="Clip 0m30s from Vincent's screen.webm" kind="video" autoPlay videoStyle={{ maxWidth: '88vw' }} />);
    expect(screen.queryByRole('button', { name: /Play clip/ })).toBeNull();
    expect(document.querySelector('video')).toHaveAttribute('controls');
  });
});

describe('ClipAttachment (a clip in a message row)', () => {
  it('fetches the attachment like any other and shows it as a clip', async () => {
    render(<ClipAttachment url="/api/v1/attachments/9" filename="Clip 0m30s from Vincent's screen.webm" />);
    expect(screen.getByLabelText("Loading clip, 0:30 from Vincent's screen")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: "Play clip, 0:30 from Vincent's screen" })).toBeInTheDocument();
    expect(resolveAttachmentObjectUrl).toHaveBeenCalledWith('/api/v1/attachments/9');
    expect(document.querySelector('video')).toHaveAttribute('src', 'blob:resolved');
  });

  it('says so when the clip cannot be fetched', async () => {
    resolveAttachmentObjectUrl.mockRejectedValueOnce(new Error('Not found'));
    render(<ClipAttachment url="/api/v1/attachments/9" filename="Clip 0m30s from Vincent's screen.webm" />);
    expect(await screen.findByRole('alert')).toHaveTextContent("0:30 from Vincent's screen: Not found");
  });
});
