# S1 checkpoint: client credential crypto library

Package S1 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §3.2, §3.5, §3.6, §3.13 (pins) and §3.14,
plus the §1.6 password rules. Branch `feat/setup`. Client only; the one Rust-side
file is the vector fixture.

## 1. What landed

Everything is under `client/src/lib/credential/`.

| File | What it does |
|---|---|
| `vectors.reference.mjs` | Independent reference: node:crypto only (scrypt, HKDF, AES-256-GCM, Ed25519), no client code. Writes `vectors.json` and `crates/paracord-api/tests/fixtures/credential_vectors.json` (identical bytes); `--check` fails if either is stale. Also checks `bip39-wordlist.ts` against the canonical BIP39 SHA-256 |
| `vectors.json` | Derivation (3 cases: ASCII, NFKC-folded Unicode, the same with a combining accent → same keys), scrypt salt, master, `auth_key`, `wrap_key`; wrapped identity for a fixed IV with its AAD; register and reset proofs; a complete v2 register body (`register`); phrase ↔ key (identity, all-zero, all-ones, a word-103 case); trust words ↔ fingerprint (for S10); KDF accept/refuse cases |
| `errors.ts` | `CredentialError { code }` with codes `weak_kdf`, `heavy_kdf`, `downgrade`, `unwrap_failed`, `identity_mismatch`, `invalid`, `worker_failed`, `origin_mismatch`, and the spec's copy (§3.2, §3.13) |
| `encoding.ts` | Strict b64url (no padding, canonical) and lowercase hex |
| `kdfCore.ts` | Policy (`assertKdfPolicy`: floor 2^17/8/1, ceiling 2^20, N·r·p ≤ 2^23), `DEFAULT_KDF`, the worker message protocol, `handleKdfRequest` (zeroes the password it receives) |
| `kdf.worker.ts` | The module worker: one request, one answer |
| `derive.ts` | NFKC + UTF-8, salt hash, `deriveMaster` (fresh worker per call, **terminated in `finally`**, buffers transferred), HKDF in Web Crypto (`expandMaster`), `deriveCredentialKeys` → `{ authKey (b64url), wrapKey (non-extractable AES-GCM) }`, `createCredential(password)` → `NewCredential` + wrap key, `setKdfWorkerFactory` for tests. No main-thread scrypt: no `Worker` means a loud `worker_failed` |
| `wrap.ts` | `wrapIdentity` (random IV), `sealIdentityWithIv` (vectors only), `unwrapIdentity` (also checks the key derives the expected public key), AAD `paracord/identity/v2|<pk hex>` |
| `proofs.ts` | `PROOF_PURPOSE.{register,reset}`, `credentialProofMessage`, `signCredentialProof(sk, purpose, challenge, expectedOrigin)` (refuses a challenge for another origin) → `IdentityProof` |
| `keystoreV2.ts` | `AccountKeystoreV2` at `paracord:encrypted-identity:v2` (strict validation, Web Locks shared with v1), `keystoreFromBackup`, `unlockKeystoreV2` (offline), and §3.13 pins at `paracord:credential-pins:v1` (`recordCredentialPin`, `findCredentialPin` by user id or typed identifier, `checkCredentialParams`, `checkPinnedIdentity`, `forgetCredentialPin`) |
| `phrase.ts` | `phraseFromPrivateKey` (= `account.ts` `generateRecoveryPhrase`), `privateKeyFromPhrase` (no v1 keystore write; legacy XOR checksum accepted), `privateKeyFromPhraseFor(phrase, publicKey)` |
| `password.ts` | `score()` (prototype's meter), `assessNewPassword(pw, { username, displayName })` → score, missing bytes, too long, too easy, `acceptable`, help line; `isCommonPassword` / `loadCommonPasswords` (lazy `?raw` import, own chunk) |
| `common-passwords.txt` | 10,000 entries (see §3) |
| `testWorker.ts` | Test-only `InlineKdfWorker` (same handler, structured-clone boundary, records `terminate`) and a `navigator.locks` stub |
| `*.test.ts` | `vectors`, `derive`, `keystoreV2`, `password`, `kdf.timing` (node environment) |

### For the packages that use it

- **S2:** read `crates/paracord-api/tests/fixtures/credential_vectors.json`.
  `register` is a ready `CredentialRegister` minus username (credential + identity
  + proof) with the `origin` the proof signs; a test must put
  `register.identity.proof.{nonce,timestamp}` into the challenge store (or call
  the verifier directly with `proofs[].message`). `proofs[]` gives the exact
  message per purpose: `"<purpose>:" + nonce + ":" + timestamp + ":" + origin`.
  `wrap[0].wrapped_key_bytes` is 60. The client refuses N·r·p above 2^23 even
  though `within_policy` has no r/p ceiling, so the server should only ever
  hand out `17:8:1` (including the fake params).
- **S3:** sign-up = `createCredential` → `wrapIdentity` → `signCredentialProof(…, 'register', challenge, homeOrigin)`;
  sign-in = `findCredentialPin(origin, { identifier })` → `checkCredentialParams` →
  `deriveCredentialKeysFromWire` → login → `keystoreFromBackup` →
  `unlockKeystoreV2` (or `unwrapIdentity`) → `checkPinnedIdentity` →
  `writeKeystoreV2` + `recordCredentialPin`. `unwrap_failed` on a local unlock
  is the §3.5 cue to fetch params and compare epochs. "Start over" passes
  `{ replaceIdentity: true }`. The Node port for live-drive
  (`client/scripts/lib/credential-node.mjs`) can lift `derive()`/`wrap()` from
  `vectors.reference.mjs`.
- **S10:** `vectors.json` `trust_words` (3 fingerprints → 4 words and the
  `" · "` form) from the canonical list; test `trustWords.ts` against them.
- **S13:** the Account step uses `assessNewPassword` for the meter, the help
  line and the Continue rule.

## 2. Commands and results

| Check | Result |
|---|---|
| `node client/src/lib/credential/vectors.reference.mjs --check` | both copies match |
| Python `hashlib.scrypt` + HMAC-HKDF cross-check of `ascii` master and `auth_key` | match |
| BIP39 all-zero / all-ones phrase vectors | `abandon ×23 art` / `zoo ×23 vote`, the published BIP39 vectors |
| `npx vitest run src/lib/credential src/lib/account` | 7 files, 52 passed |
| `kdf.timing.test.ts` (node env, default params) | `scrypt N=2^17 r=8 p=1: 312 ms` (visible with `--reporter=default`) |
| Real module worker in headless Chromium (scratch Vite build of a harness importing `derive.ts`, `vite preview` on 4939, Playwright) | all three derivations match the vectors (308–331 ms each), unwrap matches, common check works; **4 workers created, 4 closed** (terminated). This run caught a bug the jsdom tests could not: zeroing the transferred (detached) password buffer throws in Chromium; fixed |
| Production chunking (same harness build) | `kdf.worker-*.js` 12 kB and `common-passwords-*.js` 118 kB (59 kB gzip) are separate chunks |
| `npm run typecheck` | ok |
| `npm run test:unit` | 4764 passed, 1 failed: `CallSheet.test.tsx › a short drag springs back` (the known full-suite timing flake S0 recorded; 6/6 alone) |
| `npm run lint` | 0 errors (233 warnings, none in S1 files) |
| `npm run test:tokens`, `npm run test:motion-lint` | pass |

## 3. Differences from the spec and why

1. **Common-password list content.** The spec asks for "the bundled 10k
   common-password list". Entries shorter than 10 bytes can never pass the
   minimum, so the list is the 10,000 most frequent passwords of **10 to 128**
   characters from SecLists `xato-net-10-million-passwords-1000000.txt` (MIT),
   lowercased, printable ASCII, frequency order. Matching is NFKC + lowercase,
   with and without whitespace. A list filtered this way blocks far more of
   what people actually try at this length.
2. **KDF ceiling also bounds r and p** (N·r·p ≤ 2^23, the cost of N = 2^20,
   r = 8, p = 1). Without it a server could pin a device's memory or CPU with
   a huge r or p; the contract's `within_policy` has no such bound. Above the
   ceiling the refusal reads "This server asked for password settings heavier
   than Paracord can run on this device." (the spec only words the floor).
3. **Lengths are UTF-8 bytes of the NFKC form** for the meter thresholds and
   the "{n} more characters" count, matching `length_unit: "utf8_bytes"`
   (identical to the prototype's `p.length` for ASCII). "1 more character" is
   singular.
4. **Pins** remember the strongest parameters seen and the identifiers typed
   (username, email), so the params check (§3.13) can run before the user id is
   known. An identifier moves to whichever account last signed in with it on
   that server.
5. **`phrase.ts`** is an addition: the v2 recover and v1-move flows need the
   phrase → key parse without `recoverFromPhrase`'s v1 keystore write.

## 4. Files outside the S1 row (smallest changes)

- **`client/src/lib/bip39-wordlist.ts`: word 103 restored to `artefact`.**
  The American English sweep (`e6f874b0`) had changed the BIP39 list to
  `artifact`. The list is a wire format (phrases, and S10's trust words); the
  reference script found it by checking the list's SHA-256 against the
  canonical file. Added `BIP39_WORD_ALIASES = { artifact: 'artefact' }` so
  phrases shown since that commit (≈1.2 % of phrases contain word 103) still
  parse.
- **`client/src/lib/account.ts`** (S3's file), one line: the legacy parser
  looks words up through `BIP39_WORD_ALIASES`. CRLF line endings kept.
- **This bug is on `main` and in released builds.** The orchestrator should
  port these two changes to `main` independently of this branch.

## 5. Commits

- `e0d20a82` test(credential): vectors, reference, server fixture, wordlist fix
  (landed early for S2).
- The library, tests and this checkpoint (next commit).

## 6. Left for later

- S3 wires the library into the flows, the desktop keychain "remembered
  unlock" (§3.5) and the "Ask for my password" behavior.
- S10 implements `trustWords.ts` against `vectors.json`.
- If the KDF policy ever changes, regenerate the vectors with the reference
  script and keep both copies identical (the Vitest suite and `--check`
  fail otherwise).
