import { describe, it, expect } from 'vitest';
import {
  isAllowedImageMimeType,
  isSafeImageDataUrl,
  safeClientResourceUrl,
  safeExternalUrl,
  safeStoredImageDataUrl,
  sanitizeCustomCss,
} from './security';

describe('isSafeImageDataUrl', () => {
  it('accepts valid png data URL', () => {
    expect(isSafeImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('accepts valid jpeg data URL', () => {
    expect(isSafeImageDataUrl('data:image/jpeg;base64,/9j/4AAQ=')).toBe(true);
  });

  it('accepts valid gif data URL', () => {
    expect(isSafeImageDataUrl('data:image/gif;base64,R0lGODlh')).toBe(true);
  });

  it('accepts valid webp data URL', () => {
    expect(isSafeImageDataUrl('data:image/webp;base64,UklGR=')).toBe(true);
  });

  it('rejects SVG data URLs', () => {
    expect(isSafeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
  });

  it('rejects non-image data URLs', () => {
    expect(isSafeImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  it('rejects javascript URLs', () => {
    expect(isSafeImageDataUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeImageDataUrl('')).toBe(false);
  });

  it('trims whitespace', () => {
    expect(isSafeImageDataUrl('  data:image/png;base64,abc=  ')).toBe(true);
  });
});

describe('isAllowedImageMimeType', () => {
  it('accepts image/png', () => {
    expect(isAllowedImageMimeType('image/png')).toBe(true);
  });

  it('accepts image/jpeg', () => {
    expect(isAllowedImageMimeType('image/jpeg')).toBe(true);
  });

  it('accepts image/jpg', () => {
    expect(isAllowedImageMimeType('image/jpg')).toBe(true);
  });

  it('accepts image/gif', () => {
    expect(isAllowedImageMimeType('image/gif')).toBe(true);
  });

  it('accepts image/webp', () => {
    expect(isAllowedImageMimeType('image/webp')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowedImageMimeType('Image/PNG')).toBe(true);
  });

  it('rejects image/svg+xml', () => {
    expect(isAllowedImageMimeType('image/svg+xml')).toBe(false);
  });

  it('rejects text/html', () => {
    expect(isAllowedImageMimeType('text/html')).toBe(false);
  });
});

describe('safeStoredImageDataUrl', () => {
  it('returns safe stored raster image data URLs', () => {
    expect(safeStoredImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('rejects unsafe data URLs and unresolved legacy image hashes', () => {
    expect(safeStoredImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeStoredImageDataUrl('avatar-hash')).toBeNull();
    expect(safeStoredImageDataUrl(null)).toBeNull();
  });
});

describe('safeExternalUrl', () => {
  it('normalizes http and https URLs', () => {
    expect(safeExternalUrl(' https://example.com/path?q=1 ')).toBe('https://example.com/path?q=1');
    expect(safeExternalUrl('http://localhost:8090/callback')).toBe('http://localhost:8090/callback');
  });

  it('rejects scriptable and local-only URL forms', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeExternalUrl('/relative/path')).toBeNull();
  });

  it('rejects URLs with userinfo', () => {
    expect(safeExternalUrl('https://user:pass@example.com')).toBeNull();
  });
});

describe('safeClientResourceUrl', () => {
  it('allows same-origin paths and HTTP(S) URLs', () => {
    expect(safeClientResourceUrl('/api/v1/files/123')).toBe('/api/v1/files/123');
    expect(safeClientResourceUrl('https://cdn.example.com/file.png')).toBe('https://cdn.example.com/file.png');
  });

  it('rejects protocol-relative and scriptable resource URLs', () => {
    expect(safeClientResourceUrl('//evil.example/file.png')).toBeNull();
    expect(safeClientResourceUrl('blob:http://localhost/123')).toBeNull();
    expect(safeClientResourceUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('sanitizeCustomCss', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeCustomCss('')).toBe('');
    expect(sanitizeCustomCss('  ')).toBe('');
  });

  it('allows safe CSS properties', () => {
    const css = '.test { color: red; background-color: blue; }';
    const result = sanitizeCustomCss(css);
    expect(result).toContain('color: red');
    expect(result).toContain('background-color: blue');
  });

  it('allows CSS custom properties for theme overrides', () => {
    const css = ':root { --bg-primary: #1a1a2e; --text-primary: #ffffff; }';
    const result = sanitizeCustomCss(css);
    expect(result).toContain('--bg-primary: #1a1a2e');
    expect(result).toContain('--text-primary: #ffffff');
  });

  it('strips disallowed CSS properties', () => {
    const css = '.test { color: red; position: absolute; z-index: 999; }';
    const result = sanitizeCustomCss(css);
    expect(result).toContain('color: red');
    expect(result).not.toContain('position');
    expect(result).not.toContain('z-index');
  });

  it('blocks url() values', () => {
    const css = '.test { background: url(https://evil.com/track.gif); }';
    const result = sanitizeCustomCss(css);
    expect(result).not.toContain('url(');
  });

  it('blocks expression() values', () => {
    const css = '.test { color: expression(alert(1)); }';
    const result = sanitizeCustomCss(css);
    expect(result).not.toContain('expression');
  });

  it('blocks javascript: values', () => {
    const css = '.test { background: javascript:alert(1); }';
    const result = sanitizeCustomCss(css);
    expect(result).not.toContain('javascript:');
  });

  it('strips @import rules', () => {
    const css = '@import url("evil.css"); .test { color: red; }';
    const result = sanitizeCustomCss(css);
    expect(result).not.toContain('@import');
    expect(result).toContain('color: red');
  });

  it('returns empty string when exceeding max length', () => {
    const longCss = '.x{color:red;}'.repeat(1000);
    const result = sanitizeCustomCss(longCss);
    expect(result.length).toBeLessThanOrEqual(10240);
  });

  it('blocks -moz-binding values', () => {
    const css = '.test { color: -moz-binding(url(evil)); }';
    const result = sanitizeCustomCss(css);
    expect(result).not.toContain('-moz-binding');
  });

  it('blocks properties that can hide or disable security UI', () => {
    const css = `
      .auth-warning {
        display: none;
        visibility: hidden;
        opacity: 0;
        filter: blur(8px);
        color: red;
      }
    `;
    const result = sanitizeCustomCss(css);
    expect(result).toContain('color: red');
    expect(result).not.toContain('display');
    expect(result).not.toContain('visibility');
    expect(result).not.toContain('opacity');
    expect(result).not.toContain('filter');
  });

  it('blocks properties that can intercept, move, or mask app controls', () => {
    const css = `
      .security-action {
        color: red;
        pointer-events: none;
        transform: translateX(-9999px);
        clip-path: inset(100%);
        backdrop-filter: blur(24px);
        cursor: none;
      }
    `;
    const result = sanitizeCustomCss(css);
    expect(result).toContain('color: red');
    expect(result).not.toContain('pointer-events');
    expect(result).not.toContain('transform');
    expect(result).not.toContain('clip-path');
    expect(result).not.toContain('backdrop-filter');
    expect(result).not.toContain('cursor');
  });

  it('strips nested at-rule blocks before evaluating declarations', () => {
    const css = `
      @media screen {
        .security-action { color: transparent; }
      }
      @supports (display: grid) {
        .security-action { background: red; }
      }
      .security-action { color: red; }
    `;
    const result = sanitizeCustomCss(css);
    expect(result).not.toContain('@media');
    expect(result).not.toContain('@supports');
    expect(result).not.toContain('transparent');
    expect(result).toContain('color: red');
  });
});
