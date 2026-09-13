// Client mirror of validate_password in crates/paracord-util/src/validation.rs.
// The server measures UTF-8 byte length (10–128 bytes) and requires ASCII
// character classes only — Unicode lookalikes do not satisfy them.

const utf8 = new TextEncoder();

export const PASSWORD_MIN_BYTES = 10;
export const PASSWORD_MAX_BYTES = 128;

// Mirrors the server's `is_ascii_punctuation() || (is_ascii() && !is_alphanumeric())`:
// any ASCII character that is not A-Z, a-z, or 0-9 — spaces and control
// characters count, but no non-ASCII character does.
function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function hasAsciiNonAlphanumeric(password: string): boolean {
  for (const ch of password) {
    const code = ch.charCodeAt(0);
    if (code <= 0x7f && !isAsciiAlphanumeric(code)) return true;
  }
  return false;
}

export const PASSWORD_REQUIREMENTS_HINT = `${PASSWORD_MIN_BYTES}–${PASSWORD_MAX_BYTES} bytes (UTF-8 — non-ASCII characters count as multiple bytes), including an uppercase letter (A–Z), a lowercase letter (a–z), a digit (0–9), and an ASCII symbol (such as !) or space.`;

export function passwordByteLength(password: string): number {
  return utf8.encode(password).length;
}

export function registrationPasswordError(password: string): string | null {
  // TextEncoder replaces unpaired UTF-16 surrogates. JSON/Rust cannot accept
  // them as the same password, so report them instead of validating a changed
  // byte sequence. for...of keeps valid surrogate pairs together.
  for (const character of password) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      return 'Password contains an incomplete Unicode character. Remove it and try again.';
    }
  }
  const bytes = passwordByteLength(password);
  if (bytes < PASSWORD_MIN_BYTES) {
    return `Password must be at least ${PASSWORD_MIN_BYTES} bytes (UTF-8) — yours is ${bytes}.`;
  }
  if (bytes > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes (UTF-8) — yours is ${bytes}.`;
  }
  const missing: string[] = [];
  if (!/[A-Z]/.test(password)) missing.push('an uppercase letter (A–Z)');
  if (!/[a-z]/.test(password)) missing.push('a lowercase letter (a–z)');
  if (!/[0-9]/.test(password)) missing.push('a digit (0–9)');
  if (!hasAsciiNonAlphanumeric(password)) missing.push('a symbol or space');
  if (missing.length === 0) return null;
  return `Password must include ${formatList(missing)}.`;
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
