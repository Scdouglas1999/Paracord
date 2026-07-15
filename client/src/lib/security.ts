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

const HEX_DIGIT_RE = /[0-9a-fA-F]/;

// Canonicalize CSS escape sequences the same way the browser tokenizer does,
// so escaped spellings such as `\75rl(` (\75 = 'u') or `@\69mport` normalize to
// their literal form (`url(`, `@import`) before pattern matching. Without this,
// the substring/regex guards below match only the literal ASCII spelling and are
// trivially bypassed with hex/character escapes.
function decodeCssEscapes(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      result += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break; // trailing backslash
    if (HEX_DIGIT_RE.test(next)) {
      let hex = '';
      let j = i + 1;
      while (j < value.length && hex.length < 6 && HEX_DIGIT_RE.test(value[j])) {
        hex += value[j];
        j++;
      }
      // A single trailing whitespace is consumed as part of the escape.
      if (j < value.length && /\s/.test(value[j])) j++;
      const cp = parseInt(hex, 16);
      result +=
        !Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
          ? '�'
          : String.fromCodePoint(cp);
      i = j - 1;
    } else if (next === '\n' || next === '\r' || next === '\f') {
      i += 1; // line continuation: drop backslash + newline
    } else {
      result += next; // literal escape: the character stands for itself
      i += 1;
    }
  }
  return result;
}

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
    // Match blocked patterns against both the raw value and its escape-decoded
    // form so escaped spellings (e.g. `\75rl(`) cannot smuggle url()/etc.
    const decodedValue = decodeCssEscapes(value);
    if (
      BLOCKED_VALUE_PATTERNS.some(
        (pattern) => pattern.test(value) || pattern.test(decodedValue),
      )
    )
      continue;
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
  if (!value) return null;
  if (value.startsWith('data:')) {
    return isSafeImageDataUrl(value) ? value : null;
  }
  // Uploaded avatars/icons are stored as API paths (e.g. /api/v1/users/{id}/avatar).
  return safeClientResourceUrl(value);
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
