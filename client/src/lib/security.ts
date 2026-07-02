const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const MAX_EXTERNAL_URL_LENGTH = 2_000;
const MAX_CUSTOM_CSS_LENGTH = 10 * 1024;

const ALLOWED_CSS_PROPERTIES = new Set([
  'background',
  'background-color',
  'border',
  'border-color',
  'border-radius',
  'border-style',
  'border-width',
  'box-shadow',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'outline',
  'outline-color',
  'outline-offset',
  'outline-style',
  'outline-width',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-decoration',
  'text-transform',
  'transition',
]);

const BLOCKED_VALUE_PATTERNS = [
  /url\s*\(/i,
  /expression\s*\(/i,
  /javascript:/i,
  /behavior\s*:/i,
  /-moz-binding/i,
];

function sanitizeDeclarations(block: string): string {
  const safe: string[] = [];
  const declarations = block.split(';');
  for (const declaration of declarations) {
    const idx = declaration.indexOf(':');
    if (idx <= 0) continue;
    const prop = declaration.slice(0, idx).trim().toLowerCase();
    const value = declaration.slice(idx + 1).trim();
    if (!prop || !value) continue;
    if (!ALLOWED_CSS_PROPERTIES.has(prop) && !prop.startsWith('--')) continue;
    if (BLOCKED_VALUE_PATTERNS.some((pattern) => pattern.test(value))) continue;
    safe.push(`${prop}: ${value}`);
  }
  return safe.join('; ');
}

export function isAllowedImageMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    normalized === 'image/png' ||
    normalized === 'image/jpeg' ||
    normalized === 'image/jpg' ||
    normalized === 'image/gif' ||
    normalized === 'image/webp'
  );
}

export function isSafeImageDataUrl(value: string): boolean {
  return SAFE_IMAGE_DATA_URL_RE.test(value.trim());
}

export function safeStoredImageDataUrl(value: string | null | undefined): string | null {
  if (!value?.startsWith('data:')) return null;
  return isSafeImageDataUrl(value) ? value : null;
}

export function safeExternalUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LENGTH) return null;

  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return null;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function safeClientResourceUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LENGTH) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  return safeExternalUrl(trimmed);
}

export function sanitizeCustomCss(value: string): string {
  const source = value.trim();
  if (!source) return '';
  if (source.length > MAX_CUSTOM_CSS_LENGTH) {
    return '';
  }

  // Strip all at-rules to block @import/@font-face and similar fetch-based exfiltration vectors.
  const withoutAtRules = source.replace(/@[^{;]+(?:;|\{[^}]*\})/g, '');
  const sanitizedRules: string[] = [];
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(withoutAtRules)) !== null) {
    const selector = match[1].trim();
    if (!selector) continue;
    const declarations = sanitizeDeclarations(match[2]);
    if (!declarations) continue;
    sanitizedRules.push(`${selector} { ${declarations}; }`);
  }

  return sanitizedRules.join('\n').slice(0, MAX_CUSTOM_CSS_LENGTH);
}
