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

// Kept as a second layer behind the value allowlist below. The allowlist is
// what actually decides; these patterns are a cheap, explicit backstop for the
// classic vectors so a future refactor of the tokenizer cannot silently
// re-open them.
const BLOCKED_VALUE_PATTERNS = [
  /url\s*\(/i,
  /expression\s*\(/i,
  /javascript:/i,
  /behavior\s*:/i,
  /-moz-binding/i,
];

/**
 * The only functions a custom-theme value may use.
 *
 * This is an allowlist, not a denylist, because denylisting CSS functions does
 * not work: blocking `url(` still left `image-set("https://evil.tld/x" 1x)`,
 * `-moz-element()` and `-webkit-cross-fade()`, all of which fetch. Combined
 * with attribute-selector prefix matching that is a character-at-a-time
 * exfiltration channel — and since `custom_css` comes from the active server
 * and is injected as one global <style>, a hostile server could read the UI of
 * every other server this client is connected to.
 *
 * Everything here is a computation over colours/numbers. No CSS `<image>`
 * function is included (not even gradients, which are safe today but sit in the
 * grammar slot where the fetching ones live).
 */
const ALLOWED_CSS_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'var',
  'calc',
  'min',
  'max',
  'clamp',
  'cubic-bezier',
  'steps',
]);

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}/;
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)/;
const UNIT_RE = /^(?:%|[a-zA-Z]+)/;
const IDENT_RE = /^-{0,2}[a-zA-Z_][a-zA-Z0-9_-]*/;
const IMPORTANT_RE = /^!\s*important\s*$/i;

/**
 * Allowlist validation of a declaration value.
 *
 * A value may only be built from: whitespace and separators, hex colours,
 * numbers with a unit, quoted strings, bare keywords, and calls to the
 * functions in {@link ALLOWED_CSS_FUNCTIONS}. Anything else — a colon (which is
 * what `javascript:` needs), an at-sign, a brace, an unknown function name — is
 * rejected outright.
 *
 * Backslashes are rejected before tokenizing: CSS escapes exist here only to
 * disguise a spelling the browser will re-assemble (`\75rl(` → `url(`), and no
 * legitimate theme value in the allowed property set needs one.
 */
function isAllowedCssValue(value: string): boolean {
  if (value.includes('\\')) return false;

  let i = 0;
  let depth = 0;
  while (i < value.length) {
    const ch = value[i];
    const rest = value.slice(i);

    if (/\s/.test(ch) || ch === ',' || ch === '/' || ch === '*' || ch === '+') {
      i += 1;
      continue;
    }

    if (ch === ')') {
      if (depth === 0) return false;
      depth -= 1;
      i += 1;
      continue;
    }

    if (ch === '#') {
      const match = HEX_COLOR_RE.exec(rest);
      if (!match) return false;
      const digits = match[0].length - 1;
      if (digits !== 3 && digits !== 4 && digits !== 6 && digits !== 8) return false;
      i += match[0].length;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = value.indexOf(ch, i + 1);
      if (end === -1) return false;
      if (/[\n\r]/.test(value.slice(i + 1, end))) return false;
      i = end + 1;
      continue;
    }

    const startsNumber =
      /[0-9.]/.test(ch) || ((ch === '-' || ch === '+') && /[0-9.]/.test(value[i + 1] ?? ''));
    if (startsNumber) {
      const match = NUMBER_RE.exec(rest);
      if (!match) return false;
      i += match[0].length;
      const unit = UNIT_RE.exec(value.slice(i));
      if (unit) i += unit[0].length;
      continue;
    }

    const startsIdent = /[a-zA-Z_]/.test(ch) || (ch === '-' && /[a-zA-Z_-]/.test(value[i + 1] ?? ''));
    if (startsIdent) {
      const match = IDENT_RE.exec(rest);
      if (!match) return false;
      i += match[0].length;
      if (value[i] === '(') {
        if (!ALLOWED_CSS_FUNCTIONS.has(match[0].toLowerCase())) return false;
        depth += 1;
        i += 1;
      }
      continue;
    }

    // A lone `-` is an operator inside calc()/clamp().
    if (ch === '-') {
      i += 1;
      continue;
    }

    if (ch === '!') {
      const match = IMPORTANT_RE.exec(rest);
      if (!match) return false;
      i += match[0].length;
      continue;
    }

    return false;
  }

  return depth === 0;
}

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
    // Custom properties are held to the same standard as real properties: a
    // `--x` value can be substituted into an allowed property with var().
    //
    // Match against both the raw value and its escape-decoded form so escaped
    // spellings (e.g. `\75rl(`) cannot smuggle url()/etc.
    const decodedValue = decodeCssEscapes(value);
    if (
      BLOCKED_VALUE_PATTERNS.some(
        (pattern) => pattern.test(value) || pattern.test(decodedValue),
      )
    )
      continue;
    if (!isAllowedCssValue(value) || !isAllowedCssValue(decodedValue)) continue;
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
