// A short video for "Jeremy posted a clip": two seconds of a drifting amber dot,
// recorded in the page from a canvas (MediaRecorder, VP8 WebM). Real bytes
// through the real attachment upload; nothing is stubbed.

import { launchBrowser } from '../scene-lib/ui.mjs';

export async function makeClip() {
  const browser = await launchBrowser();
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><body></body>');
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start(100);
      const started = performance.now();
      await new Promise(resolve => {
        const draw = () => {
          const t = (performance.now() - started) / 1000;
          ctx.fillStyle = '#1a1f26';
          ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = '#ffb766';
          ctx.beginPath();
          ctx.arc(320 + Math.sin(t * 3) * 180, 180 + Math.cos(t * 2) * 60, 28, 0, 7);
          ctx.fill();
          if (t < 2) requestAnimationFrame(draw); else resolve();
        };
        draw();
      });
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    return Buffer.from(base64, 'base64');
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Upload bytes as a pending attachment of a channel; resolves to its id. */
export async function uploadAttachment(api, token, channelId, filename, bytes, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const body = await api.request(token, 'POST', `/channels/${channelId}/attachments`, form);
  return String(body.id);
}
