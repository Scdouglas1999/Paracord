import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * D8. The desktop shell's Content-Security-Policy allowed images from `https:`
 * but not `http:`, and that was the first thing anyone noticed about the
 * broken avatars: Paracord is self-hosted, a self-hosted server on a LAN is
 * routinely plain HTTP, and the webview's page origin is `tauri://localhost`,
 * so every avatar and custom emoji is a cross-origin load at the user's own
 * server. Adding `http:` did make the request leave the process.
 *
 * It is not the fix, and this file exists to stop anyone re-applying it. Even
 * with the scheme allowed, a bare webview image load cannot authenticate
 * (no header, no cookie) and cannot complete at all against a self-signed
 * certificate, which is the ordinary self-hosted case — the certificate pin
 * that makes such a server trustworthy lives in the native client, and the
 * webview's TLS stack has never heard of it. So these images are fetched over
 * the native bridge and handed to the page as `blob:`, and the policy can stay
 * exactly as tight as it was.
 */
const csp: string = (() => {
  const path = resolve(process.cwd(), 'src-tauri/tauri.conf.json');
  const conf = JSON.parse(readFileSync(path, 'utf-8')) as {
    app?: { security?: { csp?: string } };
  };
  const value = conf.app?.security?.csp;
  if (!value) throw new Error('tauri.conf.json has no app.security.csp');
  return value;
})();

function directive(name: string): string[] {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) throw new Error(`CSP has no ${name} directive`);
  return found.split(/\s+/).slice(1);
}

describe('desktop Content-Security-Policy', () => {
  it('admits authenticated images as blobs, not as server origins', () => {
    const imgSrc = directive('img-src');
    // Bundled assets, inline icons, and everything the native bridge resolves
    // — avatars, custom emoji, stickers, attachment previews.
    expect(imgSrc).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
    // `https:` is for the open web: link-preview and embed artwork, GIF
    // search results. Nothing Paracord authenticates is loaded this way.
    expect(imgSrc).toContain('https:');
    // If this ever comes back, something has started asking the webview to
    // fetch a server resource again — which cannot work on a self-signed
    // deployment no matter what the policy says.
    expect(imgSrc).not.toContain('http:');
  });

  it('keeps the shell itself locked down', () => {
    expect(directive('default-src')).toEqual(["'self'"]);
    // Watch together plays YouTube through its IFrame Player API: the loader
    // script and the widget script it pulls in are both served from
    // www.youtube.com. Nothing else may run.
    expect(directive('script-src')).toEqual(["'self'", 'https://www.youtube.com']);
    // …and the player frame comes from youtube-nocookie.com only.
    expect(directive('frame-src')).toEqual(["'self'", 'https://www.youtube-nocookie.com']);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
    expect(directive('form-action')).toEqual(["'none'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    // Attachment media is fetched over IPC and handed to the page as a blob —
    // `<video src>` never points at a server origin. `https:` is for the open
    // web only, like `img-src`: a direct link to a video or song that Watch
    // together plays on each device. Nothing Paracord authenticates loads so.
    expect(directive('media-src')).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(directive('media-src')).not.toContain('http:');
    // Every HTTP request the desktop makes crosses the native bridge; the
    // webview itself talks to nothing but IPC and the voice websocket.
    expect(directive('connect-src')).not.toContain('http:');
    expect(directive('connect-src')).not.toContain('https:');
  });
});
