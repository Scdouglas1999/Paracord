# S3 checkpoint: client account flows on one password

Package S3 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §1.12 (sign-in), §3.3, §3.5, §3.7–§3.9,
§3.11–§3.13 on the client. Branch `feat/setup`. Built on S1's library
(`lib/credential/`) and S2's routes.

## 1. What landed

### The flows (`client/src/lib/oneCredential.ts`, new)

One module owns every one-password flow against the **home** server (the
`LOCAL_SERVER_ID` client, `resolveApiBaseUrl()`); it installs the session in
`authStore` and the unlocked identity in `accountStore`. Every refusal throws a
sentence for the person (`credentialErrorMessage(err, fallback)` turns any
failure into one).

| Function | Spec | What it does |
|---|---|---|
| `detectCredentialMode()` / `useCredentialMode(enabled?)` | §3.12 | `/auth/options` `credential_version === 2` → `'one-password'`, else `'legacy'` and `markMissing(LOCAL, 'oneCredential')`. Decided before anyone types |
| `signUpWithPassword({ username, password, displayName?, email?, inviteCode? })` | §3.3 | identity → credential (worker KDF) → wrap → `/auth/challenge` → `register` proof → `/auth/credential/register` → session, v2 keystore at epoch 1, pin, unlock, remembered unlock, `withExplicitActivityOff` recorded. Returns `{ user, phrase, privacyDefaultsError }` |
| `prepareNewIdentity(password, { purpose?, privateKey? })` + `adoptNewAccount(prepared, session, identifiers)` | §3.3, §2.11 | the two halves of sign-up, for **S13's credential claim**: prepare → `POST /setup/credential-claim` (or `host_claim`) with `prepared.credential`/`prepared.identity` → `adoptNewAccount(prepared, { token, refresh_token, user })` → `{ user, phrase }` |
| `confirmRecoverySaved()` | §1.8 | `POST /users/@me/key-backup/recovery-confirmed` |
| `signInWithPassword(identifier, password)` → `signed-in` (`recoveryConfirmed`) \| `mfa` (`completeMfaSignIn(pending, code)`) \| `legacy` | §3.3, §3.13 | pin by identifier → params → `checkCredentialParams` (downgrade refused, nothing sent) → derive → `/auth/credential/login` → `GET key-backup` → pin check → `keystoreFromBackup` → unwrap → keystore + pin + unlock + remember. A refused backup ends the session it opened |
| `legacySignIn` / `completeLegacyMfa` | §3.11 | only from the distinct two-password screen; refused for a pinned identifier; keeps the legacy password in memory for `/setup` |
| `moveToOnePassword({ legacyPassword, newPassword, source: device \| phrase \| new })` | §3.11 | refuses a new password equal to the legacy one; `register` proof; `POST /auth/credential/upgrade`; keystore at the returned epoch; deletes the v1 keystore when it was the source; returns the phrase for `new` |
| `unlockWithPassword(password)` | §3.5 | offline unwrap first; on `unwrap_failed` asks params: newer epoch → full sign-in with the typed password and the keystore is replaced; a signed-in device with no keystore unwraps the server backup. Returns `recoveryConfirmed` so the phrase is re-shown |
| `changeOnePassword({ currentPassword, newPassword, mfaCode? })` | §3.7 | `PUT /users/@me/credential`, same identity re-wrapped, keystore + pin updated |
| `recoverWithPhrase(phrase, username)` → `setPasswordAfterRecovery(recovered, newPassword, mfaCode?)` | §3.8 | key sign-in (`/auth/challenge` + `/auth/verify`, MFA via `completeRecoverMfa`), then `POST /users/@me/credential/reset` with a `reset` proof. A v1/key-only account (`credential_legacy`/`credential_key_only`) keeps the device-keystore recovery |
| `startOver({ token, identifier, newPassword })` | §3.9 | new identity, `reset` proof signed by the **new** key (S2), `/auth/reset-password`; then signs in and moves this device's pin to exactly that key (`replaceIdentityWith`). `credential_legacy` → today's reset |
| `revealRecoveryPhrase(password)` | §3.6 | Settings › Identity: the password again, words in memory only |
| `applyRememberPolicy`, `applyAskForPassword(ask)` | §3.5 | below |
| `newPasswordProblem(password, names)` | §1.6 | S1's `assessNewPassword` as one sentence or `null` |
| `signedInAccountIsLegacy()`, `deferMove()`, `moveDeferred()` | §3.11 | a v1 account already signed in before this version is sent to `/setup` once per session ("Not now" defers to the next session) |

### Desktop remembered unlock (`client/src/lib/rememberedUnlock.ts`, new)

After every unlock the key goes into the OS keychain via `secure_store_set`
under `paracord:identity:<homeOrigin>:<userId>` — **directly**, not through
`secureStorage.ts` (which has encrypted-file and memory fallbacks; rule 0). A
keychain refusal is not papered over: the key is not remembered and Settings ›
Privacy shows "This computer's keychain isn't available, so Paracord will ask
for your password when it opens." A recalled entry must derive the keystore's
public key or it is deleted. `accountStore.restoreRemembered()` runs from
`ProtectedRoute` at launch (splash "Opening your account..." meanwhile).
"Ask for my password when Paracord opens" = the account's `crypto_auth_enabled`
(default off): on deletes the entry (also when the setting arrives from another
device), off remembers the unlocked key. The web never remembers; the switch is
shown on and disabled there with "In a browser, Paracord always asks for your
password when a tab opens." Sign-out removes the v2 keystore and the keychain
entry (pins stay, §3.13).

### Pages and guards

- **`ProtectedRoute` (App.tsx L115-216 region):** a device holding a v2
  keystore always needs the identity unlocked (desktop: keychain first). The
  intended `/app…` path is kept in `accountStore.unlockReturnTo` and `/unlock`
  returns there. Signed-in v1 accounts are sent to `/setup` (once per session).
- **`/login`:** one-password sign-in, MFA, the distinct v1 screen ("This account
  still uses two passwords"), the phrase screen when `recovery_confirmed` is
  false, "Forgot your password? Use your recovery phrase", and the token reset
  view becomes **Start over** with the spec's warning. On an older server the
  legacy page runs unchanged, except a pinned identifier is refused (§3.13).
- **`/register`:** one-password sign-up (S1 password rules, no composition
  rules), then the phrase; legacy registration on older servers.
- **`/unlock`:** one-password unlock (offline, newer-epoch online path,
  backup-only device), MFA field when the online path needs it, phrase re-show,
  "Use your recovery phrase", "Sign out".
- **`/recover`:** phrase → key sign-in → new password for every device; legacy
  recovery on older servers.
- **`/setup`:** rebuilt as "Paracord now uses one password" (§3.11) with the
  three cases (identity on this device with "Use my encryption password as my
  only password"; identity elsewhere → phrase or "Finish on the device that has
  your keys"; no identity → new password, then the phrase). `?migrate=1` links
  and older servers keep the old device-identity page.
- **`RecoveryPhraseCard`** (`pages/RecoveryPhraseCard.tsx`, new): §1.8 for these
  pages (blurred until **Show words**, **Copy** through S11's
  `copySecretToClipboard` with the 60 s clear, the checkbox, confirm on the
  server). Save-as-file and Print are the first run's (S13).
- **Settings › Account:** password change on one password (with a two-factor
  field when MFA is on); **email change shows "Changing the email isn't
  available for one-password accounts yet. It needs a server update."** instead
  of the 401 (S2 open item); "This server runs an older Paracord, so it still
  uses two passwords." on older servers; the old "Device crypto security"
  section is gone (Privacy owns the switch); the legacy "Set up local identity"
  row stays only for accounts on older servers. **Settings › Privacy:** the
  switch's behavior above. **Settings › Identity:** "Show recovery phrase".
- **Composer:** the "Set up encryption" link is removed (§1.14).

## 2. For S13 (first run)

- Sign-up/join: point the app at the server first (`setStoredServerUrl`), then
  `signUpWithPassword(...)`; show `phrase`; `confirmRecoverySaved()` on the
  checkbox. Field errors come back as the server's message (username taken,
  invite used up) — map by text or HTTP 400.
- Host claim: `prepareNewIdentity(password)` → claim with
  `prepared.credential` / `prepared.identity` (+ name, hue, template) →
  `adoptNewAccount(prepared, claimResponse)` (needs `token`, `user`). The claim
  route's challenge comes from the same server (`/auth/challenge`).
- Sign-in step: `signInWithPassword` → handle `mfa` / `legacy` (route to
  `/login`'s legacy view or reproduce the distinct screen with `legacySignIn`,
  then `/setup`) / `signed-in` (`recoveryConfirmed === false` → phrase via
  `currentRecoveryPhrase()`).
- Refuse an older server with `detectCredentialMode()` → `'legacy'` and
  `olderServerReason('oneCredential', name)`.
- **Any page under `AuthRoute` must call
  `useAccountStore.getState().setAccountFlowActive(true)` while a flow is
  running and showing its phrase**, or the new session redirects it to `/app`
  mid-flow (this bit `/login` and `/register`; see §4).
- Privacy defaults are recorded inside `signUpWithPassword`; the claim path
  should call the same thing after `adoptNewAccount` (it is
  `updateSettings({ notifications: withExplicitActivityOff(...) })`).

## 3. Commands and results

| Check | Result |
|---|---|
| `npm run typecheck` | ok |
| `npm run test:unit` | 4823 passed after the MessageInput test update (2 failures before it were the retired link); `InvitePage.test.tsx` failed in one run on **S13's in-progress** `InvitePage.tsx` (a mock missing `registerAccountHistoryReset`), not S3's code |
| new: `lib/oneCredential.test.ts` (13) | against an in-memory server that verifies auth keys, proofs and purposes, with the real KDF (inline worker): sign-up sends no password, keystore + pin + activity off; second device gets the same identity; wrong password keeps nothing; pinned downgrade (`version: 1`, weaker KDF, legacy route) refused before anything is sent; swapped backup refused and session dropped; change keeps the identity and another device takes the newer-epoch path; offline unlock; v1 move (new identity, device identity, same-as-legacy refused); recover + reset; Start over moves the pin; phrase reveal; sign-out keeps the pin |
| new: `lib/rememberedUnlock.test.ts` (4), `App.guard.test.tsx` (+2), `serverSignIn.test.ts` (+1) | pass |
| `npm run lint` | 0 errors (243 warnings, none new of note) |
| `test:tokens`, `test:motion-lint`, `test:contrast` | pass |
| `test:a11y:static` | one failure in **S13's** `components/firstRun/HostInviteStep.tsx:84` (menu without a label); none in S3 files |
| `identity-setup.spec.ts` (+1 v2 keystore test, real worker) via `e2e/setup-review.config.ts` on 4943/4945 | 6 passed |
| `real-server.session-recovery` (`PARACORD_E2E_REAL=1`, ports 18212/18213/18214, app 4943) | 1 passed (registers v2 by API; the saved-server sign-in dialog now signs in with one password) |
| `node scripts/lib/credential-node.mjs` `selfCheck()` | derivation and phrase vectors match |
| **live** (release build, 127.0.0.1:18450, data `.live-env-s3`, at-rest off, port forwarding off): `PARACORD_LIVE_PORT=18450 PARACORD_LIVE_DATA=.live-env-s3 node client/scripts/live-drive.mjs` | **28/28 PASS**, including "password change keeps DMs readable", "sign in on a second browser context gets the identity from the backup", "v1 account moves to one password" (seeded via the database on the release build) |
| live-probe on the same instance | ada and bob sign in by password, bob's prekeys published, DM stored as e2ee v2, **recipient can read it: true** |

Screenshots (read): `/tmp/paracord-live-s3/` — `10-legacy-screen--vera.png`,
`11-move-screen--vera.png`, `07-password-changed--grace.png`,
`08-dm-after-change--grace.png`, `09-second-device--grace-2.png`,
`s3-register-too-easy.png`, `s3-register-phrase.png`, `s3-unlock.png`.
`.live-env-s3` was deleted afterwards.

## 4. Differences from the spec / plan, and files outside the S3 row

1. **`client/src/lib/serverSignIn.ts` (+test):** the in-app "Sign in again"
   dialog for a saved server sent the typed password to `/auth/login`, which a
   v2 account would both refuse (409) and leak its one password to (§3.13). It
   now asks params first: v2 → derive + `/auth/credential/login`; older server
   (404) → password login; a pinned identifier on a server offering v1 is
   refused. Remote servers still get no identity backup (home only, §3.3).
2. **`App.tsx` `AuthRoute` (L245-266, outside the S3 region):** holds its
   signed-in redirect while `accountStore.accountFlowActive` is set, so
   `/login`/`/register` can finish (backup fetch, phrase screen). Without it the
   phrase screen after sign-up never showed.
3. **`client/src/pages/RecoveryPhraseCard.tsx`, `lib/oneCredential.ts`,
   `lib/rememberedUnlock.ts`, `scripts/lib/credential-node.mjs`:** new files.
4. **v1 seeding on a release build.** The plan seeds the "v1 moves" step with
   `PARACORD_TEST_ALLOW_LEGACY_SIGNUP=1`, which only a debug build honors, yet
   live-drive must pass on a release build. live-drive tries the legacy route
   first and, on 410, makes a v2 account by API and rewrites it to its v1 shape
   in the instance's SQLite file (`PARACORD_LIVE_DATA`, default `.live-env`):
   `credential_version 1`, an Argon2id PHC hash of the legacy password
   (`@noble/hashes/argon2`, the server crate's default parameters), no salt,
   KDF, public key or backup. This needs an unencrypted database (at-rest off).
5. **Start over identifier.** The reset view asks for the username or email as
   well, so the device can sign in right after and move its pin to the new key.
6. **Start over / recover dispatch on `credential_legacy`.** On a one-password
   server the v2 body is sent first; a v1 account's 409 `credential_legacy`
   switches to the legacy request. This is the server naming the version, not
   a fallback after a failure, but it is the one place the choice follows a
   response.
7. **Desktop check not run.** Remembered unlock is covered by unit tests with a
   mocked `invoke`; no desktop build was driven (no keychain was touched).

## 5. Open issues

- **Email change / `attach-public-key` for v2 accounts** need an auth-key
  variant on the server (S2 open item); the client says so instead of 401ing.
- **Recovery on a key the server doesn't know:** `/auth/verify` auto-registers
  an unknown key, so a phrase that belongs to no account on that server makes a
  new key-only account (then `credential_key_only` on reset). The recover page
  could ask params for the username first; left as is.
- `crypto_auth_enabled` is an account setting, so "Ask for my password" applies
  to every desktop of the account; the spec puts it there. A per-device choice
  would need a local setting.
- S13 owns the first-run phrase screen's Save/Print and the §1.12 frame.
