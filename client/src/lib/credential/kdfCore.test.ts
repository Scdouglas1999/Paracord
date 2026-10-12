import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertKdfPolicy,
  DEFAULT_KDF,
  SCRYPT_MAX_LOG_N,
  SCRYPT_MAX_WORK,
  SCRYPT_MIN_LOG_N,
  SCRYPT_MIN_P,
  SCRYPT_MIN_R,
} from './kdfCore';

// The KDF policy has one definition, in `paracord-contracts`
// (`KdfParams::within_policy`). The client keeps a mirror so it can refuse
// with its own words before spawning a worker; this pins the mirror to it.
const CONTRACT = resolve(__dirname, '../../../../crates/paracord-contracts/src/credential.rs');

function rustConst(source: string, name: string): number {
  const match = source.match(new RegExp(`pub const ${name}: \\w+ = ([^;]+);`));
  if (!match) throw new Error(`${name} is not in ${CONTRACT}`);
  const expr = match[1].trim();
  const shift = expr.match(/^1 << (\d+)$/);
  if (shift) return 2 ** Number(shift[1]);
  if (/^\d+$/.test(expr)) return Number(expr);
  throw new Error(`${name} = ${expr} is not a literal this test reads`);
}

describe('KDF policy mirror', () => {
  it('pins the floor 2^17/8/1, the ceiling 2^20 and N·r·p ≤ 2^23', () => {
    expect(SCRYPT_MIN_LOG_N).toBe(17);
    expect(SCRYPT_MIN_R).toBe(8);
    expect(SCRYPT_MIN_P).toBe(1);
    expect(SCRYPT_MAX_LOG_N).toBe(20);
    expect(SCRYPT_MAX_WORK).toBe(2 ** 23);
    expect(DEFAULT_KDF).toEqual({ alg: 'scrypt', log_n: 17, r: 8, p: 1 });
  });

  it('uses the same numbers as paracord-contracts', () => {
    const source = readFileSync(CONTRACT, 'utf8');
    expect(rustConst(source, 'SCRYPT_MIN_LOG_N')).toBe(SCRYPT_MIN_LOG_N);
    expect(rustConst(source, 'SCRYPT_MAX_LOG_N')).toBe(SCRYPT_MAX_LOG_N);
    expect(rustConst(source, 'SCRYPT_R')).toBe(SCRYPT_MIN_R);
    expect(rustConst(source, 'SCRYPT_P')).toBe(SCRYPT_MIN_P);
    expect(rustConst(source, 'SCRYPT_MAX_WORK')).toBe(SCRYPT_MAX_WORK);
  });

  it('refuses at the same edges as within_policy', () => {
    const kdf = (log_n: number, r: number, p: number) => ({ alg: 'scrypt', log_n, r, p });
    expect(() => assertKdfPolicy(kdf(17, 8, 1))).not.toThrow();
    expect(() => assertKdfPolicy(kdf(20, 8, 1))).not.toThrow();
    expect(() => assertKdfPolicy(kdf(17, 64, 1))).not.toThrow();
    expect(() => assertKdfPolicy(kdf(16, 8, 1))).toThrow(expect.objectContaining({ code: 'weak_kdf' }));
    expect(() => assertKdfPolicy(kdf(17, 7, 1))).toThrow(expect.objectContaining({ code: 'weak_kdf' }));
    expect(() => assertKdfPolicy(kdf(21, 8, 1))).toThrow(expect.objectContaining({ code: 'heavy_kdf' }));
    expect(() => assertKdfPolicy(kdf(17, 64, 2))).toThrow(expect.objectContaining({ code: 'heavy_kdf' }));
    expect(() => assertKdfPolicy(kdf(20, 16, 1))).toThrow(expect.objectContaining({ code: 'heavy_kdf' }));
  });
});
