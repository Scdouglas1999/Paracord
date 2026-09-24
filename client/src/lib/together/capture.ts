/**
 * A still frame of a video, taken on the device of the person adding it.
 *
 * Attachments have no server-side preview, so the adder's client draws the
 * frame at one second (or halfway through a shorter clip) into a small JPEG
 * that travels with the queue item. It must stay small: it rides along in
 * every session update (the server refuses anything over 16 KiB).
 */

const WIDTH = 256;
const MAX_CHARS = 16 * 1024;
const TIMEOUT_MS = 15_000;

function once(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), TIMEOUT_MS);
    target.addEventListener(event, () => { window.clearTimeout(timer); resolve(); }, { once: true });
    target.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('the video could not be read')); }, { once: true });
  });
}

/**
 * Capture a still from `src` (a same-origin or blob URL). Resolves to a
 * `data:image/jpeg;base64,…` URL, or null when the frame cannot be read; the
 * item then shows the plain film tile.
 */
export async function captureVideoStill(src: string): Promise<string | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = src;
  try {
    await once(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 2;
    video.currentTime = Math.min(1, duration / 2);
    await once(video, 'seeked');
    if (!video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = Math.max(1, Math.round((WIDTH * video.videoHeight) / video.videoWidth));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.72, 0.6, 0.45, 0.3]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.startsWith('data:image/jpeg') && data.length <= MAX_CHARS) return data;
    }
    return null;
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
